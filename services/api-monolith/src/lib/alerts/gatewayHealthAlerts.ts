import { logger } from "../logger";
import {
  WebhookSubsystemAlertNotifier,
  type SubsystemAlertNotifier,
} from "./subsystemAlertNotifier";

/**
 * Per-gateway state tracker that turns the payment circuit breaker's
 * raw open/close events into clean healthy↔degraded transitions
 * suitable for paging on-call.
 *
 * Why this lives separately from the rate-limit incident notifier:
 * the rate-limit store has its own bespoke streak detector
 * (`RedisFailureWatcher`) tied to per-call success/failure events. The
 * payment router doesn't expose anything similar — it just calls
 * `HealthStore.openCircuit(name, until)` whenever the rolling failure
 * rate crosses the threshold, with no explicit "circuit closed"
 * notification (recovery is implicit when the `until` timestamp
 * passes). This module bridges that gap by:
 *
 *   1. Treating an `openCircuit` call as healthy → degraded only when
 *      the previous `circuitOpenUntil` was either null or already in
 *      the past. Subsequent `openCircuit` calls while the breaker is
 *      still open are extensions of the same incident and do NOT
 *      re-page (matching the rate-limit notifier's "page exactly once
 *      per healthy→degraded transition" semantics).
 *
 *   2. Detecting recovery on the first successful `record(name, true)`
 *      observed after the breaker timestamp has passed AND we
 *      previously paged degraded for this gateway. PagerDuty's shared
 *      `dedup_key` makes the resolve a no-op if no trigger ever
 *      fired, which keeps a transient flap under the cooldown safe.
 *
 *   3. Applying a per-gateway flap cooldown so a breaker that
 *      open-closes-open repeatedly inside one minute pages once, not
 *      once per cycle. Configurable via
 *      `GATEWAY_ALERT_COOLDOWN_MS` (default 60s).
 *
 * The tracker holds state in-process. Each api-server replica observes
 * its own `recordAndMaybeTrip` calls, so on a multi-replica deploy
 * each replica may emit one degraded page on the first transition it
 * sees. PagerDuty's `dedup_key` (built from
 * `subsystem-degraded:payment-gateway:<name>:<source>`) groups them
 * by source — operators get one PagerDuty incident per replica per
 * gateway, which matches how the rate-limit alerts already behave and
 * is the correct granularity (a single replica's view of the breaker
 * is the actionable signal; a "global" cross-replica state would
 * require a separate consensus mechanism that doesn't exist today).
 */
export interface GatewayCircuitMonitor {
  /**
   * Called from `DbHealthStore.openCircuit` BEFORE the database row is
   * updated. `previousOpenUntilMs` is the prior `circuit_open_until`
   * value (null if unset). `nextOpenUntilMs` is the new value. The
   * tracker decides whether this is a healthy→degraded transition
   * worth paging on.
   */
  notifyCircuitOpened(
    gateway: string,
    previousOpenUntilMs: number | null,
    nextOpenUntilMs: number,
    now?: number,
  ): void;

  /**
   * Called from `DbHealthStore.record` after every gateway op. When
   * the op succeeded AND we previously paged this gateway as degraded
   * AND the breaker has expired, we emit a paired recovery page.
   */
  observeRecord(
    gateway: string,
    ok: boolean,
    previousOpenUntilMs: number | null,
    now?: number,
  ): void;

  /** Test-only: reset internal state between cases. */
  __reset(): void;
}

interface GatewayState {
  /**
   * ms epoch when we last paged degraded for this gateway. null until
   * the first page. Used both for cooldown gating and as the implicit
   * "is this gateway in the degraded state from our point of view"
   * flag (when null we have not paged, so recovery has nothing to
   * resolve).
   */
  degradedNotifiedAt: number | null;
  /**
   * The `firstFailureAt` we surfaced in the last degraded page, kept
   * so the recovery payload can report a meaningful `durationMs`.
   */
  degradedSinceMs: number | null;
  /**
   * Most recent breaker `circuitOpenUntil` we observed. Used to
   * suppress duplicate degraded pages while the breaker is still open
   * AND to detect "the breaker has expired AND a success arrived" as
   * the recovery edge.
   */
  lastOpenUntilMs: number | null;
  /**
   * Most recent recovery page time. Combined with `degradedNotifiedAt`
   * for the per-gateway cooldown so a flapping breaker can't re-page
   * within the cooldown window.
   */
  recoveredNotifiedAt: number | null;
}

function emptyState(): GatewayState {
  return {
    degradedNotifiedAt: null,
    degradedSinceMs: null,
    lastOpenUntilMs: null,
    recoveredNotifiedAt: null,
  };
}

function readCooldownMs(env: NodeJS.ProcessEnv): number {
  const raw = env.GATEWAY_ALERT_COOLDOWN_MS;
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 60_000;
}

interface MonitorOptions {
  notifier?: SubsystemAlertNotifier;
  /** Cooldown override (tests). Defaults to env / 60s. */
  cooldownMs?: number;
  /** Frozen env snapshot for tests. */
  env?: NodeJS.ProcessEnv;
}

class GatewayCircuitMonitorImpl implements GatewayCircuitMonitor {
  private readonly notifier: SubsystemAlertNotifier;
  private readonly cooldownMs: number;
  private readonly states: Map<string, GatewayState> = new Map();

  constructor(opts: MonitorOptions = {}) {
    this.notifier = opts.notifier ?? new WebhookSubsystemAlertNotifier();
    this.cooldownMs =
      opts.cooldownMs ?? readCooldownMs(opts.env ?? process.env);
  }

  private state(gateway: string): GatewayState {
    let s = this.states.get(gateway);
    if (!s) {
      s = emptyState();
      this.states.set(gateway, s);
    }
    return s;
  }

  notifyCircuitOpened(
    gateway: string,
    previousOpenUntilMs: number | null,
    nextOpenUntilMs: number,
    now: number = Date.now(),
  ): void {
    const s = this.state(gateway);
    // Was the breaker effectively open RIGHT NOW (from our last
    // observation) before this call? If yes, this is just an extension
    // of the same incident — the router re-trips after every
    // recordAndMaybeTrip when the failure rate stays above threshold.
    // We deliberately use the cached `lastOpenUntilMs` rather than
    // `previousOpenUntilMs` from the DB row because the DB row may
    // already reflect a concurrent extension from a sibling replica;
    // our local view is what we paged on, and that's what should
    // gate further pages from this process.
    const wasOpenLocally =
      s.lastOpenUntilMs !== null && s.lastOpenUntilMs > now;
    // The DB row tells us what the global state was prior to this
    // update — if it's still open globally we're definitely in an
    // ongoing incident. Combining both views (local + DB) avoids
    // double-paging when our local cache hasn't been initialised yet
    // (e.g. process just booted into an incident already in progress).
    const wasOpenGlobally =
      previousOpenUntilMs !== null && previousOpenUntilMs > now;
    s.lastOpenUntilMs = nextOpenUntilMs;
    if (wasOpenLocally || wasOpenGlobally) {
      // Extension, not a new transition. Don't re-page.
      return;
    }
    // Cooldown gate: if we paged degraded recently for this gateway
    // (and either haven't recovered or recovered very recently),
    // suppress this page so a flapping breaker doesn't spam on-call.
    // We use max(degradedNotifiedAt, recoveredNotifiedAt) as the
    // "last activity" anchor — once cooldown passes without further
    // activity, the next degraded transition pages normally.
    const lastActivity = Math.max(
      s.degradedNotifiedAt ?? 0,
      s.recoveredNotifiedAt ?? 0,
    );
    if (lastActivity > 0 && now - lastActivity < this.cooldownMs) {
      logger.warn(
        {
          gateway,
          msSinceLast: now - lastActivity,
          cooldownMs: this.cooldownMs,
        },
        "gateway_alert_degraded_suppressed_by_cooldown",
      );
      return;
    }
    s.degradedNotifiedAt = now;
    s.degradedSinceMs = now;
    try {
      this.notifier.notifyDegraded({
        subsystem: `payment-gateway:${gateway}`,
        label: `${gateway} payment gateway`,
        firstFailureAt: now,
        detectedAt: now,
        details: {
          gateway,
          circuitOpenUntilIso: new Date(nextOpenUntilMs).toISOString(),
        },
      });
    } catch (err) {
      logger.warn(
        { gateway, err: (err as Error).message },
        "gateway_alert_notify_degraded_threw",
      );
    }
  }

  observeRecord(
    gateway: string,
    ok: boolean,
    previousOpenUntilMs: number | null,
    now: number = Date.now(),
  ): void {
    const s = this.state(gateway);
    // Keep our local view of the breaker's `until` in sync with the DB
    // row so subsequent `notifyCircuitOpened` calls can decide whether
    // they're an extension or a new transition. We deliberately do NOT
    // overwrite `lastOpenUntilMs` if the DB row's value is older than
    // what we've already seen — once the breaker is set we want to
    // respect the longest scheduled open window.
    if (
      previousOpenUntilMs !== null &&
      (s.lastOpenUntilMs === null || previousOpenUntilMs > s.lastOpenUntilMs)
    ) {
      s.lastOpenUntilMs = previousOpenUntilMs;
    }
    if (!ok) return;
    if (s.degradedNotifiedAt === null) return; // We never paged for this.
    // Recovery edge: a successful op AND the breaker has expired.
    // Recovery may also be triggered by the breaker simply timing
    // out without a success arriving — we deliberately wait for the
    // success because that's the operator-meaningful signal: "the
    // gateway is processing payments again", not just "5 minutes
    // have passed since the trip". The latter could fire while the
    // gateway is still down (the breaker just hasn't been re-tripped
    // yet because no requests have landed).
    const breakerStillOpen =
      s.lastOpenUntilMs !== null && s.lastOpenUntilMs > now;
    if (breakerStillOpen) return;
    // Cooldown gate: if we recovered very recently and a flap re-paged,
    // we may still be inside the recovery suppression window. Honour
    // the same per-gateway cooldown so the resolve doesn't immediately
    // follow the trigger inside one minute.
    if (
      s.recoveredNotifiedAt !== null &&
      now - s.recoveredNotifiedAt < this.cooldownMs
    ) {
      return;
    }
    const startedAt = s.degradedSinceMs ?? s.degradedNotifiedAt ?? now;
    const durationMs = Math.max(0, now - startedAt);
    s.recoveredNotifiedAt = now;
    s.degradedNotifiedAt = null;
    s.degradedSinceMs = null;
    s.lastOpenUntilMs = null;
    try {
      this.notifier.notifyRecovered({
        subsystem: `payment-gateway:${gateway}`,
        label: `${gateway} payment gateway`,
        recoveredAt: now,
        durationMs,
        details: { gateway },
      });
    } catch (err) {
      logger.warn(
        { gateway, err: (err as Error).message },
        "gateway_alert_notify_recovered_threw",
      );
    }
  }

  __reset(): void {
    this.states.clear();
  }
}

/**
 * Process-wide singleton wired into `lib/payments.ts`. Tests construct
 * their own monitor via `createGatewayCircuitMonitor` so they can
 * inject a stub notifier without touching this singleton's state.
 */
export const gatewayCircuitMonitor: GatewayCircuitMonitor =
  new GatewayCircuitMonitorImpl();

export function createGatewayCircuitMonitor(
  opts: MonitorOptions = {},
): GatewayCircuitMonitor {
  return new GatewayCircuitMonitorImpl(opts);
}
