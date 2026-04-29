import { logger } from "../logger";
import { captureMessage } from "../sentry";

/**
 * Per-identity burst detector for the sensitive MFA rate limiters.
 *
 * Background. Task #68 added per-user hourly rate limits on the
 * mutating MFA routes (regenerate backup codes, disable, setup,
 * verify, backup-code consume) in `routes/mfa.ts`. Those limits give
 * the user a clean 429 once they breach the cap, but the existing
 * code path only writes a row into the `rate_limit_events` forensic
 * table — nothing reads from it in real time, so a burst from a
 * single identity (the canonical compromise pattern: a flood of
 * failed verify / backup-code attempts followed by a regenerate
 * storm) goes unnoticed by the trust & safety team until someone
 * happens to grep the audit table after the fact.
 *
 * This watcher closes the loop. Whenever the apiRateLimit middleware
 * 429s a request whose limiter `name` starts with `"mfa_"`, it pokes
 * `mfaAbuseWatcher.record(...)` with the offending identity. The
 * watcher keeps a per-identity sliding window of recent MFA 429
 * timestamps; once an identity racks up `>= threshold` 429s within
 * the window it emits a structured Sentry signal so on-call /
 * trust & safety can lock the account and contact the user. See
 * `docs/runbooks/mfa-rate-limit-alerts.md` for the recommended
 * response.
 *
 * Why Sentry (and not Slack / PagerDuty / a dashboard tile):
 *   - The codebase already pages on `subsystem=rate_limit` Sentry
 *     events (see `RedisFailureWatcher` in `apiRateLimit.ts`), so
 *     wiring through the same channel keeps the alert routing
 *     uniform — operators add one Sentry rule keyed off the
 *     `alert=mfa_rate_limit_burst` tag to fan out to Slack /
 *     PagerDuty if they want, instead of every subsystem inventing
 *     its own webhook plumbing.
 *   - `captureMessage` with `level: "warning"` fires Sentry's
 *     default new-issue notification on the very first event so we
 *     don't depend on a project-specific threshold rule existing.
 *   - The stable per-identity fingerprint groups every burst from
 *     the same identity into one Sentry issue, so a sustained
 *     compromise attempt doesn't spam on-call with N issues — they
 *     get one issue that re-opens / accumulates events.
 *
 * Configuration (read at construction time so a hot env-var rotation
 * needs a restart — same posture as `RedisFailureWatcher`):
 *   - `MFA_RATE_LIMIT_ALERT_THRESHOLD` (default 3)
 *       Number of MFA 429s within the window that triggers an alert
 *       for a single identity. The MFA routes themselves cap at
 *       5 / 10 / 20 per HOUR, so 3 within the (much shorter) burst
 *       window reliably means "user is hammering an MFA mutation
 *       past its hourly cap" — way beyond legitimate usage.
 *   - `MFA_RATE_LIMIT_ALERT_WINDOW_MS` (default 15 minutes)
 *       Sliding-window length. Short enough that an alert means
 *       "burst happening RIGHT NOW", not "happened sometime today".
 *   - `MFA_RATE_LIMIT_ALERT_COOLDOWN_MS` (default 30 minutes)
 *       Per-identity throttle so a sustained attack doesn't fire a
 *       fresh Sentry capture every additional 429. Sentry's stable
 *       fingerprint already deduplicates events into one issue, but
 *       the cooldown keeps the issue's event volume sane and avoids
 *       blowing through the project's event quota.
 *
 * Memory posture. Per-identity buckets are stored in a `Map`; we
 * prune empty buckets on every record() and a coarse periodic sweep
 * (driven by the boot caller via `startSweepTimer`) drops buckets
 * whose newest entry has aged out of the window. The cardinality is
 * bounded in practice — a bucket is only ever created on a 429,
 * which is itself rate-limited by the MFA route caps — so the worst
 * case is "one entry per attacker identity, evicted within the
 * window after they stop". An attacker can't blow up memory by
 * cycling identities because the global apiRateLimit caps anonymous
 * traffic before it reaches the MFA route layer.
 *
 * Pure module — exports a singleton plus a class so tests can
 * exercise threshold / cooldown / sweep transitions deterministically
 * by injecting their own clock and capture sink.
 */

interface MfaAbuseRecord {
  identity: string;
  /** The HTTP path that 429ed (e.g. "/api/me/mfa/verify"). */
  route: string;
  /** The limiter `name` from `apiRateLimit({ name })`. */
  name: string;
  /** Tier resolved by apiRateLimit ("anon" | "buyer" | "seller" | "admin"). */
  tier: string;
}

interface IdentityBucket {
  /** Sorted-ish ascending list of 429 timestamps within the window. */
  timestamps: number[];
  /** Last alert ms epoch; 0 until first alert. */
  lastAlertedAt: number;
}

export type CaptureMessageFn = typeof captureMessage;

export interface MfaAbuseWatcherOptions {
  /** Override the alerting threshold (count of 429s within window). */
  threshold?: number;
  /** Override the sliding-window length in ms. */
  windowMs?: number;
  /** Override the per-identity alert throttle in ms. */
  cooldownMs?: number;
  /** Inject a Sentry capture sink for tests. Defaults to `captureMessage`. */
  capture?: CaptureMessageFn;
}

function readPositiveInt(
  raw: string | undefined,
  fallback: number,
): number {
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const DEFAULT_THRESHOLD = 3;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

export class MfaAbuseWatcher {
  readonly threshold: number;
  readonly windowMs: number;
  readonly cooldownMs: number;
  private readonly capture: CaptureMessageFn;
  private readonly buckets = new Map<string, IdentityBucket>();

  constructor(opts: MfaAbuseWatcherOptions = {}) {
    this.threshold =
      opts.threshold ??
      readPositiveInt(
        process.env.MFA_RATE_LIMIT_ALERT_THRESHOLD,
        DEFAULT_THRESHOLD,
      );
    this.windowMs =
      opts.windowMs ??
      readPositiveInt(
        process.env.MFA_RATE_LIMIT_ALERT_WINDOW_MS,
        DEFAULT_WINDOW_MS,
      );
    this.cooldownMs =
      opts.cooldownMs ??
      readPositiveInt(
        process.env.MFA_RATE_LIMIT_ALERT_COOLDOWN_MS,
        DEFAULT_COOLDOWN_MS,
      );
    this.capture = opts.capture ?? captureMessage;
  }

  /**
   * Note a single MFA-route 429. Called from `apiRateLimit` only when
   * the limiter name starts with `"mfa_"`. Safe to call from a
   * fire-and-forget context — internal failures are swallowed and
   * logged so they can't bubble back into the request path.
   */
  record(event: MfaAbuseRecord, now: number = Date.now()): void {
    try {
      const cutoff = now - this.windowMs;
      const bucket = this.getOrCreateBucket(event.identity);
      // Drop entries that have aged out of the window. Done in-place
      // to keep the bucket array compact without allocating a new
      // array on every record.
      while (bucket.timestamps.length > 0 && bucket.timestamps[0]! <= cutoff) {
        bucket.timestamps.shift();
      }
      bucket.timestamps.push(now);

      if (
        bucket.timestamps.length >= this.threshold &&
        now - bucket.lastAlertedAt >= this.cooldownMs
      ) {
        bucket.lastAlertedAt = now;
        this.emitAlert(event, bucket.timestamps.length, now);
      }
    } catch (err) {
      // Never let a watcher bug bubble back into the rate-limit
      // middleware. Sentry already has the underlying 429 via the
      // forensic table; missing one alert is preferable to crashing
      // the request path.
      logger.warn(
        { err: (err as Error).message },
        "mfa_abuse_watcher_record_failed",
      );
    }
  }

  /**
   * Drop buckets whose most-recent entry has aged out of the window.
   * Cheap to call periodically (every window length is a reasonable
   * cadence). The boot caller wires this via `startSweepTimer`; tests
   * can drive it directly with a deterministic clock.
   */
  sweep(now: number = Date.now()): void {
    const cutoff = now - this.windowMs;
    for (const [identity, bucket] of this.buckets) {
      // Prune aged entries first so a bucket whose entries all fell
      // out of the window can be evicted in this pass.
      while (bucket.timestamps.length > 0 && bucket.timestamps[0]! <= cutoff) {
        bucket.timestamps.shift();
      }
      // Evict if both the rolling window is empty AND the cooldown
      // has lapsed — we want to keep the lastAlertedAt around for
      // long enough that a slow attacker can't trivially re-trigger
      // the alert within the same logical incident by spreading
      // their bursts across sweep cycles.
      if (
        bucket.timestamps.length === 0 &&
        now - bucket.lastAlertedAt >= this.cooldownMs
      ) {
        this.buckets.delete(identity);
      }
    }
  }

  /** Read-only snapshot for tests / future dashboard wiring. */
  getSnapshot(): {
    trackedIdentities: number;
    threshold: number;
    windowMs: number;
    cooldownMs: number;
  } {
    return {
      trackedIdentities: this.buckets.size,
      threshold: this.threshold,
      windowMs: this.windowMs,
      cooldownMs: this.cooldownMs,
    };
  }

  /** Test-only: reset internal state between cases. */
  __reset(): void {
    this.buckets.clear();
  }

  private getOrCreateBucket(identity: string): IdentityBucket {
    let bucket = this.buckets.get(identity);
    if (!bucket) {
      bucket = { timestamps: [], lastAlertedAt: 0 };
      this.buckets.set(identity, bucket);
    }
    return bucket;
  }

  private emitAlert(
    event: MfaAbuseRecord,
    count: number,
    now: number,
  ): void {
    // Structured log first so the audit aggregator has the signal
    // even when Sentry is off (no SENTRY_DSN). Mirrors the pattern
    // used by `auditChainVerifier` and `RedisFailureWatcher`.
    logger.warn(
      {
        identity: event.identity,
        route: event.route,
        limiter: event.name,
        tier: event.tier,
        count,
        threshold: this.threshold,
        windowMs: this.windowMs,
      },
      "mfa_rate_limit_burst_detected",
    );
    this.capture("mfa_rate_limit_burst_detected", {
      level: "warning",
      tags: {
        subsystem: "rate_limit",
        alert: "mfa_rate_limit_burst",
        // Tier is low-cardinality and useful for triage routing;
        // identity is high-cardinality so it goes in `extra`, not
        // `tags` (Sentry caps tag values and prefers low cardinality).
        tier: event.tier,
        limiter: event.name,
      },
      extra: {
        identity: event.identity,
        route: event.route,
        count,
        threshold: this.threshold,
        windowMs: this.windowMs,
        cooldownMs: this.cooldownMs,
        observedAt: now,
      },
      // Per-identity stable fingerprint. Every burst from the same
      // identity rolls up into one Sentry issue (cooldown bounds
      // event volume), and a fresh identity opens a fresh issue.
      fingerprint: ["mfa_rate_limit_burst", event.identity],
    });
  }
}

export const mfaAbuseWatcher = new MfaAbuseWatcher();

/**
 * Wire a periodic sweep so identities that stop misbehaving don't
 * pin memory indefinitely. Returns the timer handle so the boot
 * caller can clear it on shutdown if needed; the timer is `unref`ed
 * so it never blocks Node from exiting.
 *
 * Skipped under NODE_ENV=test so unit tests don't get a stray timer
 * polluting their fake-timer assertions.
 */
export function startMfaAbuseWatcherSweepTimer(
  watcher: MfaAbuseWatcher = mfaAbuseWatcher,
): NodeJS.Timeout | null {
  if (process.env.NODE_ENV === "test") return null;
  const handle = setInterval(() => watcher.sweep(), watcher.windowMs);
  handle.unref?.();
  return handle;
}
