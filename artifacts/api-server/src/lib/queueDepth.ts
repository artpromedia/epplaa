/**
 * Live row-count snapshot of the `notifications_outbox` table — the
 * single shared queue the api-server drains every 30s for retryable
 * notifications and the periodic background jobs that fan out through
 * it (reconciliation, payouts).
 *
 * The admin status page polls this so on-call can see queue depth at
 * a glance without having to SSH into a replica and run ad-hoc SQL.
 *
 * Implementation notes:
 *
 *   - Counts are computed in a single round-trip with `FILTER` clauses
 *     so the query touches the index on `(status, next_attempt_at)`
 *     once instead of three times.
 *
 *   - "Oldest pending" is the oldest row whose `next_attempt_at` has
 *     already elapsed (i.e. the drain SHOULD have processed it by
 *     now). Future-scheduled rows are intentionally excluded — they
 *     are not "stuck", they are simply waiting for their backoff
 *     window. Without this filter a row scheduled for "+24h after the
 *     5th failure" would always look like the queue is wedged.
 *
 *   - `oldestProcessingAt` mirrors the in-flight lease window. The
 *     drain claims `nextAttemptAt = NOW()` when it leases a row, so a
 *     processing row whose `next_attempt_at` is older than
 *     `PROCESSING_LEASE_MS` is a worker that crashed mid-send and
 *     will be recovered by `drainOutbox`'s lease-recovery sweep on
 *     the next tick. Surfacing the timestamp lets an operator spot
 *     this before the recovery sweep runs.
 */
import { sql } from "drizzle-orm";
import type { db as DbType } from "./db";

const STALE_PENDING_THRESHOLD_MS = 10 * 60_000;

export interface QueueHealthSnapshot {
  state: "healthy" | "degraded";
  pendingCount: number;
  processingCount: number;
  failedCount: number;
  oldestPendingAtIso: string | null;
  oldestProcessingAtIso: string | null;
  sampledAtIso: string;
}

interface QueueDepthRow {
  pending_count: string | number;
  processing_count: string | number;
  failed_count: string | number;
  oldest_pending_at: Date | string | null;
  oldest_processing_at: Date | string | null;
}

function toDateOrNull(v: Date | string | null): Date | null {
  if (v === null) return null;
  if (v instanceof Date) return v;
  const parsed = new Date(v);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toInt(v: string | number): number {
  return typeof v === "number" ? v : Number.parseInt(v, 10) || 0;
}

export async function getQueueHealthSnapshot(
  database: typeof DbType,
  now: () => number = Date.now,
): Promise<QueueHealthSnapshot> {
  // `pg`'s COUNT(*) returns a string ("BIGINT" -> string in node-pg) —
  // hence the explicit `toInt` coercion below. The aggregates touch
  // the `outbox_status_next_idx` index in one pass.
  const result = await database.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'pending') AS pending_count,
      COUNT(*) FILTER (WHERE status = 'processing') AS processing_count,
      COUNT(*) FILTER (WHERE status = 'failed') AS failed_count,
      MIN(next_attempt_at) FILTER (
        WHERE status = 'pending' AND next_attempt_at <= NOW()
      ) AS oldest_pending_at,
      MIN(next_attempt_at) FILTER (WHERE status = 'processing') AS oldest_processing_at
    FROM notifications_outbox
  `);

  // drizzle.execute() returns either an object with `rows` (pg) or an
  // array directly depending on adapter version. Normalise.
  const rows: QueueDepthRow[] = Array.isArray(result)
    ? (result as unknown as QueueDepthRow[])
    : ((result as unknown as { rows?: QueueDepthRow[] }).rows ?? []);
  const row = rows[0] ?? {
    pending_count: 0,
    processing_count: 0,
    failed_count: 0,
    oldest_pending_at: null,
    oldest_processing_at: null,
  };

  const pendingCount = toInt(row.pending_count);
  const processingCount = toInt(row.processing_count);
  const failedCount = toInt(row.failed_count);
  const oldestPendingAt = toDateOrNull(row.oldest_pending_at);
  const oldestProcessingAt = toDateOrNull(row.oldest_processing_at);

  const nowMs = now();
  const oldestPendingAge =
    oldestPendingAt === null ? 0 : nowMs - oldestPendingAt.getTime();
  const stale = oldestPendingAge > STALE_PENDING_THRESHOLD_MS;
  const state: "healthy" | "degraded" =
    failedCount > 0 || stale ? "degraded" : "healthy";

  return {
    state,
    pendingCount,
    processingCount,
    failedCount,
    oldestPendingAtIso: oldestPendingAt?.toISOString() ?? null,
    oldestProcessingAtIso: oldestProcessingAt?.toISOString() ?? null,
    sampledAtIso: new Date(nowMs).toISOString(),
  };
}

export const __QUEUE_DEPTH_DEFAULTS = {
  STALE_PENDING_THRESHOLD_MS,
} as const;
