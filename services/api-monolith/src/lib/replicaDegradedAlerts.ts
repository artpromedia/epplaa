import { logger } from "./logger";
import { captureMessage } from "./sentry";

/**
 * Server-side dedup + Sentry fan-out for "the admin status panel
 * (artifacts/admin-console/src/pages/status.tsx) saw a degraded
 * replica for more than one consecutive poll" reports.
 *
 * Why this lives on the server:
 *   - The panel is the only thing actively probing every replica
 *     behind the load balancer (it fires several parallel /readyz
 *     requests per cycle so the LB's round-robin samples every
 *     replica). That's the canonical cross-replica degradation
 *     signal we have today, but until this module shipped it only
 *     reached on-call when an operator happened to be looking at
 *     /admin/status.
 *   - Multiple operators may have the panel open simultaneously
 *     (incident triage, weekend on-call, post-deploy watch). Each of
 *     their browsers will independently see the same degraded
 *     replica and try to alert. If every browser fanned out to
 *     Sentry directly we'd multiply the page count by the number of
 *     open tabs, which is exactly the noise pattern this whole
 *     alerting layer exists to avoid. The dedup table here is what
 *     squashes those reports into a single Sentry event per outage
 *     window per replica.
 *
 * Dedup contract:
 *   - Keyed by `replicaId` (the same `replicaId` field the panel
 *     groups on, sourced from /healthz + /readyz; falls back to
 *     `pid:<n>` on dev replicas without a platform-set HOSTNAME).
 *   - The first degraded report for a replicaId fires Sentry exactly
 *     once. Subsequent reports inside the same outage are silenced
 *     until either:
 *       a) `reportRecovered` is called for that replicaId (closing
 *          the open alert), OR
 *       b) `REPLICA_DEGRADED_ALERT_COOLDOWN_MS` (default 10 min) has
 *          elapsed since the last Sentry emit — at which point we
 *          re-emit so a long-running outage doesn't go silent if
 *          on-call mutes the original Sentry issue. Mirrors the
 *          rate-limit Sentry breach cooldown semantics so the two
 *          alert pipes feel the same to operators.
 *   - A Sentry `fingerprint` of `["admin_status_panel_replica_degraded",
 *     replicaId]` groups every per-replica re-emit into the same
 *     Sentry issue, so the cooldown re-emit lands as a comment on
 *     the open issue instead of opening a new one. This also matches
 *     the `audit_chain_tamper_detected` fingerprint pattern in
 *     lib/auditChainVerifier.ts.
 *
 * Stale cleanup:
 *   - Open alerts that haven't been re-reported in
 *     `REPLICA_DEGRADED_ALERT_STALE_AFTER_MS` (default 30 min) are
 *     dropped on the next call. This protects the in-memory map
 *     from unbounded growth when a replica is killed mid-outage and
 *     never explicitly reports recovery (matches the panel's own
 *     `REPLICA_STALE_AFTER_MS` cleanup semantics in spirit).
 *
 * State scope:
 *   - In-memory per api-server replica. That's intentionally not
 *     redis-backed: the dedup window is short (10 min), and a
 *     cross-replica dedup would require coordination on every POST
 *     for what is by design a low-volume signal. In multi-replica
 *     deploys two operators reporting to two different api-server
 *     replicas could in the worst case produce two Sentry events
 *     for the same outage; we accept that as a (rare) bound on the
 *     paging amplification rather than a per-tab amplification, and
 *     the shared Sentry `fingerprint` still groups them into one
 *     issue. If this becomes noisy in practice, swap the Map for a
 *     redis-backed setnx on `replica-degraded:<id>` with the same
 *     cooldown TTL.
 */

export interface ReplicaDegradedAlertConfig {
  cooldownMs: number;
  staleAfterMs: number;
}

const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000;

function parsePositiveIntMs(
  raw: string | undefined,
  fallbackMs: number,
): number {
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallbackMs;
}

export function getReplicaDegradedAlertConfig(
  env: NodeJS.ProcessEnv = process.env,
): ReplicaDegradedAlertConfig {
  return {
    cooldownMs: parsePositiveIntMs(
      env.REPLICA_DEGRADED_ALERT_COOLDOWN_MS,
      DEFAULT_COOLDOWN_MS,
    ),
    staleAfterMs: parsePositiveIntMs(
      env.REPLICA_DEGRADED_ALERT_STALE_AFTER_MS,
      DEFAULT_STALE_AFTER_MS,
    ),
  };
}

export interface ReplicaDegradedReport {
  replicaId: string;
  /** HTTP status code the panel observed from /readyz for this replica. */
  httpStatus: number;
  /**
   * The names of checks that were `failed` in the /readyz body. Surfaced
   * separately from `failures` so on-call can scan the failing
   * dependency list without parsing the full failures map.
   */
  failingChecks: string[];
  /** The /readyz body's `failures` map, copied verbatim. */
  failures: Record<string, string>;
  /**
   * Optional consecutive-poll count the panel observed before deciding
   * to report. Echoed in the Sentry payload so on-call can see whether
   * this was the second consecutive poll (the threshold) or a sustained
   * outage that the panel has been watching for many cycles.
   */
  consecutivePolls?: number;
}

export interface ReplicaRecoveredReport {
  replicaId: string;
}

export interface ReplicaDegradedReportOutcome {
  /** True when this report fired a fresh Sentry event. */
  emitted: boolean;
  /**
   * Reason the report was deduped (when `emitted === false`). One of:
   *   - "within_cooldown" — open alert exists, not yet past cooldown.
   * Always undefined when `emitted === true`.
   */
  dedupReason?: "within_cooldown";
  /** Replica id this report was attributed to. Echoed for the route. */
  replicaId: string;
}

export interface ReplicaRecoveredReportOutcome {
  /** True when an open alert was closed (Sentry recovery emitted). */
  emitted: boolean;
  replicaId: string;
}

interface OpenAlertEntry {
  /** ms epoch the very first degraded report for this replica landed. */
  firstReportedAt: number;
  /** ms epoch of the most recent degraded report (any operator/tab). */
  lastReportedAt: number;
  /** ms epoch of the most recent Sentry emit for this replica. */
  lastEmittedAt: number;
  /** Total reports observed for this replica during the open window. */
  reportCount: number;
}

const openAlerts: Map<string, OpenAlertEntry> = new Map();

function dropStaleEntries(now: number, staleAfterMs: number): void {
  const cutoff = now - staleAfterMs;
  for (const [id, entry] of openAlerts) {
    if (entry.lastReportedAt < cutoff) {
      openAlerts.delete(id);
    }
  }
}

/**
 * Record a degraded-replica report from the admin status panel and
 * (on the first report inside the cooldown window) page on-call via
 * Sentry. Pure-ish: takes `now` so tests can drive cooldown edges
 * deterministically; in production callers pass `Date.now()`.
 */
export function reportDegraded(
  report: ReplicaDegradedReport,
  now: number = Date.now(),
  config: ReplicaDegradedAlertConfig = getReplicaDegradedAlertConfig(),
): ReplicaDegradedReportOutcome {
  dropStaleEntries(now, config.staleAfterMs);

  const existing = openAlerts.get(report.replicaId);
  const shouldEmit =
    !existing || now - existing.lastEmittedAt >= config.cooldownMs;

  const next: OpenAlertEntry = existing
    ? {
        firstReportedAt: existing.firstReportedAt,
        lastReportedAt: now,
        lastEmittedAt: shouldEmit ? now : existing.lastEmittedAt,
        reportCount: existing.reportCount + 1,
      }
    : {
        firstReportedAt: now,
        lastReportedAt: now,
        lastEmittedAt: now,
        reportCount: 1,
      };
  openAlerts.set(report.replicaId, next);

  if (!shouldEmit) {
    logger.info(
      {
        replicaId: report.replicaId,
        firstReportedAt: existing?.firstReportedAt,
        reportCount: next.reportCount,
        msSinceLastEmit: existing ? now - existing.lastEmittedAt : 0,
      },
      "replica_degraded_report_deduped",
    );
    return {
      emitted: false,
      dedupReason: "within_cooldown",
      replicaId: report.replicaId,
    };
  }

  // Structured log first so the audit trail is captured regardless of
  // whether Sentry is reachable. Mirrors the
  // `audit_chain_tamper_detected` log-then-Sentry ordering.
  logger.error(
    {
      replicaId: report.replicaId,
      httpStatus: report.httpStatus,
      failingChecks: report.failingChecks,
      failures: report.failures,
      consecutivePolls: report.consecutivePolls ?? null,
      firstReportedAt: next.firstReportedAt,
      reportCount: next.reportCount,
    },
    "admin_status_panel_replica_degraded",
  );

  captureMessage("admin_status_panel_replica_degraded", {
    level: "error",
    tags: {
      subsystem: "replica_health",
      source: "admin_status_panel",
      replicaId: report.replicaId,
    },
    fingerprint: ["admin_status_panel_replica_degraded", report.replicaId],
    extra: {
      replicaId: report.replicaId,
      httpStatus: report.httpStatus,
      failingChecks: report.failingChecks,
      failures: report.failures,
      consecutivePolls: report.consecutivePolls ?? null,
      firstReportedAt: next.firstReportedAt,
      reportCount: next.reportCount,
    },
  });

  return { emitted: true, replicaId: report.replicaId };
}

/**
 * Record a "this replica is healthy again" report. Closes the open
 * alert if there was one, and emits a Sentry recovery event so the
 * on-call channel sees the all-clear without having to manually
 * resolve the original issue.
 *
 * Idempotent: a recovery for a replica with no open alert is a no-op
 * (returns `emitted: false`). That makes the panel's "report on every
 * healthy poll while we have an open alert" loop safe to call without
 * client-side bookkeeping — only the first one per outage will fire.
 */
export function reportRecovered(
  report: ReplicaRecoveredReport,
  now: number = Date.now(),
  config: ReplicaDegradedAlertConfig = getReplicaDegradedAlertConfig(),
): ReplicaRecoveredReportOutcome {
  dropStaleEntries(now, config.staleAfterMs);

  const existing = openAlerts.get(report.replicaId);
  if (!existing) {
    return { emitted: false, replicaId: report.replicaId };
  }
  openAlerts.delete(report.replicaId);

  const durationMs = Math.max(0, now - existing.firstReportedAt);
  logger.info(
    {
      replicaId: report.replicaId,
      durationMs,
      reportCount: existing.reportCount,
    },
    "admin_status_panel_replica_recovered",
  );
  captureMessage("admin_status_panel_replica_recovered", {
    level: "info",
    tags: {
      subsystem: "replica_health",
      source: "admin_status_panel",
      replicaId: report.replicaId,
    },
    fingerprint: ["admin_status_panel_replica_degraded", report.replicaId],
    extra: {
      replicaId: report.replicaId,
      durationMs,
      reportCount: existing.reportCount,
      firstReportedAt: existing.firstReportedAt,
      recoveredAt: now,
    },
  });
  return { emitted: true, replicaId: report.replicaId };
}

/**
 * Snapshot of the open-alerts table for unit tests + the (future)
 * admin-only inspection endpoint. Returned as an array (not the
 * underlying Map) so callers can't mutate internal state.
 */
export interface OpenReplicaAlertSnapshot {
  replicaId: string;
  firstReportedAt: number;
  lastReportedAt: number;
  lastEmittedAt: number;
  reportCount: number;
}

export function getOpenReplicaAlerts(): OpenReplicaAlertSnapshot[] {
  return Array.from(openAlerts.entries()).map(([replicaId, entry]) => ({
    replicaId,
    firstReportedAt: entry.firstReportedAt,
    lastReportedAt: entry.lastReportedAt,
    lastEmittedAt: entry.lastEmittedAt,
    reportCount: entry.reportCount,
  }));
}

/** Test-only reset to clear the dedup table between cases. */
export function __resetReplicaDegradedAlertsForTests(): void {
  openAlerts.clear();
}
