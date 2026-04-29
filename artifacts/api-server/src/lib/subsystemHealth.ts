/**
 * Generic subsystem failure-streak watcher used by /healthz.
 *
 * The api-server has multiple backing subsystems whose health can
 * "burn slowly" without breaking liveness: the rate-limit Redis store
 * (handled by RedisFailureWatcher in apiRateLimit.ts), the primary
 * Postgres connection, and — in future — the audit chain queue and
 * payment-gateway circuit breakers. Each one needs the same streak
 * bookkeeping so that:
 *
 *   1. /healthz can expose `{ state, firstFailureAt, ... }` for every
 *      subsystem on a stable schema.
 *   2. The duration-based stuck-degraded probe
 *      (`scripts/checkHealthzDegraded.ts`) can iterate over them and
 *      page when any single subsystem has been stuck for too long.
 *
 * RedisFailureWatcher in apiRateLimit.ts deliberately stays separate
 * because it also runs the per-minute Sentry breach detector that's
 * specific to the rate-limit-degrades-open semantics. The shape of its
 * snapshot intentionally matches the snapshot returned by this class
 * so /healthz consumers see one uniform schema across all subsystems.
 */
export interface SubsystemSnapshot {
  state: "healthy" | "degraded";
  failureCount: number;
  firstFailureAt: number | null;
  lastRecoveredAt: number | null;
}

export class SubsystemFailureWatcher {
  private firstFailureAt: number | null = null;
  private failuresSinceFirstFailure = 0;
  private lastRecoveredAt: number | null = null;

  /**
   * Record a failure observation. The first failure stamps
   * `firstFailureAt`; subsequent failures within the same streak just
   * bump the count. The streak is closed by `recordSuccess`.
   */
  record(now: number = Date.now()): void {
    if (this.firstFailureAt === null) {
      this.firstFailureAt = now;
      this.failuresSinceFirstFailure = 0;
    }
    this.failuresSinceFirstFailure += 1;
  }

  /**
   * Record a success observation. Closes any in-progress streak and
   * stamps `lastRecoveredAt` so dashboards can see when the subsystem
   * last came back without grepping logs.
   */
  recordSuccess(now: number = Date.now()): void {
    if (this.firstFailureAt !== null) {
      this.lastRecoveredAt = now;
    }
    this.firstFailureAt = null;
    this.failuresSinceFirstFailure = 0;
  }

  /**
   * Read-only snapshot for /healthz. Shape matches
   * RedisFailureWatcher.getSnapshot() so the on-the-wire schema is
   * uniform across subsystems.
   */
  getSnapshot(): SubsystemSnapshot {
    return {
      state: this.firstFailureAt === null ? "healthy" : "degraded",
      failureCount: this.failuresSinceFirstFailure,
      firstFailureAt: this.firstFailureAt,
      lastRecoveredAt: this.lastRecoveredAt,
    };
  }

  /** Test-only: reset internal counters between cases. */
  __reset(): void {
    this.firstFailureAt = null;
    this.failuresSinceFirstFailure = 0;
    this.lastRecoveredAt = null;
  }

  /**
   * Test/rehearsal-only: seed an in-progress failure streak directly,
   * bypassing the normal `record()` path. Used by the staging-only
   * rehearsal route (`routes/healthzRehearsal.ts`) to flip a subsystem
   * into a synthetic `degraded` state with a `firstFailureAt` older
   * than the duration alert's threshold so the
   * `checkHealthzDegraded` probe will exit 2 against staging without
   * having to actually break the underlying dependency.
   *
   * Production code paths must NEVER call this — it is gated at the
   * route layer (HEALTHZ_REHEARSAL_ENABLED=1 + token) so a misuse
   * here would only ever surface in staging anyway, but keep the
   * contract explicit.
   */
  __injectStreak(firstFailureAt: number, failureCount: number): void {
    this.firstFailureAt = firstFailureAt;
    this.failuresSinceFirstFailure = Math.max(1, Math.floor(failureCount));
  }
}

/**
 * Singleton watcher for the primary Postgres connection. Driven by the
 * /readyz DB probe — every probe call records either success or
 * failure, which gives the watcher a steady heartbeat without any
 * extra background polling. The /readyz cadence is set by the platform
 * load balancer (typically O(seconds)), which is fine resolution for a
 * "stuck for many minutes" alert.
 *
 * We do NOT also feed this from per-request DB errors: that would
 * conflate "this one query failed" with "the connection pool can't
 * reach the DB", and the probe is meant to surface the latter.
 */
export const dbHealthWatcher = new SubsystemFailureWatcher();

/**
 * Singleton watcher for the audit-event pipeline. Driven by every
 * `recordAudit` call in `lib/audit.ts`: a successful chain-extend
 * closes any in-progress streak, a failure (caught in audit.ts so
 * the user-facing request never breaks) opens or extends one.
 *
 * Why this matters: `recordAudit` is intentionally best-effort — a
 * failed audit insert is logged, dead-lettered into `audit_failures`,
 * and the request that triggered it still succeeds. Without a
 * dedicated watcher that "best-effort" path can silently swallow a
 * sustained DB-pressure outage where every audit write is failing
 * (and every fallback DLQ insert is also failing) for many minutes
 * before anyone notices, leaving a NDPR/PCI compliance gap that
 * never trips the existing duration alert. Wiring the streak into
 * /healthz under `subsystems.auditChain` lets the same probe that
 * pages on a stuck rate-limit store or DB pool also page on a stuck
 * audit pipeline — no extra background polling, no separate alert
 * surface to wire up.
 *
 * We do NOT page on a single isolated failure: the
 * `checkHealthzDegraded` probe only fires once `now - firstFailureAt`
 * exceeds the duration threshold, so a one-off transient (the kind
 * `recordAudit` is designed to swallow) self-heals on the next
 * successful write without ever paging.
 */
export const auditHealthWatcher = new SubsystemFailureWatcher();
