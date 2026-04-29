import type { Request, RequestHandler } from "express";
import { sql } from "drizzle-orm";
import IORedis, { type Redis } from "ioredis";
import { db } from "../lib/db";
import { newSafeId } from "../lib/ids";
import { logger } from "../lib/logger";
import { getUserId } from "../lib/auth";
import { detectNonHostnameProductionSignals } from "../lib/productionSignals";
import {
  WebhookIncidentNotifier,
  type RateLimitIncidentNotifier,
} from "../lib/rate-limit/incidentNotifier";
import { userHasAnyRole } from "../lib/roles";
import { captureException, captureMessage } from "../lib/sentry";

/**
 * Per-route + per-identity rate limiter.
 *
 * Tiers (per minute, configurable via env):
 *   anon   — 60   (no Clerk session, IP-keyed)
 *   buyer  — 240  (signed in, no seller/admin role)
 *   seller — 600  (signed in seller — generous for live ops)
 *   admin  — 1200 (back-office — only realistic ceiling for paginating
 *            very large result sets)
 *
 * Bucket store is selected by `RATE_LIMIT_STORE`:
 *   - unset / "memory" — process-local sliding window log. Fine for a
 *     single api-server replica.
 *   - "redis"          — sliding window log stored in Redis via an
 *     atomic Lua script. Required before scaling horizontally because
 *     each in-memory replica would otherwise own its own quota,
 *     effectively multiplying the cap by the replica count.
 */

/**
 * Boot-time sanity check: production deploys MUST set
 * `RATE_LIMIT_STORE=redis` (and the matching `REDIS_URL`).
 *
 * The runbook (`docs/runbooks/rate-limit-store.md`) explicitly says
 * Redis is required for any deploy with more than one api-server
 * replica — the in-process memory bucket is replica-local, so a
 * multi-replica production deploy that ships with the default falls
 * back to per-process counters. An attacker can defeat the per-tier
 * cap by simply spreading their traffic across replicas: each replica
 * has its own quota, so the effective rate limit is multiplied by the
 * replica count and the abuse-prevention layer is silently disabled.
 *
 * That misconfiguration ships clean today — `createBucketStore` reads
 * the env var lazily and quietly defaults to `InMemoryStore` when it's
 * unset. Until task #84 added `assertProductionHostnamePatternConfigured`
 * the only feedback an operator got was a runbook prose sentence —
 * easy to miss across env-var rotations and platform migrations. This
 * check, modelled on that one, turns the runbook recommendation into
 * an automated boot-time signal:
 *
 *   - If a production-shaped deploy is detected (any of `NODE_ENV=production`,
 *     `REPLIT_DEPLOYMENT=1`, `DEPLOYMENT_ENVIRONMENT=production`),
 *   - AND `RATE_LIMIT_STORE` does not normalise to "redis" (i.e. it's
 *     unset / empty / "memory" / any other value that falls back to
 *     the in-process memory bucket),
 *   - AND the explicit escape hatch
 *     `RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION=1` is NOT set,
 *   - THEN emit a loud structured error naming the missing config and
 *     return `{ ok: false }` so the boot caller can `process.exit(1)`
 *     and refuse to start serving traffic. This mirrors how
 *     `assertRehearsalKillSwitchSafe` is already a hard failure.
 *
 * The check determines production-ness via the operator-set env vars
 * only (the same `detectNonHostnameProductionSignals` helper used by
 * `assertProductionHostnamePatternConfigured`). Hostname matching is
 * intentionally out of scope here — it would require dragging the
 * regex parsing into the rate-limit module, and the signals chosen
 * are sufficient to catch the production deploys we actually ship.
 *
 * Escape hatch (`RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION=1`):
 * legitimate single-replica production deploys (canary, internal-only
 * tools) that intentionally run on the in-process bucket can opt out
 * by setting this env var to the literal `"1"`. The check then
 * downgrades from a fatal error to a loud `pino warn` keyed off
 * `rate_limit_store_memory_in_production_via_opt_out` so on-call still
 * sees that the bypassable per-process bucket is in use, but boot is
 * allowed to proceed. A multi-replica production deploy that flips
 * this flag to silence the failure has misused the escape hatch — the
 * runbook documents the exact criteria for when it's safe.
 *
 * Pre-graduation history: this check used to emit a `warn` and let
 * boot continue regardless. That was deliberately non-fatal so the
 * change could ship without crash-looping existing production deploys
 * that hadn't yet wired Redis. Now that managed Redis is provisioned
 * for every shipping production deploy and the Sentry alert on the
 * warning has been clean for the stabilisation window described in
 * task #87, the check has been graduated to a hard failure so a
 * future env-var rotation can't silently re-introduce the bypassable
 * per-process bucket on a multi-replica deploy.
 *
 * Pure function — takes `env` and a `log` sink so the unit test can
 * exercise the staging-skipped, production-failed, opt-out-warned,
 * and production-configured paths without poisoning `process.env` or
 * piping pino output. Returns the outcome instead of calling
 * `process.exit` directly so the caller composes the boot sequence
 * (and tests can assert on the return value).
 */
export type RateLimitStoreConfigOutcome =
  | { ok: true }
  | { ok: false; reason: string };

export function assertRateLimitStoreConfiguredForProduction(
  env: NodeJS.ProcessEnv,
  log: {
    warn: (obj: unknown, msg: string) => void;
    error: (obj: unknown, msg: string) => void;
  },
): RateLimitStoreConfigOutcome {
  const productionSignals = detectNonHostnameProductionSignals(env);
  if (productionSignals.length === 0) {
    // Not a production deploy — the in-process bucket is fine on
    // staging / dev / preview environments. Nothing to log about.
    return { ok: true };
  }

  // Normalise via the SAME helper `createBucketStore` uses so the
  // check agrees byte-for-byte with the actual runtime selection.
  // Any value that doesn't normalise to "redis" — unset, empty,
  // whitespace-only, "memory", typos like "redys", or anything else
  // `createBucketStore` would also reject and log
  // `rate_limit_store_unknown_kind_falling_back_to_memory` for —
  // falls back to the per-process memory bucket and is the
  // misconfiguration we're failing on. The shared helper means a
  // whitespace-padded `RATE_LIMIT_STORE=" redis "` is BOTH selected
  // as redis at runtime AND counted as configured here, instead of
  // the runtime silently falling back to memory while the guard
  // stayed silent — exactly the kind of false-negative this check
  // exists to prevent.
  const raw = env.RATE_LIMIT_STORE;
  const normalised = normaliseRateLimitStoreKind(raw);
  if (normalised === "redis") {
    // Configured. We deliberately do NOT also assert REDIS_URL here —
    // `createBucketStore` already throws synchronously at boot when
    // `RATE_LIMIT_STORE=redis` is set without `REDIS_URL`, which
    // crash-loops the deploy with a clear message. A second log line
    // from this check would be duplicate noise on a path that already
    // fails loudly.
    return { ok: true };
  }

  const signalDetails = productionSignals.map((s) => s.detail).join("; ");
  const observed =
    raw === undefined
      ? "RATE_LIMIT_STORE is unset"
      : `RATE_LIMIT_STORE=${JSON.stringify(raw)}`;
  const reason =
    `${observed} on this production deploy — the rate limiter will fall ` +
    "back to a per-process in-memory bucket. " +
    `Detected production signal(s): ${signalDetails}. ` +
    "Multi-replica deploys with the in-memory bucket give each replica " +
    "its own counters, so the per-tier rate limit is effectively " +
    "multiplied by the replica count and trivially bypassed by spreading " +
    "traffic across replicas. Set RATE_LIMIT_STORE=redis (and REDIS_URL) " +
    "— see docs/runbooks/rate-limit-store.md (boot-time presence check).";

  // Explicit opt-out for legitimate single-replica production deploys
  // (canary, internal-only tools). The escape hatch is gated on the
  // literal "1" — same strictness as `REPLIT_DEPLOYMENT=1` in
  // `detectNonHostnameProductionSignals` — so casing drift like
  // "true" / "yes" can't accidentally bypass the boot failure. When
  // set, the check downgrades from a hard error to a loud warn so
  // operators can still see in Sentry / log aggregators that the
  // bypassable per-process bucket is in use; boot is allowed to
  // proceed.
  if (env.RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION === "1") {
    // The structured payload includes `hostname` so the Sentry alert
    // on this warn tag can match the emitting host against the
    // opt-out inventory in
    // `docs/runbooks/rate-limit-store-opt-outs.md`. A warn from a
    // host not in the inventory pages on-call as a misuse; a warn
    // from an inventoried host is a routine audit notification. See
    // `docs/runbooks/rate-limit-store.md` (Wire alerts section) for
    // the exact rule wiring.
    log.warn(
      {
        node_env: env.NODE_ENV,
        replit_deployment: env.REPLIT_DEPLOYMENT,
        deployment_environment: env.DEPLOYMENT_ENVIRONMENT,
        rate_limit_store: raw ?? null,
        rate_limit_store_allow_memory_in_production:
          env.RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION,
        production_signals: productionSignals.map((s) => s.signal),
        hostname: env.HOSTNAME ?? null,
      },
      `rate_limit_store_memory_in_production_via_opt_out: ${reason} ` +
        "Boot is proceeding because " +
        "RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION=1 explicitly opts out " +
        "of the hard-fail check; this is only safe for single-replica " +
        "deploys.",
    );
    return { ok: true };
  }

  log.error(
    {
      node_env: env.NODE_ENV,
      replit_deployment: env.REPLIT_DEPLOYMENT,
      deployment_environment: env.DEPLOYMENT_ENVIRONMENT,
      rate_limit_store: raw ?? null,
      production_signals: productionSignals.map((s) => s.signal),
    },
    `rate_limit_store_misconfigured_for_production: ${reason} ` +
      "Refusing to start. Set RATE_LIMIT_STORE=redis (and REDIS_URL) on " +
      "this deploy, or set RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION=1 " +
      "to opt out (single-replica deploys only — see runbook).",
  );
  return { ok: false, reason };
}

type Tier = "anon" | "buyer" | "seller" | "admin";

interface BumpResult {
  allowed: boolean;
  retryAfterMs: number;
}

interface BucketStore {
  readonly kind: "memory" | "redis";
  bump(key: string, now: number, windowMs: number, max: number): Promise<BumpResult>;
}

/**
 * Watches RedisStore failure log keys and forwards them to Sentry so the
 * "degrade open" branch never goes unnoticed. Two signals are emitted:
 *
 *   1. Per-failure `captureException` with `tags.kind` set to one of the
 *      log keys ("rate_limit_redis_bump_failed" or
 *      "rate_limit_redis_client_error"). A Sentry alert rule keyed off
 *      `tags.subsystem == "rate_limit"` can fire above any chosen
 *      events-per-minute threshold.
 *   2. An in-process sliding-minute counter that, when it crosses
 *      `RATE_LIMIT_REDIS_FAILURE_ALERT_PER_MIN` (default 5), emits a
 *      `level: "fatal"` `captureMessage` with a stable fingerprint.
 *      Sentry's default new-issue notification fires on the first such
 *      event so we get an alert even when no project-specific rule has
 *      been configured. The breach is throttled to one event per
 *      `RATE_LIMIT_REDIS_FAILURE_ALERT_COOLDOWN_MS` (default 60s) to
 *      avoid spamming on-call during a sustained outage.
 */
class RedisFailureWatcher {
  // Breach detection state — rate-based, untouched by recordSuccess so a
  // partial outage where Redis flaps still trips the alert when the
  // failure rate over the rolling 60s window crosses threshold.
  private timestamps: number[] = [];
  private lastBreachAt = 0;
  // Recovery-incident state — describes the current "streak" between the
  // last clean state and the next success. Reset on every recordSuccess
  // independently of the breach detector above.
  //   firstFailureAt          — when this streak began (for durationMs)
  //   failuresSinceFirstFailure — how many failures it spans (for failureCount)
  //   breachedThisIncident    — gates whether we actually emit recovery
  //                             on the next success (avoid noise for blips)
  private firstFailureAt: number | null = null;
  private failuresSinceFirstFailure = 0;
  private breachedThisIncident = false;
  // Wallclock timestamp of the most recent recordSuccess that closed an
  // active failure streak. Surfaced via /healthz so dashboards and
  // uptime probes can see when the store last recovered without
  // grepping Sentry. `null` until at least one streak has recovered.
  private lastRecoveredAt: number | null = null;
  readonly thresholdPerMin: number;
  readonly cooldownMs: number;
  /**
   * Out-of-band paging sink (Slack / PagerDuty). Default is the
   * env-driven webhook notifier; tests inject a deterministic stub via
   * the constructor opts so we can assert on the exact transitions
   * without touching network state.
   */
  private readonly incidentNotifier: RateLimitIncidentNotifier;

  constructor(opts?: {
    threshold?: number;
    cooldownMs?: number;
    incidentNotifier?: RateLimitIncidentNotifier;
  }) {
    this.thresholdPerMin =
      opts?.threshold ??
      Number(process.env.RATE_LIMIT_REDIS_FAILURE_ALERT_PER_MIN ?? "5");
    this.cooldownMs =
      opts?.cooldownMs ??
      Number(process.env.RATE_LIMIT_REDIS_FAILURE_ALERT_COOLDOWN_MS ?? "60000");
    this.incidentNotifier =
      opts?.incidentNotifier ?? new WebhookIncidentNotifier();
  }

  record(
    kind: "rate_limit_redis_bump_failed" | "rate_limit_redis_client_error",
    err: unknown,
    now: number = Date.now(),
  ): void {
    captureException(err, {
      tags: { subsystem: "rate_limit", kind },
      level: "error",
    });
    // Track whether this failure starts a brand-new streak — that's the
    // healthy→degraded edge consumed by /healthz (`state` flips to
    // "degraded" the instant `firstFailureAt` becomes non-null) and by
    // the admin console's `prevState !== "degraded"` dedupe. Paging on
    // this edge keeps the out-of-band signal aligned with the in-app
    // banner: if the operator sees a banner, on-call sees a page; if
    // the operator never saw a banner (single-tick blip resolved
    // before the next health-check poll), on-call still gets the page
    // for the actual state transition the watcher observed. Decoupling
    // this from the rate-based `thresholdPerMin` breach below means
    // the threshold is purely a Sentry-telemetry concern: it controls
    // when a `level: "fatal"` `captureMessage` rolls up but no longer
    // gates the Slack/PagerDuty page.
    const isFirstFailureInStreak = this.firstFailureAt === null;
    if (isFirstFailureInStreak) {
      this.firstFailureAt = now;
      this.failuresSinceFirstFailure = 0;
    }
    this.failuresSinceFirstFailure += 1;
    if (isFirstFailureInStreak) {
      // Page exactly once per healthy→degraded transition. Wrapped in
      // try/catch so a webhook-transport bug can't bubble back into the
      // bump path — Sentry already has the underlying failure via the
      // captureException above.
      try {
        this.incidentNotifier.notifyDegraded({
          failureCount: this.failuresSinceFirstFailure,
          threshold: this.thresholdPerMin,
          firstFailureAt: now,
          breachedAt: now,
        });
      } catch (notifyErr) {
        logger.warn(
          { err: (notifyErr as Error).message },
          "rate_limit_incident_notify_degraded_threw",
        );
      }
    }
    const cutoff = now - 60_000;
    this.timestamps.push(now);
    while (this.timestamps.length > 0 && this.timestamps[0]! <= cutoff) {
      this.timestamps.shift();
    }
    if (
      this.timestamps.length >= this.thresholdPerMin &&
      now - this.lastBreachAt >= this.cooldownMs
    ) {
      this.lastBreachAt = now;
      this.breachedThisIncident = true;
      logger.error(
        { count: this.timestamps.length, threshold: this.thresholdPerMin },
        "rate_limit_redis_failure_threshold_breached",
      );
      captureMessage("rate_limit_redis_failure_threshold_breached", {
        level: "fatal",
        tags: {
          subsystem: "rate_limit",
          alert: "rate_limit_store_degraded",
        },
        extra: {
          count: this.timestamps.length,
          threshold: this.thresholdPerMin,
          windowSeconds: 60,
        },
        // Stable fingerprint so all breaches roll up into a single Sentry
        // issue instead of one issue per cooldown tick.
        fingerprint: ["rate-limit-redis-failure-threshold"],
      });
    }
  }

  /**
   * Called by `RedisStore.bump` after a successful Lua roundtrip. If we
   * previously crossed the degraded-alert threshold (i.e. on-call was
   * paged with `rate_limit_store_degraded`), emit a paired
   * `rate_limit_store_recovered` Sentry signal so the incident timeline
   * closes itself instead of relying on Sentry's auto-resolve / a
   * manual `/healthz` poke.
   *
   * The Sentry recovery signal still gates on `breachedThisIncident`
   * because Sentry's breach event is itself threshold-gated — pairing
   * "recovered" with "breached" keeps that telemetry channel coherent.
   *
   * The OUT-OF-BAND incident notifier (Slack/PagerDuty) operates on
   * different semantics: it fires on every degraded→healthy edge,
   * matching the admin console's `lastRecoveredAt`-based banner so
   * the in-app and on-call channels can never disagree about whether
   * an incident occurred. PagerDuty's shared `dedup_key` makes a
   * paired resolve a no-op if no trigger ever fired, so this is safe.
   */
  recordSuccess(now: number = Date.now()): void {
    const hadBreach = this.breachedThisIncident;
    const startedAt = this.firstFailureAt;
    const failureCount = this.failuresSinceFirstFailure;
    // Reset recovery-incident state up front so a misbehaving Sentry
    // transport can't leave us pinned in a degraded state. Note we do
    // NOT touch `timestamps` or `lastBreachAt` here — those belong to
    // the rate-based breach detector and must keep their rolling-minute
    // semantics across partial outages where Redis flaps. See class doc.
    this.firstFailureAt = null;
    this.failuresSinceFirstFailure = 0;
    this.breachedThisIncident = false;
    // Stamp the recovery clock for any streak that actually recovered,
    // even sub-threshold blips. /healthz consumers want "when did the
    // store last come back" regardless of whether on-call was paged.
    if (startedAt !== null) {
      this.lastRecoveredAt = now;
    }
    // Out-of-band "all clear" page on the degraded→healthy transition.
    // We fire on EVERY closing streak (matching admin console's
    // `lastRecoveredAt !== prevRecoveredAt` dedupe), not just streaks
    // that crossed the Sentry breach threshold — the in-app banner and
    // the on-call channel must agree about whether an incident
    // happened, and `RateLimitStoreAlerts` decides that purely from
    // `state` flipping degraded→healthy. PagerDuty's `dedup_key` makes
    // a paired resolve a no-op if no trigger ever fired, so this
    // doesn't open spurious incidents.
    if (startedAt !== null) {
      const durationMs = Math.max(0, now - startedAt);
      try {
        this.incidentNotifier.notifyRecovered({
          durationMs,
          failureCount,
          recoveredAt: now,
        });
      } catch (notifyErr) {
        logger.warn(
          { err: (notifyErr as Error).message },
          "rate_limit_incident_notify_recovered_threw",
        );
      }
    }
    if (!hadBreach || startedAt === null) return;
    // Recovery is the true close of an alert window: drop the cooldown
    // gate so a fresh outage right after recovery can re-page on-call
    // instead of being silenced by leftover within-incident throttling.
    this.lastBreachAt = 0;
    const durationMs = Math.max(0, now - startedAt);
    logger.info(
      { durationMs, failureCount },
      "rate_limit_redis_recovered",
    );
    captureMessage("rate_limit_redis_recovered", {
      level: "info",
      tags: {
        subsystem: "rate_limit",
        alert: "rate_limit_store_recovered",
      },
      extra: {
        durationMs,
        failureCount,
      },
      // Pair with the breach fingerprint so dashboards can correlate
      // degraded↔recovered transitions for the same logical incident.
      fingerprint: ["rate-limit-redis-recovered"],
    });
  }

  /**
   * Read-only snapshot of the current incident-streak state for /healthz.
   *
   *   state            — "degraded" while a streak is ongoing
   *                      (firstFailureAt !== null), otherwise "healthy".
   *                      We deliberately surface even sub-threshold
   *                      streaks so dashboards can spot Redis trouble
   *                      before the alert fires.
   *   failureCount     — number of failures in the current streak. 0
   *                      when healthy.
   *   firstFailureAt   — ms epoch the current streak began, or null.
   *   lastRecoveredAt  — ms epoch the most recent streak ended, or null
   *                      until at least one streak has recovered.
   */
  getSnapshot(): {
    state: "healthy" | "degraded";
    failureCount: number;
    firstFailureAt: number | null;
    lastRecoveredAt: number | null;
  } {
    return {
      state: this.firstFailureAt === null ? "healthy" : "degraded",
      failureCount: this.failuresSinceFirstFailure,
      firstFailureAt: this.firstFailureAt,
      lastRecoveredAt: this.lastRecoveredAt,
    };
  }

  /** Test-only: reset internal counters between cases. */
  __reset(): void {
    this.timestamps = [];
    this.lastBreachAt = 0;
    this.firstFailureAt = null;
    this.failuresSinceFirstFailure = 0;
    this.breachedThisIncident = false;
    this.lastRecoveredAt = null;
  }

  /**
   * Test/rehearsal-only: seed an in-progress failure streak directly
   * without going through the rolling-window breach detector. Used by
   * the staging-only rehearsal route (routes/healthzRehearsal.ts) to
   * flip the rate-limit store into a synthetic degraded state with
   * firstFailureAt older than the duration-alert threshold so the
   * checkHealthzDegraded probe will exit 2 against staging without
   * having to actually break Redis. Production code paths must NEVER
   * call this; the route layer gates it on HEALTHZ_REHEARSAL_ENABLED.
   */
  __injectStreak(firstFailureAt: number, failureCount: number): void {
    this.firstFailureAt = firstFailureAt;
    this.failuresSinceFirstFailure = Math.max(1, Math.floor(failureCount));
  }
}

const redisFailureWatcher = new RedisFailureWatcher();

interface Bucket {
  hits: number[];
}

class InMemoryStore implements BucketStore {
  readonly kind = "memory" as const;
  private readonly map = new Map<string, Bucket>();
  async bump(key: string, now: number, windowMs: number, max: number): Promise<BumpResult> {
    const cutoff = now - windowMs;
    let bucket = this.map.get(key);
    if (!bucket) {
      bucket = { hits: [] };
      this.map.set(key, bucket);
    }
    bucket.hits = bucket.hits.filter((t) => t > cutoff);
    if (bucket.hits.length >= max) {
      const retryAfterMs = bucket.hits[0]! + windowMs - now;
      return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 1000) };
    }
    bucket.hits.push(now);
    return { allowed: true, retryAfterMs: 0 };
  }
  sweep(now: number, windowMs: number): void {
    const cutoff = now - windowMs;
    for (const [k, b] of this.map) {
      const newest = b.hits[b.hits.length - 1] ?? 0;
      if (newest < cutoff) this.map.delete(k);
    }
  }
}

/**
 * Lua-backed sliding-window log. We use a sorted set per key:
 *   score  = hit timestamp (ms)
 *   member = unique nonce per insert (ts + nonce) so ZADD never collides
 *
 * The script atomically:
 *   1. Drops scores <= now - windowMs (matches InMemoryStore's strict
 *      `t > cutoff` filter).
 *   2. Returns 429 + a Retry-After hint when ZCARD >= max.
 *   3. Otherwise ZADDs the new hit and refreshes PEXPIRE.
 *
 * Atomicity matters: without the script, two concurrent requests at
 * `max - 1` could each read the count, both decide they're allowed,
 * and both write — slipping a request past the cap.
 */
const RATE_LIMIT_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local max = tonumber(ARGV[3])
local member = ARGV[4]
local cutoff = now - windowMs
redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)
local count = redis.call('ZCARD', key)
if count >= max then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retryAfter = (tonumber(oldest[2]) + windowMs) - now
  if retryAfter < 1000 then retryAfter = 1000 end
  return {0, retryAfter}
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, windowMs + 1000)
return {1, 0}
`;

interface RateLimitRedis extends Redis {
  rateLimitBump(
    key: string,
    now: string,
    windowMs: string,
    max: string,
    member: string,
  ): Promise<[number, number]>;
}

class RedisStore implements BucketStore {
  readonly kind = "redis" as const;
  private readonly redis: RateLimitRedis;
  private memberSeq = 0;
  constructor(redis: Redis) {
    redis.defineCommand("rateLimitBump", {
      numberOfKeys: 1,
      lua: RATE_LIMIT_LUA,
    });
    this.redis = redis as RateLimitRedis;
  }
  /**
   * Issues a `PING` against the underlying Redis client with a hard
   * timeout. Used by the `/readyz` probe so the load balancer can drain
   * a replica whose backing Redis is unreachable instead of letting it
   * keep degrading-open silently. We don't reuse `enableReadyCheck`
   * here because that only fires once at connect time — we want a live
   * round-trip per probe call.
   */
  async ping(timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.redis.ping(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`redis_ping_timeout_after_${timeoutMs}ms`)),
            timeoutMs,
          );
          timer.unref?.();
        }),
      ]);
      if (result !== "PONG") {
        throw new Error(`unexpected_ping_response:${String(result)}`);
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async bump(key: string, now: number, windowMs: number, max: number): Promise<BumpResult> {
    // Unique member to avoid ZADD score collisions when two hits land on
    // the same millisecond. Process pid + monotonic counter is enough —
    // a redis-side INCR would add a round-trip and break atomicity.
    this.memberSeq = (this.memberSeq + 1) >>> 0;
    const member = `${now}:${process.pid}:${this.memberSeq}`;
    try {
      const [allowed, retryAfter] = await this.redis.rateLimitBump(
        key,
        String(now),
        String(windowMs),
        String(max),
        member,
      );
      // Notify the failure watcher that Redis is healthy again. The
      // watcher only emits a recovery signal when the prior streak
      // actually crossed the degraded-alert threshold, so the common
      // happy path is an O(1) bookkeeping reset.
      redisFailureWatcher.recordSuccess(now);
      return {
        allowed: Number(allowed) === 1,
        retryAfterMs: Number(retryAfter),
      };
    } catch (err) {
      // Degrade open if Redis is unreachable — better to serve than to
      // 429 every request because of a backing-store outage. The error
      // is logged AND forwarded to Sentry (see RedisFailureWatcher) so
      // on-call notices instead of the rate limiter silently disabling
      // itself.
      logger.error(
        { err: (err as Error).message },
        "rate_limit_redis_bump_failed",
      );
      // Thread the bump's `now` so the watcher's first-failure timestamp
      // and the eventual recovery `durationMs` share a clock — important
      // for tests that drive synthetic time, and harmless in production
      // where `now` is always Date.now().
      redisFailureWatcher.record("rate_limit_redis_bump_failed", err, now);
      return { allowed: true, retryAfterMs: 0 };
    }
  }
}

/**
 * Normalise `RATE_LIMIT_STORE` to a comparable kind string. Trims
 * surrounding whitespace and lowercases, then defaults to `"memory"`
 * for unset/empty so the value can be safely compared with `===`.
 *
 * Shared between `createBucketStore` (which actually picks the store)
 * and `assertRateLimitStoreConfiguredForProduction` (which warns when
 * the picked store isn't redis on a production deploy). The two MUST
 * agree byte-for-byte: if the guard treated `" redis "` as configured
 * but `createBucketStore` rejected it as unknown and silently fell
 * back to the in-process bucket, a whitespace-padded production env
 * value would leave the deploy bypassable while the new boot-time
 * warning stayed silent — exactly the misconfiguration class this
 * check is meant to catch.
 */
function normaliseRateLimitStoreKind(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return "memory";
  return trimmed.toLowerCase();
}

/**
 * Tri-state status of `RATE_LIMIT_STORE` configuration surfaced on
 * `/readyz` (see `getReadyzConfigBlock` in `routes/health.ts`).
 *
 * The boot-time `assertRateLimitStoreConfiguredForProduction` already
 * crash-loops a production-shaped deploy that ships with the in-memory
 * bucket and no opt-out, so the dangerous combination cannot reach
 * steady state via a clean restart. This status is the *runtime*
 * surface for the same check so an external probe (and on-call dashboard)
 * can verify the configuration without shelling onto the host AND can
 * page when a hot env-var rotation flipped the deploy into the
 * dangerous combination without restarting.
 *
 * Inputs:
 *   - `currentStoreKind` — the kind the bucket store is actually
 *     using right now (from `getRateLimitStoreKind()`). Reflects the
 *     `createBucketStore` decision at module load — this is what
 *     matters for runtime behaviour, distinct from a hot-rotated env
 *     value that won't take effect until the next restart.
 *   - `env` — read at call time so a hot rotation of
 *     `RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION` (the opt-out
 *     escape hatch) and the production-signal env vars is reflected
 *     on the next probe.
 *
 * Values:
 *   - `"redis"` — the running bucket store is Redis. Healthy
 *     regardless of deploy shape.
 *   - `"memory_not_required"` — running on the in-memory bucket on a
 *     non-production deploy (dev / staging / preview). Intended state
 *     for single-replica non-production environments.
 *   - `"memory_opt_out_acknowledged"` — running on memory on a
 *     production-shaped deploy with
 *     `RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION=1`. Boot-time
 *     check downgraded to a `warn` rather than a hard fail; matches
 *     the in-process bucket warn-log signal. Single-replica
 *     production deploys (canary, internal-only tools) live here
 *     intentionally — see `docs/runbooks/rate-limit-store-opt-outs.md`.
 *   - `"memory_misconfigured"` — running on memory on a production-
 *     shaped deploy with NO opt-out. The boot guard would have failed
 *     this on a clean restart; the only way to land here at runtime
 *     is a hot env-var rotation that flipped a production signal on
 *     after boot. Page on-call so the deploy is restarted (which will
 *     then crash-loop into a visible boot failure) or the env-var
 *     change is reverted.
 *
 * Pure function — takes `currentStoreKind` and `env` so the readyz
 * route handler and unit tests can drive every branch without
 * poisoning module state.
 */
export type RateLimitStoreReadyzStatus =
  | "redis"
  | "memory_not_required"
  | "memory_opt_out_acknowledged"
  | "memory_misconfigured";

export function getRateLimitStoreReadyzStatus(
  currentStoreKind: "memory" | "redis",
  env: NodeJS.ProcessEnv,
): RateLimitStoreReadyzStatus {
  if (currentStoreKind === "redis") return "redis";
  const productionSignals = detectNonHostnameProductionSignals(env);
  if (productionSignals.length === 0) return "memory_not_required";
  if (env.RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION === "1") {
    return "memory_opt_out_acknowledged";
  }
  return "memory_misconfigured";
}

function createBucketStore(): BucketStore {
  const kind = normaliseRateLimitStoreKind(process.env.RATE_LIMIT_STORE);
  if (kind === "redis") {
    // TODO(deploy): provision a managed Redis (Upstash for serverless,
    // Memorystore for region-pinned VMs) and wire its connection string
    // into the api-server deployment env as REDIS_URL. Until that's
    // done, leave RATE_LIMIT_STORE unset (or "memory") in production —
    // flipping this flag without REDIS_URL fails the boot below, and
    // any per-replica memory buckets effectively multiply the rate
    // limit by the replica count, so don't enable horizontal scale-out
    // on the api-server until this is resolved. Tracked as task #39.
    const url = process.env.REDIS_URL;
    if (!url) {
      throw new Error(
        "RATE_LIMIT_STORE=redis requires REDIS_URL to be set",
      );
    }
    const client = new IORedis(url, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
    });
    client.on("error", (err) => {
      logger.error(
        { err: err.message },
        "rate_limit_redis_client_error",
      );
      redisFailureWatcher.record("rate_limit_redis_client_error", err);
    });
    return new RedisStore(client);
  }
  if (kind !== "memory") {
    logger.warn(
      { kind },
      "rate_limit_store_unknown_kind_falling_back_to_memory",
    );
  }
  return new InMemoryStore();
}

const store: BucketStore = createBucketStore();
const SWEEP_MS = 10 * 60 * 1000;
if (store instanceof InMemoryStore && process.env.NODE_ENV !== "test") {
  setInterval(() => store.sweep(Date.now(), SWEEP_MS), SWEEP_MS).unref?.();
}

const DEFAULTS: Record<Tier, number> = {
  anon: Number(process.env.RATE_LIMIT_ANON_PER_MIN ?? "60"),
  buyer: Number(process.env.RATE_LIMIT_BUYER_PER_MIN ?? "240"),
  seller: Number(process.env.RATE_LIMIT_SELLER_PER_MIN ?? "600"),
  admin: Number(process.env.RATE_LIMIT_ADMIN_PER_MIN ?? "1200"),
};

function clientIp(req: Request): string {
  if (process.env.IP_RATE_LIMIT_TRUST_PROXY === "1") {
    const xff = req.headers["x-forwarded-for"];
    const first = Array.isArray(xff) ? xff[0] : xff?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

async function resolveTier(req: Request): Promise<{ tier: Tier; identity: string }> {
  const userId = getUserId(req);
  if (!userId) return { tier: "anon", identity: `ip:${clientIp(req)}` };
  // Admin check is cheap and cached by Clerk's middleware in roles.ts. If
  // it ever becomes hot-path expensive we can inline an in-memory LRU.
  try {
    const isAdmin = await userHasAnyRole(userId, ["admin", "moderator", "finance_ops", "support"]);
    if (isAdmin) return { tier: "admin", identity: `user:${userId}` };
  } catch {
    // Failure to resolve admin role doesn't unblock — fall through to
    // buyer tier so we don't accidentally elevate a degraded request.
  }
  // Seller tier MUST be derived from a server-verified row, not a
  // client-supplied header. Earlier prototype trusted `x-app-context`
  // which let any authenticated buyer self-elevate. We now check the
  // `sellers` table for an `active` status; manufacturers are also
  // captured because manufacturer roles are stored in user_roles and
  // already match the admin branch above for finance_ops/admin staff.
  try {
    const row = await db.execute<{ status: string }>(
      sql`SELECT status FROM sellers WHERE user_id = ${userId} LIMIT 1;`,
    );
    const status = row.rows[0]?.status ?? null;
    if (status === "active" || status === "approved") {
      return { tier: "seller", identity: `user:${userId}` };
    }
  } catch {
    // Degrade closed to buyer tier if the lookup fails.
  }
  return { tier: "buyer", identity: `user:${userId}` };
}

export interface ApiRateLimitOptions {
  /** Logical name used in 429 body + audit row. */
  name?: string;
  /** Window in ms — defaults to 60_000. */
  windowMs?: number;
  /** Per-tier override (multiplied against base). */
  tierMultiplier?: Partial<Record<Tier, number>>;
  /**
   * When true (default for the un-named global mount), the bucket is
   * additionally keyed by `${method}:${path}` so abuse on one endpoint
   * cannot exhaust quota for the rest of the API. Per-route mounts
   * (those passing an explicit `name`) opt out by default since their
   * bucket name is already route-scoped.
   */
  perRoute?: boolean;
  /**
   * Absolute per-identity cap that overrides the per-tier `base *
   * tierMultiplier` calculation. Used by mounts that need a hard
   * ceiling regardless of which tier the caller sits in — e.g. the
   * sensitive MFA mutation routes (regenerate backup codes, disable)
   * where the right number of legitimate calls per hour is "a
   * handful" no matter whether the user is a buyer, seller, or admin
   * operator. When set, `tierMultiplier` is ignored.
   */
  max?: number;
}

export function apiRateLimit(opts: ApiRateLimitOptions = {}): RequestHandler {
  const name = opts.name ?? "api";
  const windowMs = opts.windowMs ?? 60_000;
  const mult = opts.tierMultiplier ?? {};
  const perRoute = opts.perRoute ?? opts.name === undefined;
  const absoluteMax =
    opts.max !== undefined ? Math.max(1, Math.floor(opts.max)) : null;
  return (req, res, next) => {
    void (async () => {
      const { tier, identity } = await resolveTier(req);
      const base = DEFAULTS[tier];
      const max =
        absoluteMax ?? Math.max(1, Math.floor(base * (mult[tier] ?? 1)));
      // Per-route + per-identity key. Using `req.route?.path` would be
      // ideal but it's only populated after the matching layer runs;
      // `req.path` is stable here. We strip query string to avoid
      // unbounded cardinality on attacker-controlled query params.
      const routeKey = perRoute ? `${req.method}:${req.path.split("?")[0]}` : "*";
      const key = `${name}:${tier}:${routeKey}:${identity}`;
      const result = await store.bump(key, Date.now(), windowMs, max);
      if (!result.allowed) {
        res.setHeader("Retry-After", Math.ceil(result.retryAfterMs / 1000));
        res.status(429).json({
          error: "rate_limited",
          detail: "Request rate exceeded. Slow down and retry.",
        });
        // Fire-and-forget audit row; failure to record is non-fatal.
        void db
          .execute(
            sql`INSERT INTO rate_limit_events (id, identity, route, tier) VALUES (${newSafeId("rle_")}, ${identity}, ${req.path}, ${tier});`,
          )
          .catch((err) =>
            logger.warn({ err: (err as Error).message }, "rate_limit_event_insert_failed"),
          );
        return;
      }
      next();
    })().catch((err) => {
      logger.error({ err: (err as Error).message }, "rate_limit_unhandled");
      next();
    });
  };
}

/**
 * Returns the configured bucket store kind ("memory" | "redis"). Exposed
 * via /healthz so operators can verify a running replica is using the
 * intended backend without grepping env vars on the host.
 */
export function getRateLimitStoreKind(): "memory" | "redis" {
  return store.kind;
}

/**
 * Rehearsal-only accessor for the singleton RedisFailureWatcher. Used
 * by the staging-only routes/healthzRehearsal.ts to inject a synthetic
 * stuck-degraded streak without breaking Redis. Exporting the watcher
 * rather than a one-off setter keeps the rehearsal route the only
 * caller that needs to know about __injectStreak / __reset, and the
 * route layer is what gates this on HEALTHZ_REHEARSAL_ENABLED.
 */
export function __getRedisFailureWatcherForRehearsal(): {
  __injectStreak(firstFailureAt: number, failureCount: number): void;
  __reset(): void;
} {
  return redisFailureWatcher;
}

/**
 * Combined rate-limit store status surfaced on /healthz. The shape
 * intentionally always includes the streak fields (even for
 * `kind === "memory"`, where they're constant) so dashboard panels and
 * uptime probes can parse a stable schema without conditional branches.
 *
 * For memory replicas the failure-watcher fields are constants:
 *   { state: "healthy", failureCount: 0, firstFailureAt: null, lastRecoveredAt: null }
 * because the watcher is only fed by RedisStore — there's nothing else
 * to fail. We still return them so the schema is uniform.
 */
export function getRateLimitStoreStatus(): {
  kind: "memory" | "redis";
  state: "healthy" | "degraded";
  failureCount: number;
  firstFailureAt: number | null;
  lastRecoveredAt: number | null;
} {
  return {
    kind: store.kind,
    ...redisFailureWatcher.getSnapshot(),
  };
}

/**
 * Lightweight Redis liveness probe used by `/readyz`. Returns:
 *   - `null` when the rate-limit store is in-memory (no Redis to probe).
 *   - `{ ok: true }` when a `PING` round-trips successfully.
 *   - `{ ok: false, error }` when the ping fails or times out — the
 *     readyz handler surfaces this so on-call can debug without shell.
 *
 * The default timeout is intentionally short (2s) because readiness
 * probes are called frequently by the platform load balancer. Override
 * via `READYZ_REDIS_TIMEOUT_MS` if your network has higher RTT. The
 * env var is sanitised: a missing, non-numeric, zero, or negative
 * value falls back to the 2000ms default rather than producing a NaN
 * timer (which would fire immediately and break every probe).
 */
function readyzRedisTimeoutMs(): number {
  const raw = process.env.READYZ_REDIS_TIMEOUT_MS;
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 2000;
}

export async function pingRateLimitRedis(
  timeoutMs: number = readyzRedisTimeoutMs(),
): Promise<{ ok: true } | { ok: false; error: string } | null> {
  if (!(store instanceof RedisStore)) return null;
  try {
    await store.ping(timeoutMs);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export const __test__ = {
  resolveTier,
  store,
  InMemoryStore,
  RedisStore,
  RedisFailureWatcher,
  redisFailureWatcher,
  normaliseRateLimitStoreKind,
};
