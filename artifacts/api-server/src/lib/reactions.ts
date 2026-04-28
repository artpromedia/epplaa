import { db, schema } from "./db";
import { and, eq, gte, sql } from "drizzle-orm";
import { newSafeId } from "./ids";
import { logger } from "./logger";

// Aggregates viewer taps in 250ms buckets to bound DB + socket fanout.
const BUCKET_MS = 250;

function bucketBoundary(now = Date.now()): Date {
  return new Date(Math.floor(now / BUCKET_MS) * BUCKET_MS);
}

export async function recordReaction(streamId: string, kind: string, count = 1): Promise<void> {
  await db.insert(schema.streamReactionsTable).values({
    id: newSafeId("rx"),
    streamId,
    bucketAt: bucketBoundary(),
    kind,
    count,
  });
}

type BucketKey = string;
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

// Idempotent. Caller supplies `broadcast` so this module stays free of
// socket.io imports.
export function startReactionFlusher(
  broadcast: (streamId: string, kind: string, count: number) => void,
): void {
  if (flusherTimer) return;
  flusherTimer = setInterval(async () => {
    if (pending.size === 0) return;
    const drained = Array.from(pending.values());
    pending.clear();
    const bucketAt = bucketBoundary();
    // Persist before broadcast so recent-reactions history matches the UI.
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
      return;
    }
    for (const item of drained) {
      broadcast(item.streamId, item.kind, item.count);
    }
  }, BUCKET_MS);
  if (typeof flusherTimer.unref === "function") flusherTimer.unref();
}

export function stopReactionFlusher(): void {
  if (flusherTimer) {
    clearInterval(flusherTimer);
    flusherTimer = null;
  }
}

export interface ReactionBucketSummary {
  bucketAtIso: string;
  kind: string;
  count: number;
}

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
