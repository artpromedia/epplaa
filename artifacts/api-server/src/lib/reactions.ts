import { db, schema } from "./db";
import { and, eq, gte, sql } from "drizzle-orm";
import { newSafeId } from "./ids";
import { logger } from "./logger";

/**
 * Reaction throughput shaping. Viewer taps generate a high-frequency
 * stream of single-event reactions; we bucket them at 250ms boundaries
 * and broadcast aggregated counts so the socket can survive a popular
 * drop without choking. The persisted bucket row is also the source of
 * truth for the "recent reactions" GET.
 *
 * Two ingestion paths exist:
 *  - `recordReaction(...)`: synchronous insert (used by the REST mirror).
 *  - `enqueueReaction(...)` + `startReactionFlusher(...)`: in-memory
 *    aggregation that flushes every BUCKET_MS, persisting one row and
 *    emitting one socket burst per (stream, kind). The socket layer
 *    uses this path so a popular live drop produces O(streams*kinds*4)
 *    DB writes per second instead of O(taps).
 */

const BUCKET_MS = 250;

function bucketBoundary(now = Date.now()): Date {
  return new Date(Math.floor(now / BUCKET_MS) * BUCKET_MS);
}

/** Synchronous insert (one tap = one row). Used by the REST mirror. */
export async function recordReaction(streamId: string, kind: string, count = 1): Promise<void> {
  await db.insert(schema.streamReactionsTable).values({
    id: newSafeId("rx"),
    streamId,
    bucketAt: bucketBoundary(),
    kind,
    count,
  });
}

// --- 250ms aggregator -----------------------------------------------------

type BucketKey = string; // `${streamId}|${kind}`
const pending = new Map<BucketKey, { streamId: string; kind: string; count: number }>();
let flusherTimer: NodeJS.Timeout | null = null;

export function enqueueReaction(streamId: string, kind: string, count: number): void {
  const key = `${streamId}|${kind}`;
  const existing = pending.get(key);
  if (existing) {
    existing.count += count;
  } else {
    pending.set(key, { streamId, kind, count });
  }
}

/**
 * Start the 250ms tick that drains the pending map. The caller (the
 * socket bootstrap) supplies the broadcast function so reactions.ts
 * stays free of socket.io imports. Idempotent — calling twice is a
 * no-op and the original timer keeps running.
 */
export function startReactionFlusher(
  broadcast: (streamId: string, kind: string, count: number) => void,
): void {
  if (flusherTimer) return;
  flusherTimer = setInterval(async () => {
    if (pending.size === 0) return;
    const drained = Array.from(pending.values());
    pending.clear();
    const bucketAt = bucketBoundary();
    // Persist BEFORE broadcasting — otherwise viewers can see a burst
    // that the recent-reactions API will never reflect (causing the
    // post-reconnect history to disagree with what was on screen).
    try {
      await db.insert(schema.streamReactionsTable).values(
        drained.map((d) => ({
          id: newSafeId("rx"),
          streamId: d.streamId,
          bucketAt,
          kind: d.kind,
          count: d.count,
        })),
      );
    } catch (err) {
      logger.error({ err: (err as Error).message }, "reaction_flush_failed");
      // Drop the bucket — if the DB is down, broadcasting bursts that
      // won't appear in history is worse than dropping them entirely.
      return;
    }
    for (const item of drained) {
      broadcast(item.streamId, item.kind, item.count);
    }
  }, BUCKET_MS);
  // Don't keep the event loop alive solely for the flusher.
  if (typeof flusherTimer.unref === "function") flusherTimer.unref();
}

export function stopReactionFlusher(): void {
  if (flusherTimer) {
    clearInterval(flusherTimer);
    flusherTimer = null;
  }
}

// --- queries --------------------------------------------------------------

export interface ReactionBucketSummary {
  bucketAtIso: string;
  kind: string;
  count: number;
}

/**
 * Return the last `windowSeconds` of reaction buckets aggregated by
 * (bucket_at, kind) — the player uses this to render bursts after a
 * reconnect.
 */
export async function recentReactions(streamId: string, windowSeconds = 60): Promise<ReactionBucketSummary[]> {
  const since = new Date(Date.now() - windowSeconds * 1000);
  const rows = await db
    .select({
      bucketAt: schema.streamReactionsTable.bucketAt,
      kind: schema.streamReactionsTable.kind,
      total: sql<number>`SUM(${schema.streamReactionsTable.count})::int`,
    })
    .from(schema.streamReactionsTable)
    .where(
      and(
        eq(schema.streamReactionsTable.streamId, streamId),
        gte(schema.streamReactionsTable.bucketAt, since),
      ),
    )
    .groupBy(schema.streamReactionsTable.bucketAt, schema.streamReactionsTable.kind)
    .orderBy(schema.streamReactionsTable.bucketAt);
  return rows.map((r) => ({
    bucketAtIso: r.bucketAt.toISOString(),
    kind: r.kind,
    count: Number(r.total ?? 0),
  }));
}

export const REACTION_BUCKET_MS = BUCKET_MS;
