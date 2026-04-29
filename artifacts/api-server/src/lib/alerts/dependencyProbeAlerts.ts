import { logger } from "../logger";
import type { DependencyProbeName, PingResult } from "../dependencyProbes";
import {
  WebhookSubsystemAlertNotifier,
  type SubsystemAlertNotifier,
} from "./subsystemAlertNotifier";

/**
 * Per-probe streak monitor that turns the optional `/readyz`
 * dependency-probe results (Clerk, Paystack, Flutterwave) into clean
 * healthy↔degraded transitions suitable for paging on-call.
 *
 * Why this lives separately from `gatewayHealthAlerts.ts`:
 * the gateway monitor wraps the in-DB circuit breaker (open/close
 * events on the `gateway_health` row), which is driven by the rolling
 * failure rate of *real customer traffic*. The dependency probes are
 * synthetic GETs against the provider's base URL — they catch the
 * "the platform LB drained the replica because the probe started
 * failing" failure mode, which can happen even when no real customer
 * payment has yet been attempted (e.g. early in the morning before
 * the first checkout). Coupling the two would either:
 *
 *   - silence the synthetic probe's page when the gateway alert was
 *     already open (bad — the synthetic probe is the early warning),
 *   - or double-page (bad — operators would have to figure out which
 *     of two open incidents was the one to act on).
 *
 * Keeping them as two independent monitors with different `subsystem`
 * ids (`payment-gateway:<name>` vs `dependency-probe:<name>`) means
 * PagerDuty's `dedup_key` handles the dedupe naturally and operators
 * see distinct incidents that they can correlate via the gateway
 * name.
 *
 * Streak / debounce semantics:
 *
 *   1. A single 503 does NOT page. Every readyz call records either
 *      `ok` or `failed` for each enabled probe; we only emit
 *      `notifyDegraded` after `>= threshold` (default 3) consecutive
 *      failures with the same probe key. This matches the task ask
 *      "> N consecutive 503s with the same `failures.<name>` key".
 *      A single transient blip — a TLS handshake renegotiation, a
 *      brief packet loss event — is the case the threshold is meant
 *      to swallow.
 *
 *   2. We page exactly once per healthy→degraded transition. While
 *      the streak stays open, every subsequent failure increments the
 *      count and updates the latest failure marker (so an operator
 *      polling /healthz sees the freshest one) but does NOT re-page.
 *      Same edge semantics as the rate-limit incident notifier and
 *      the gateway monitor.
 *
 *   3. A single `ok` result clears the streak. If we previously paged
 *      degraded for this probe, that ok result is the recovery edge
 *      and we emit `notifyRecovered`. PagerDuty's shared `dedup_key`
 *      auto-closes the matching incident.
 *
 *   4. A `skipped` result (the probe was disabled mid-incident via
 *      the env-flag escape hatch — see the runbook) is treated as
 *      recovery if we had previously paged: the operator's intent is
 *      "stop alerting on this until I re-enable the probe", so
 *      keeping a PagerDuty incident open after they flipped the kill
 *      switch would be worse than auto-resolving. State is reset to
 *      clean so re-enabling the probe later starts a fresh streak.
 *
 *   5. A per-probe cooldown (default 60s) prevents a flapping
 *      dependency from spamming the channel. After a recovery (or a
 *      degraded page), we suppress the next degraded page if it
 *      arrives within the cooldown window. The streak counter still
 *      advances so the next legitimate trip — once cooldown has
 *      passed — does page.
 *
 * Configuration (read at observe time so a hot env-var rotation is
 * picked up by the next probe — matches the readyz-config and
 * subsystem-alert patterns elsewhere in the codebase):
 *
 *   - `DEPENDENCY_PROBE_ALERT_THRESHOLD`     — N consecutive failures
 *     before paging (default 3, sanitised to >= 1).
 *   - `DEPENDENCY_PROBE_ALERT_COOLDOWN_MS`   — per-probe cooldown
 *     window in ms (default 60_000, sanitised to >= 0).
 *   - `DEPENDENCY_PROBE_ALERT_RUNBOOK_URL`   — base URL for the
 *     runbook link attached to each page. Defaults to the in-repo
 *     anchor on the in-incident escape hatch section so on-call
 *     immediately sees how to disable the probe.
 *
 * Pure-ish: the singleton `dependencyProbeAlertMonitor` reads
 * `process.env` on every `observe` call, but the `createDependencyProbeAlertMonitor`
 * factory accepts a frozen env snapshot AND an injected notifier so
 * tests can drive every transition without touching global state.
 */

const DEFAULT_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 60_000;
const DEFAULT_RUNBOOK_URL =
  "docs/runbooks/readyz-dependency-probes.md#in-incident-escape-hatch-the-circuit-breaker";

function parseThreshold(env: NodeJS.ProcessEnv): number {
  const raw = env.DEPENDENCY_PROBE_ALERT_THRESHOLD;
  const n = raw === undefined ? NaN : Number(raw);
  // The threshold MUST be >= 1: 0 would page on every single failure
  // (including the first transient blip the threshold exists to
  // swallow), defeating the entire debounce purpose. Negative /
  // non-numeric values fall back to the default for the same reason
  // we sanitise the readyz timeouts — a malformed value is far more
  // likely a typo than a deliberate "page on every blip" choice.
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_THRESHOLD;
}

function parseCooldownMs(env: NodeJS.ProcessEnv): number {
  const raw = env.DEPENDENCY_PROBE_ALERT_COOLDOWN_MS;
  const n = raw === undefined ? NaN : Number(raw);
  // Cooldown of 0 is a deliberate "no debounce, page on every
  // healthy↔degraded transition" choice; we accept it. Negative /
  // non-numeric values fall back to 60s — same sanitisation
  // philosophy as the threshold above.
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_COOLDOWN_MS;
}

function parseRunbookUrl(env: NodeJS.ProcessEnv): string {
  const raw = env.DEPENDENCY_PROBE_ALERT_RUNBOOK_URL;
  if (raw === undefined) return DEFAULT_RUNBOOK_URL;
  const trimmed = raw.trim();
  return trimmed === "" ? DEFAULT_RUNBOOK_URL : trimmed;
}

/**
 * Per-probe state. Held in-process; each api-server replica observes
 * its own `/readyz` calls so the streak counter is per-replica. That
 * matches how the platform LB consumes the readyz signal — a probe
 * failing on replica A is a "drain replica A" event, independent of
 * replica B's view. PagerDuty's `dedup_key` (built from
 * `dependency-probe:<name>:<source>`) groups them per replica so
 * operators see one incident per replica per probe, not one per
 * replica per failure.
 *
 * Important separation: `incidentOpen` tracks whether a degraded
 * notification was *actually emitted* and is awaiting its paired
 * recovery. `degradedNotifiedAt` / `recoveredNotifiedAt` only ever
 * record the timestamps of *real* notifications — they are NOT used
 * to gate "have we considered this transition before". An earlier
 * version of this monitor mutated `degradedNotifiedAt` when a
 * threshold-crossing failure was suppressed by cooldown, which had
 * two regressions: (a) the gate-on-`degradedNotifiedAt` early return
 * then short-circuited every subsequent failure in that streak so
 * the incident never paged even after cooldown elapsed, and
 * (b) the next `ok`/`skipped` result emitted a recovery for an
 * incident that was never opened, producing phantom resolves in
 * PagerDuty. Both regressions are now covered by dedicated
 * regression tests.
 */
interface ProbeState {
  /** Number of consecutive failures observed since the last `ok`. */
  consecutiveFailures: number;
  /** ms epoch when the current streak began (null when none). */
  firstFailureAt: number | null;
  /**
   * The most recent `failures.<name>` marker observed during this
   * streak (e.g. `http_probe_timeout_after_2000ms`). Surfaced in the
   * page payload so on-call sees the freshest cause without grepping
   * logs.
   */
  lastFailureMarker: string | null;
  /**
   * True iff a degraded notification was actually emitted for the
   * current streak and the matching recovery hasn't been emitted
   * yet. Drives:
   *   - "exactly once per healthy→degraded transition" (skip the
   *     notify path on subsequent failures),
   *   - "only emit recovery for an incident we actually opened" (so
   *     a cooldown-suppressed trip followed by ok does NOT fire a
   *     phantom resolve).
   */
  incidentOpen: boolean;
  /**
   * ms epoch of the most recent ACTUAL degraded notification. Used
   * for the cooldown gate and exposed via `getState` for operator
   * surfaces. Cleared back to null is intentional — after a recovery
   * we keep the timestamp because the cooldown anchors on it; we
   * only update it when a real degraded notification is emitted.
   */
  degradedNotifiedAt: number | null;
  /** ms epoch of the most recent ACTUAL recovered notification. */
  recoveredNotifiedAt: number | null;
}

function emptyState(): ProbeState {
  return {
    consecutiveFailures: 0,
    firstFailureAt: null,
    lastFailureMarker: null,
    incidentOpen: false,
    degradedNotifiedAt: null,
    recoveredNotifiedAt: null,
  };
}

/**
 * Snapshot of the per-probe streak state, exposed for tests and any
 * future operator surface that wants to render "you're 2/3 of the way
 * to a page". Read-only — mutating the returned object does NOT
 * change the monitor's internal state.
 */
export interface ProbeStateSnapshot {
  consecutiveFailures: number;
  firstFailureAt: number | null;
  lastFailureMarker: string | null;
  /**
   * True iff a degraded page was actually emitted for the current
   * streak and the matching recovery has not yet been emitted.
   * Independent of `degradedNotifiedAt` — see comment on
   * `ProbeState.incidentOpen` for why.
   */
  incidentOpen: boolean;
  /** ms epoch of the most recent ACTUAL degraded notification. */
  degradedNotifiedAt: number | null;
  /** ms epoch of the most recent ACTUAL recovered notification. */
  recoveredNotifiedAt: number | null;
}

export interface DependencyProbeAlertMonitor {
  /**
   * Called once per probe per `/readyz` invocation with the result of
   * `pingDependency(name)`. `null` is the "skipped" case (the env
   * flag is not `"1"`). The monitor decides whether this transition
   * crosses the page-on-call threshold and, if so, fires
   * `notifyDegraded` / `notifyRecovered` exactly once per edge.
   *
   * `now` is injectable so tests can drive deterministic streak
   * timings without `vi.useFakeTimers`.
   */
  observe(
    name: DependencyProbeName,
    result: PingResult | null,
    now?: number,
  ): void;

  /** Read-only snapshot of a probe's current state. */
  getState(name: DependencyProbeName): ProbeStateSnapshot;

  /** Test-only: reset internal state between cases. */
  __reset(): void;
}

interface MonitorOptions {
  notifier?: SubsystemAlertNotifier;
  /** Threshold override for tests. Defaults to env / 3. */
  threshold?: number;
  /** Cooldown override for tests. Defaults to env / 60s. */
  cooldownMs?: number;
  /** Runbook URL override for tests. Defaults to env / built-in anchor. */
  runbookUrl?: string;
  /** Frozen env snapshot for tests. */
  env?: NodeJS.ProcessEnv;
}

class DependencyProbeAlertMonitorImpl implements DependencyProbeAlertMonitor {
  private readonly notifier: SubsystemAlertNotifier;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly runbookUrl: string;
  private readonly states: Map<DependencyProbeName, ProbeState> = new Map();

  constructor(opts: MonitorOptions = {}) {
    const env = opts.env ?? process.env;
    this.notifier = opts.notifier ?? new WebhookSubsystemAlertNotifier();
    this.threshold = opts.threshold ?? parseThreshold(env);
    this.cooldownMs = opts.cooldownMs ?? parseCooldownMs(env);
    this.runbookUrl = opts.runbookUrl ?? parseRunbookUrl(env);
  }

  private state(name: DependencyProbeName): ProbeState {
    let s = this.states.get(name);
    if (!s) {
      s = emptyState();
      this.states.set(name, s);
    }
    return s;
  }

  getState(name: DependencyProbeName): ProbeStateSnapshot {
    const s = this.state(name);
    return {
      consecutiveFailures: s.consecutiveFailures,
      firstFailureAt: s.firstFailureAt,
      lastFailureMarker: s.lastFailureMarker,
      incidentOpen: s.incidentOpen,
      degradedNotifiedAt: s.degradedNotifiedAt,
      recoveredNotifiedAt: s.recoveredNotifiedAt,
    };
  }

  observe(
    name: DependencyProbeName,
    result: PingResult | null,
    now: number = Date.now(),
  ): void {
    const s = this.state(name);
    if (result === null) {
      this.handleSkipped(name, s, now);
      return;
    }
    if (result.ok) {
      this.handleSuccess(name, s, now);
      return;
    }
    this.handleFailure(name, s, result.error, now);
  }

  /**
   * Disabled-via-env-flag path. If we have an incident currently
   * open (i.e. we DID emit a degraded page that hasn't been
   * resolved yet), the operator's intent in flipping the flag is
   * "stop alerting" — we honour that by emitting recovery so
   * PagerDuty's dedup_key closes the open incident, and resetting
   * state so a re-enable starts fresh. If no incident was open
   * (e.g. the probe was disabled before the threshold was crossed,
   * or after a cooldown-suppressed trip), this is a no-op for the
   * notifier — emitting a recovery for an incident that never
   * existed would surface a phantom resolve in PagerDuty.
   */
  private handleSkipped(
    name: DependencyProbeName,
    s: ProbeState,
    now: number,
  ): void {
    if (s.incidentOpen) {
      this.fireRecovered(name, s, now, "probe_disabled_via_env_flag");
    }
    // Always reset streak counters — a re-enable should start a
    // clean streak regardless of whether an incident was open.
    s.consecutiveFailures = 0;
    s.firstFailureAt = null;
    s.lastFailureMarker = null;
  }

  /**
   * Healthy-result path. Closes any open incident (if we actually
   * paged for it) with a paired recovery. Crucially, we gate on
   * `incidentOpen`, NOT on `degradedNotifiedAt`: a streak that
   * crossed threshold but was suppressed by the cooldown never
   * opened an incident, so emitting recovery here would create a
   * phantom resolve.
   *
   * We deliberately do NOT honour the cooldown on recovery — a
   * paired resolve must always follow a real trigger so PagerDuty
   * closes the incident.
   */
  private handleSuccess(
    name: DependencyProbeName,
    s: ProbeState,
    now: number,
  ): void {
    if (s.incidentOpen) {
      this.fireRecovered(name, s, now);
    }
    s.consecutiveFailures = 0;
    s.firstFailureAt = null;
    s.lastFailureMarker = null;
  }

  /**
   * Failed-result path. Increments the streak counter, refreshes
   * the marker, and (when the threshold is crossed without an
   * already-open incident) attempts to page on-call subject to the
   * cooldown gate.
   *
   * Cooldown semantics: we ONLY suppress the notifier call —
   * `incidentOpen` and `degradedNotifiedAt` are NOT mutated. That
   * means a probe that stays failed past the cooldown window pages
   * on the very next observation, instead of being permanently
   * silenced because we marked it "considered" prematurely. (See
   * the regression test
   * `re-trips after recovery only after the cooldown window has elapsed`
   * and `sustained outage in cooldown still pages once cooldown elapses`.)
   *
   * Subsequent failures within an already-open incident update
   * internal state but do NOT re-page, matching "exactly once per
   * healthy→degraded transition".
   */
  private handleFailure(
    name: DependencyProbeName,
    s: ProbeState,
    marker: string,
    now: number,
  ): void {
    s.consecutiveFailures += 1;
    if (s.firstFailureAt === null) s.firstFailureAt = now;
    s.lastFailureMarker = marker;

    if (s.incidentOpen) return; // Already paged this streak.
    if (s.consecutiveFailures < this.threshold) return; // Below threshold.

    // Cooldown gate. Anchored on the most recent ACTUAL paging
    // activity (real degraded OR real recovery) so a flapping probe
    // can't re-page within the cooldown window. Mirrors
    // `gatewayHealthAlerts`.
    const lastActivity = Math.max(
      s.degradedNotifiedAt ?? 0,
      s.recoveredNotifiedAt ?? 0,
    );
    if (lastActivity > 0 && now - lastActivity < this.cooldownMs) {
      logger.warn(
        {
          probe: name,
          consecutiveFailures: s.consecutiveFailures,
          msSinceLast: now - lastActivity,
          cooldownMs: this.cooldownMs,
        },
        "dependency_probe_alert_degraded_suppressed_by_cooldown",
      );
      // Deliberately do NOT mutate `incidentOpen` or
      // `degradedNotifiedAt` here — see method-level comment.
      return;
    }

    s.incidentOpen = true;
    s.degradedNotifiedAt = now;
    try {
      this.notifier.notifyDegraded({
        subsystem: `dependency-probe:${name}`,
        label: `${name} dependency probe`,
        firstFailureAt: s.firstFailureAt ?? now,
        detectedAt: now,
        runbookUrl: this.runbookUrl,
        details: {
          probe: name,
          // The `failures.<name>` marker the task explicitly calls out
          // — surfaced as a top-level Slack field so on-call sees the
          // freshest cause (e.g. `http_probe_timeout_after_2000ms`
          // vs `getaddrinfo ENOTFOUND`) without grepping logs.
          failureMarker: marker,
          consecutiveFailures: s.consecutiveFailures,
          threshold: this.threshold,
        },
      });
    } catch (err) {
      logger.warn(
        { probe: name, err: (err as Error).message },
        "dependency_probe_alert_notify_degraded_threw",
      );
    }
  }

  /**
   * Internal recovery path shared between `handleSuccess` and
   * `handleSkipped`. Only callable when `incidentOpen` is true
   * (callers gate on it). Builds the recovery event, fires it, and
   * clears `incidentOpen`. `degradedNotifiedAt` is preserved so the
   * cooldown gate after this recovery anchors on the original
   * trigger time.
   */
  private fireRecovered(
    name: DependencyProbeName,
    s: ProbeState,
    now: number,
    extraMarker?: string,
  ): void {
    const startedAt = s.firstFailureAt ?? s.degradedNotifiedAt ?? now;
    const durationMs = Math.max(0, now - startedAt);
    s.recoveredNotifiedAt = now;
    s.incidentOpen = false;
    try {
      this.notifier.notifyRecovered({
        subsystem: `dependency-probe:${name}`,
        label: `${name} dependency probe`,
        recoveredAt: now,
        durationMs,
        runbookUrl: this.runbookUrl,
        details: {
          probe: name,
          // Surface the marker that ended the streak — most useful
          // when the operator disabled the probe (extraMarker is
          // `probe_disabled_via_env_flag`); for a real recovery the
          // last failure marker tells you what was failing right
          // before the dependency recovered.
          lastFailureMarker:
            extraMarker ?? s.lastFailureMarker ?? "probe_recovered",
        },
      });
    } catch (err) {
      logger.warn(
        { probe: name, err: (err as Error).message },
        "dependency_probe_alert_notify_recovered_threw",
      );
    }
  }

  __reset(): void {
    this.states.clear();
  }
}

/**
 * Process-wide singleton wired into `routes/health.ts`'s `/readyz`
 * handler. Tests construct their own monitor via
 * `createDependencyProbeAlertMonitor` so they can inject a stub
 * notifier without touching this singleton's state.
 */
export const dependencyProbeAlertMonitor: DependencyProbeAlertMonitor =
  new DependencyProbeAlertMonitorImpl();

export function createDependencyProbeAlertMonitor(
  opts: MonitorOptions = {},
): DependencyProbeAlertMonitor {
  return new DependencyProbeAlertMonitorImpl(opts);
}
