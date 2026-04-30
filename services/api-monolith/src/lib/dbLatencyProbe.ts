/**
 * On-demand Postgres round-trip latency probe answered by the
 * api-server replica that handled the `/admin/db-health` request.
 *
 * Why on-demand (instead of a long-running rolling histogram):
 *
 *   - The admin status page polls this endpoint every ~10s. Replicas
 *     come and go, and a rolling histogram in process memory would
 *     reflect the lifetime of THAT replica, not "is the DB responding
 *     well right now". A short burst of `SELECT 1` on every request
 *     is cheap (~5 round-trips) and gives a current snapshot the
 *     panel can act on.
 *
 *   - We do NOT instrument every query in the wider codebase. Doing
 *     so would couple this debug surface to the typed query builder
 *     in ways that drift over time, and an instrumented hot path is
 *     a larger change than this status panel needs.
 *
 *   - The probe is gated behind the same admin middleware as the
 *     other `/admin/*` health endpoints, so the load is bounded to
 *     operator polling, not user traffic.
 *
 * Each `SELECT 1` is timed independently; failures are captured
 * per-sample. p50/p95 are computed over the SUCCESSFUL samples (a
 * single failure shouldn't blank out the panel).
 */
import { sql } from "drizzle-orm";
import type { db as DbType } from "./db";

const DEFAULT_SAMPLE_COUNT = 5;
// Anything slower than 250ms on a `SELECT 1` is unhealthy enough to
// flip the panel red. This is generous — typical p95 should be < 20ms
// — but we want to avoid false positives from a single transient slow
// round-trip while still catching a wedged pool or saturated DB.
const SLOW_PROBE_THRESHOLD_MS = 250;

export interface DbHealthSnapshot {
  replicaId: string;
  state: "healthy" | "degraded";
  sampleCount: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  lastProbedAtIso: string;
  lastSuccessAtIso: string | null;
  lastError: string | null;
}

function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  // Nearest-rank percentile — the same shape `summarizeStreams` uses
  // elsewhere in the codebase. For tiny n=5 samples this is the
  // simplest definition that doesn't drift between calls.
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1),
  );
  return sortedAsc[idx] ?? null;
}

/**
 * Run `samples` sequential `SELECT 1` round-trips against the pool
 * and return a snapshot. Sequential (not parallel) so we measure
 * per-round-trip latency, not pool contention.
 *
 * `db` and `now` are injectable to make the unit test deterministic.
 */
export async function probeDbLatency(args: {
  db: typeof DbType;
  replicaId: string;
  samples?: number;
  now?: () => number;
}): Promise<DbHealthSnapshot> {
  const samples = args.samples ?? DEFAULT_SAMPLE_COUNT;
  const now = args.now ?? Date.now;
  const startedAtMs = now();

  const successes: number[] = [];
  let lastSuccessAtMs: number | null = null;
  let lastError: string | null = null;

  for (let i = 0; i < samples; i++) {
    const t0 = now();
    try {
      await args.db.execute(sql`SELECT 1`);
      const elapsed = Math.max(0, now() - t0);
      successes.push(elapsed);
      lastSuccessAtMs = now();
    } catch (err) {
      lastError = (err as Error).message ?? String(err);
    }
  }

  const sorted = [...successes].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);

  // Degraded if every probe failed, or p95 crossed the slow threshold,
  // or any single probe failed even when others succeeded (an
  // intermittently failing pool is still a problem we want to see).
  const anyFailed = lastError !== null;
  const slow = p95 !== null && p95 > SLOW_PROBE_THRESHOLD_MS;
  const allFailed = successes.length === 0;
  const state: "healthy" | "degraded" =
    allFailed || slow || anyFailed ? "degraded" : "healthy";

  return {
    replicaId: args.replicaId,
    state,
    sampleCount: successes.length,
    p50LatencyMs: p50,
    p95LatencyMs: p95,
    lastProbedAtIso: new Date(startedAtMs).toISOString(),
    lastSuccessAtIso:
      lastSuccessAtMs === null ? null : new Date(lastSuccessAtMs).toISOString(),
    lastError,
  };
}

export const __DB_LATENCY_DEFAULTS = {
  DEFAULT_SAMPLE_COUNT,
  SLOW_PROBE_THRESHOLD_MS,
} as const;
