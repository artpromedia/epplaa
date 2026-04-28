import { db, schema } from "./db";
import { eq, and, isNull, gt, desc, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { newSafeId } from "./ids";

/**
 * Chat moderation primitives. Banned-word filter is opt-in additive: a
 * global default profanity list (kept minimal and obvious; ops can extend
 * via per-stream `banned_words` column) plus the host's per-stream extras.
 *
 * Filter is *substring* match on the lowercased message after collapsing
 * whitespace. Hits are replaced with `***` and logged via the audit chain
 * (the route layer wraps recordAudit). Slow-mode is enforced with a cheap
 * "look at last message" check — fine for MVP throughput; if rooms ever
 * exceed ~50 msg/s we'd switch to a Redis ZADD with TTL.
 */

const DEFAULT_BANNED = [
  "fuck",
  "shit",
  "bitch",
  "asshole",
  "nigger",
  "faggot",
  "cunt",
  "whore",
];

export function applyBannedWordsFilter(text: string, extras: string[]): string {
  const all = [...DEFAULT_BANNED, ...extras.map((e) => e.toLowerCase())];
  let out = text;
  for (const word of all) {
    if (!word) continue;
    const re = new RegExp(escapeRegex(word), "gi");
    out = out.replace(re, "***");
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Returns the seconds the caller must wait before they can post again,
 * or 0 if they may post now. Used by the REST send endpoint as a cheap
 * pre-flight (the *atomic* enforcement happens in trySlowModeReserve
 * inside a transaction). Resolves the per-stream slow_mode_seconds
 * setting at call time so toggling it mid-stream takes immediate effect.
 */
export async function slowModeWaitSeconds(streamId: string, userId: string): Promise<number> {
  const [stream] = await db
    .select({ slowMode: schema.streamsTable.slowModeSeconds, seller: schema.streamsTable.sellerUserId })
    .from(schema.streamsTable)
    .where(eq(schema.streamsTable.id, streamId))
    .limit(1);
  if (!stream) return 0;
  // Host bypasses slow-mode (they can pace the conversation).
  if (stream.seller && stream.seller === userId) return 0;
  const seconds = stream.slowMode ?? 0;
  if (seconds <= 0) return 0;
  const since = new Date(Date.now() - seconds * 1000);
  const [last] = await db
    .select({ createdAt: schema.streamChatMessagesTable.createdAt })
    .from(schema.streamChatMessagesTable)
    .where(
      and(
        eq(schema.streamChatMessagesTable.streamId, streamId),
        eq(schema.streamChatMessagesTable.userId, userId),
        gt(schema.streamChatMessagesTable.createdAt, since),
        isNull(schema.streamChatMessagesTable.deletedAt),
      ),
    )
    .orderBy(desc(schema.streamChatMessagesTable.createdAt))
    .limit(1);
  if (!last) return 0;
  const elapsed = (Date.now() - last.createdAt.getTime()) / 1000;
  const wait = seconds - elapsed;
  return wait > 0 ? Math.ceil(wait) : 0;
}

/**
 * Atomic chat send. Acquires a per-(stream,user) `pg_advisory_xact_lock`,
 * verifies the user is *currently* outside their slow-mode window, and
 * persists the new message — all in one transaction so the lock is
 * still held when the row commits. Two concurrent sends from the same
 * user therefore serialise and the second one sees the first one's
 * message in its slow-mode lookup.
 *
 * Returns `{ ok: true, message }` on persist, otherwise
 * `{ ok: false, waitSeconds }` for slow-mode rejection or
 * `{ ok: false, reason: 'not_found' }` when the stream doesn't exist.
 *
 * Banned-word filtering and role resolution happen inside the same
 * transaction — they read the same `streams` row that gates slow-mode
 * so we save a round-trip and avoid a stale snapshot.
 */
export type AtomicChatResult =
  | { ok: true; message: PersistedChatMessage }
  | { ok: false; reason: "slow_mode"; waitSeconds: number }
  | { ok: false; reason: "not_found" };

export async function chatSendAtomic(input: {
  streamId: string;
  userId: string;
  username: string;
  text: string;
}): Promise<AtomicChatResult> {
  const lockKey = advisoryLockKey(`${input.streamId}:${input.userId}`);
  return await db.transaction(async (tx): Promise<AtomicChatResult> => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey})`);
    const [stream] = await tx
      .select({
        slowMode: schema.streamsTable.slowModeSeconds,
        seller: schema.streamsTable.sellerUserId,
        banned: schema.streamsTable.bannedWords,
      })
      .from(schema.streamsTable)
      .where(eq(schema.streamsTable.id, input.streamId))
      .limit(1);
    if (!stream) {
      return { ok: false, reason: "not_found" };
    }
    const isHost = !!(stream.seller && stream.seller === input.userId);
    const seconds = stream.slowMode ?? 0;
    if (!isHost && seconds > 0) {
      const since = new Date(Date.now() - seconds * 1000);
      const [last] = await tx
        .select({ createdAt: schema.streamChatMessagesTable.createdAt })
        .from(schema.streamChatMessagesTable)
        .where(
          and(
            eq(schema.streamChatMessagesTable.streamId, input.streamId),
            eq(schema.streamChatMessagesTable.userId, input.userId),
            gt(schema.streamChatMessagesTable.createdAt, since),
            isNull(schema.streamChatMessagesTable.deletedAt),
          ),
        )
        .orderBy(desc(schema.streamChatMessagesTable.createdAt))
        .limit(1);
      if (last) {
        const elapsed = (Date.now() - last.createdAt.getTime()) / 1000;
        const wait = seconds - elapsed;
        if (wait > 0) {
          return { ok: false, reason: "slow_mode", waitSeconds: Math.ceil(wait) };
        }
      }
    }
    const filtered = applyBannedWordsFilter(input.text, stream.banned ?? []);
    const role = isHost ? "host" : "viewer";
    const [row] = await tx
      .insert(schema.streamChatMessagesTable)
      .values({
        id: newSafeId("msg"),
        streamId: input.streamId,
        userId: input.userId,
        username: input.username,
        text: filtered,
        role,
      })
      .returning();
    return {
      ok: true,
      message: {
        id: row.id,
        streamId: row.streamId,
        userId: row.userId,
        username: row.username,
        text: row.text,
        role: row.role,
        createdAtIso: row.createdAt.toISOString(),
      },
    };
  });
}

/**
 * pg_advisory_xact_lock takes a bigint. We hash the composite key to a
 * 63-bit signed integer (postgres bigint range, sign bit clear so it
 * never collides with negative-keyed locks elsewhere in the codebase).
 */
function advisoryLockKey(key: string): bigint {
  const hex = createHash("sha1").update(key).digest("hex").slice(0, 16);
  // Force the high bit to 0 to keep the value positive in signed bigint.
  return BigInt("0x" + hex) & 0x7fffffffffffffffn;
}

/**
 * Resolve the author's role at posting time. Snapshotted on the row so
 * later role changes don't retroactively re-attribute messages.
 */
export async function resolveChatRole(streamId: string, userId: string): Promise<"host" | "viewer"> {
  const [stream] = await db
    .select({ seller: schema.streamsTable.sellerUserId })
    .from(schema.streamsTable)
    .where(eq(schema.streamsTable.id, streamId))
    .limit(1);
  if (stream?.seller && stream.seller === userId) return "host";
  return "viewer";
}

export async function isHost(streamId: string, userId: string): Promise<boolean> {
  return (await resolveChatRole(streamId, userId)) === "host";
}

export interface PersistedChatMessage {
  id: string;
  streamId: string;
  userId: string;
  username: string;
  text: string;
  role: string;
  createdAtIso: string;
}

export async function persistChatMessage(input: {
  streamId: string;
  userId: string;
  username: string;
  text: string;
  role: string;
}): Promise<PersistedChatMessage> {
  const [row] = await db
    .insert(schema.streamChatMessagesTable)
    .values({
      id: newSafeId("msg"),
      streamId: input.streamId,
      userId: input.userId,
      username: input.username,
      text: input.text,
      role: input.role,
    })
    .returning();
  return {
    id: row.id,
    streamId: row.streamId,
    userId: row.userId,
    username: row.username,
    text: row.text,
    role: row.role,
    createdAtIso: row.createdAt.toISOString(),
  };
}

export async function softDeleteMessage(streamId: string, messageId: string, byUserId: string): Promise<boolean> {
  const [row] = await db
    .update(schema.streamChatMessagesTable)
    .set({ deletedAt: new Date(), deletedBy: byUserId })
    .where(
      and(
        eq(schema.streamChatMessagesTable.streamId, streamId),
        eq(schema.streamChatMessagesTable.id, messageId),
        isNull(schema.streamChatMessagesTable.deletedAt),
      ),
    )
    .returning({ id: schema.streamChatMessagesTable.id });
  return !!row;
}

export async function listRecentMessages(streamId: string, limit = 50): Promise<PersistedChatMessage[]> {
  const rows = await db
    .select()
    .from(schema.streamChatMessagesTable)
    .where(
      and(
        eq(schema.streamChatMessagesTable.streamId, streamId),
        isNull(schema.streamChatMessagesTable.deletedAt),
      ),
    )
    .orderBy(desc(schema.streamChatMessagesTable.createdAt))
    .limit(limit);
  // Newest-last so the player can append directly.
  return rows.reverse().map((r) => ({
    id: r.id,
    streamId: r.streamId,
    userId: r.userId,
    username: r.username,
    text: r.text,
    role: r.role,
    createdAtIso: r.createdAt.toISOString(),
  }));
}
