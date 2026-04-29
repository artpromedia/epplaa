/**
 * audit_failures dead-letter-queue (DLQ) backlog monitor.
 *
 * Why this exists (see docs/runbooks/rate-limit-store.md Step 5):
 * The existing `auditChain` SubsystemFailureWatcher catches per-call
 * failure streaks of `recordAudit` — i.e. "every audit write right now
 * is failing for many minutes". It does NOT catch a different silent
 * failure mode: a partial outage causes a burst of dead-lettered rows
 * into `audit_failures`, then writes start succeeding again so the
 * `auditChain` watcher flips back to healthy, while the DLQ keeps
 * growing because nothing ever replays the failed rows.
 *
 * Result: `recordAudit` reports green, `subsystems.auditChain` reports
 * green, /healthz looks healthy — but the compliance-required hash
 * chain is missing rows. The duration alert in
 * `scripts/checkHealthzDegraded.ts` would have nothing to fire on.
 *
 * This module closes that gap with a periodic depth probe:
 *
 *   - Every `AUDIT_DLQ_POLL_INTERVAL_MS` (default 60s) it runs
 *     `SELECT count(*) FROM audit_failures WHERE replayed_at IS NULL`.
 *   - When the count exceeds `AUDIT_DLQ_BACKLOG_THRESHOLD` (default
 *     100) it calls `auditDlqHealthWatcher.record()` to open / extend
 *     a streak.
 *   - When the count is at or below the threshold it calls
 *     `recordSuccess()` to close any in-progress streak.
 *
 * The watcher snapshot is exposed under `subsystems.auditDlq` on
 * /healthz, which means the existing `checkHealthzDegraded` probe
 * iterates over it automatically and pages on-call once
 * `now - firstFailureAt` exceeds the duration threshold — same alerting
 * envelope as `auditChain`, no extra paging surface to wire up.
 *
 * We deliberately do NOT alter the watcher state on a poll error
 * (DB unreachable, query timeout, etc.). That's the dbHealthWatcher's
 * job to surface via /readyz; conflating "DLQ over threshold" with
 * "we couldn't measure the DLQ" would erode the alert's signal.
 */

import { sql } from "drizzle-orm";
import { db } from "./db";
import { logger } from "./logger";
import { SubsystemFailureWatcher, type SubsystemSnapshot } from "./subsystemHealth";

const DEFAULT_BACKLOG_THRESHOLD = 100;
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const MIN_POLL_INTERVAL_MS = 1_000;

/**
 * Snapshot returned to /healthz. Extends the standard SubsystemSnapshot
 * shape (so the duration probe can iterate every subsystem uniformly)
 * with the DLQ-specific fields a human looking at /healthz will want
 * during an incident — current depth, configured threshold, when it
 * was last measured, and any error from the last poll.
 */
export interface AuditDlqSnapshot extends SubsystemSnapshot {
  /** Most recent observed unreplayed-row count, or null until the
   *  first poll completes. */
  unreplayedCount: number | null;
  /** Configured `AUDIT_DLQ_BACKLOG_THRESHOLD` — surfaced so the
   *  /healthz consumer doesn't have to know the env-var convention. */
  thresholdCount: number;
  /** ms-epoch of the last successful or attempted poll, or null when
   *  no poll has run yet (e.g. boot before the first tick fired). */
  lastPollAt: number | null;
  /** Error message from the last poll if it failed; null on success.
   *  Surfaced so an operator looking at /healthz can tell apart
   *  "DLQ is fine" from "we can't see the DLQ" — distinct triage paths. */
  lastPollError: string | null;
}

/**
 * Singleton failure-streak watcher for the audit DLQ depth. Wired into
 * /healthz under `subsystems.auditDlq`. Driven exclusively by the
 * poller in this file — never by per-call code.
 */
export const auditDlqHealthWatcher = new SubsystemFailureWatcher();

let lastUnreplayedCount: number | null = null;
let lastPollAt: number | null = null;
let lastPollError: string | null = null;
let pollerHandle: ReturnType<typeof setInterval> | null = null;

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  minValue = 1,
): number {
  // Mirrors the env-var sanitisation in routes/health.ts /
  // scripts/checkHealthzDegraded.ts: missing, non-numeric, zero, or
  // negative values fall back to a safe default rather than turning
  // the alert into either a flapping page (zero threshold = always
  // over) or a permanently-silent one.
  const n = raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(n) || n < minValue) return fallback;
  return Math.floor(n);
}

export function getAuditDlqThreshold(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveInt(env.AUDIT_DLQ_BACKLOG_THRESHOLD, DEFAULT_BACKLOG_THRESHOLD, 1);
}

export function getAuditDlqPollIntervalMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return parsePositiveInt(
    env.AUDIT_DLQ_POLL_INTERVAL_MS,
    DEFAULT_POLL_INTERVAL_MS,
    MIN_POLL_INTERVAL_MS,
  );
}

/**
 * Run a single depth probe against `audit_failures`. Updates the
 * watcher (open/close the streak) and the cached snapshot fields.
 *
 * Exported for unit tests; the production caller is the interval
 * scheduled in `startAuditDlqMonitor`.
 *
 * Failure semantics: a poll error (DB unreachable, query timeout) is
 * logged at warn level and stored in `lastPollError`, but it does NOT
 * call `record()` on the watcher. Doing so would conflate "we can't
 * see the DLQ" with "the DLQ is over threshold" — two incidents with
 * different runbook entry points. The DB-pool outage that produced
 * the error is already surfaced separately via `subsystems.db` (driven
 * by the /readyz probe), so on-call still gets paged through that
 * channel.
 */
export async function pollAuditDlqDepth(now: number = Date.now()): Promise<void> {
  const threshold = getAuditDlqThreshold();
  try {
    const result = await db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM audit_failures WHERE replayed_at IS NULL`,
    );
    const raw = result.rows[0]?.count ?? "0";
    const count = Number(raw);
    if (!Number.isFinite(count) || count < 0) {
      // Defensive: a malformed row would otherwise parse to NaN and
      // silently never trip the threshold. Treat as a poll error so
      // lastPollError is set and an operator notices.
      throw new Error(`audit_dlq_count_unparseable: ${String(raw)}`);
    }
    lastUnreplayedCount = count;
    lastPollAt = now;
    lastPollError = null;
    if (count > threshold) {
      auditDlqHealthWatcher.record(now);
    } else {
      auditDlqHealthWatcher.recordSuccess(now);
    }
  } catch (err) {
    const msg = (err as Error).message;
    lastPollError = msg;
    lastPollAt = now;
    logger.warn(
      { err: msg, threshold },
      "audit_dlq_poll_failed",
    );
    // Intentionally do NOT call watcher.record(): see the function
    // header for why.
  }
}

/**
 * Read the current /healthz snapshot for the audit DLQ subsystem.
 * Pure read — does not trigger a poll.
 */
export function getAuditDlqSnapshot(
  env: NodeJS.ProcessEnv = process.env,
): AuditDlqSnapshot {
  return {
    ...auditDlqHealthWatcher.getSnapshot(),
    unreplayedCount: lastUnreplayedCount,
    thresholdCount: getAuditDlqThreshold(env),
    lastPollAt,
    lastPollError,
  };
}

/**
 * Boot-time hook: kick off the periodic depth probe. Idempotent — a
 * second call is a no-op so a future refactor that calls this from
 * multiple boot paths can't double-schedule the interval.
 *
 * The first probe runs immediately (so the very first /healthz response
 * after boot has a real `unreplayedCount` instead of the
 * `null` placeholder) and every `AUDIT_DLQ_POLL_INTERVAL_MS` thereafter.
 * The interval handle is `unref()`'d so it doesn't keep the process
 * alive on its own.
 */
export function startAuditDlqMonitor(): void {
  if (pollerHandle) return;
  const intervalMs = getAuditDlqPollIntervalMs();
  // Run the first poll immediately so /healthz has a real depth on
  // the very first probe — a `null` unreplayedCount is a "probe never
  // ran" signal, distinct from "probe ran and found 0".
  void pollAuditDlqDepth().catch((err) =>
    logger.error(
      { err: (err as Error).message },
      "audit_dlq_monitor_initial_poll_failed",
    ),
  );
  pollerHandle = setInterval(() => {
    void pollAuditDlqDepth().catch((err) =>
      logger.error(
        { err: (err as Error).message },
        "audit_dlq_monitor_tick_failed",
      ),
    );
  }, intervalMs);
  pollerHandle.unref?.();
  logger.info(
    { intervalMs, thresholdCount: getAuditDlqThreshold() },
    "audit_dlq_monitor_started",
  );
}

/**
 * Test-only: stop the interval (if running) and reset all cached
 * snapshot fields plus the watcher streak. Lets each test case start
 * from a clean state without spinning up a fresh module instance.
 */
export function __resetAuditDlqMonitorForTests(): void {
  if (pollerHandle) {
    clearInterval(pollerHandle);
    pollerHandle = null;
  }
  auditDlqHealthWatcher.__reset();
  lastUnreplayedCount = null;
  lastPollAt = null;
  lastPollError = null;
}
