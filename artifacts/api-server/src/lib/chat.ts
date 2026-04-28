import { db, schema } from "./db";
import { eq, and, isNull, gt, desc, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { newSafeId } from "./ids";

// Default profanity list; extended per-stream via streams.banned_words.
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

// Pre-flight check; the atomic enforcement runs inside chatSendAtomic.
export async function slowModeWaitSeconds(streamId: string, userId: string): Promise<number> {
  const [stream] = await db
    .select({ slowMode: schema.streamsTable.slowModeSeconds, seller: schema.streamsTable.sellerUserId })
    .from(schema.streamsTable)
    .where(eq(schema.streamsTable.id, streamId))
    .limit(1);
  if (!stream) return 0;
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

// Holds a per-(stream,user) pg_advisory_xact_lock through the insert so
// concurrent sends serialise and slow-mode can't race.
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

function advisoryLockKey(key: string): bigint {
  const hex = createHash("sha1").update(key).digest("hex").slice(0, 16);
  return BigInt("0x" + hex) & 0x7fffffffffffffffn;
}

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

export interface PublicChatMessage {
  id: string;
  streamId: string;
  username: string;
  text: string;
  role: string;
  createdAtIso: string;
}

export function toPublicChatMessage(m: PersistedChatMessage): PublicChatMessage {
  return {
    id: m.id,
    streamId: m.streamId,
    username: m.username,
    text: m.text,
    role: m.role,
    createdAtIso: m.createdAtIso,
  };
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
