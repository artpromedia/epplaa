import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "./db";

/**
 * Per-stream moderator grants. Created on boot via `initStreamModeratorsSchema`
 * (additive `CREATE TABLE IF NOT EXISTS`, mirroring `initAdminSchema`).
 *
 * A row in `stream_moderators` makes (streamId, userId) a mod for that
 * stream — they can delete chat messages and tune slow-mode/banned-words
 * just like the host (see `canModerateStream`). Only the host (the
 * stream's seller_user_id) may insert or delete rows here; the
 * permission check lives in the route handlers.
 */
export async function initStreamModeratorsSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS stream_moderators (
      stream_id text NOT NULL,
      user_id text NOT NULL,
      granted_by text NOT NULL,
      granted_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (stream_id, user_id)
    );
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS stream_moderators_stream_idx ON stream_moderators (stream_id);`,
  );
}

export async function isStreamModerator(streamId: string, userId: string): Promise<boolean> {
  if (!streamId || !userId) return false;
  const [row] = await db
    .select({ userId: schema.streamModeratorsTable.userId })
    .from(schema.streamModeratorsTable)
    .where(
      and(
        eq(schema.streamModeratorsTable.streamId, streamId),
        eq(schema.streamModeratorsTable.userId, userId),
      ),
    )
    .limit(1);
  return !!row;
}

export type StreamModerationRole = "host" | "mod" | "viewer";

/**
 * Resolve `userId`'s moderation capability for `streamId`. The host
 * (stream.sellerUserId) is implicitly allowed everything, then we
 * check the moderator grant table. Returns `viewer` when neither.
 */
export async function resolveStreamModerationRole(
  streamId: string,
  userId: string,
): Promise<StreamModerationRole> {
  if (!streamId || !userId) return "viewer";
  const [stream] = await db
    .select({ seller: schema.streamsTable.sellerUserId })
    .from(schema.streamsTable)
    .where(eq(schema.streamsTable.id, streamId))
    .limit(1);
  if (stream?.seller && stream.seller === userId) return "host";
  if (await isStreamModerator(streamId, userId)) return "mod";
  return "viewer";
}

export async function canModerateStream(streamId: string, userId: string): Promise<boolean> {
  const role = await resolveStreamModerationRole(streamId, userId);
  return role === "host" || role === "mod";
}

export interface StreamModeratorRow {
  userId: string;
  username: string;
  grantedBy: string;
  grantedAtIso: string;
}

export async function listStreamModerators(streamId: string): Promise<StreamModeratorRow[]> {
  const rows = await db
    .select({
      userId: schema.streamModeratorsTable.userId,
      grantedBy: schema.streamModeratorsTable.grantedBy,
      grantedAt: schema.streamModeratorsTable.grantedAt,
      displayName: schema.usersTable.displayName,
    })
    .from(schema.streamModeratorsTable)
    .leftJoin(
      schema.usersTable,
      eq(schema.usersTable.clerkId, schema.streamModeratorsTable.userId),
    )
    .where(eq(schema.streamModeratorsTable.streamId, streamId))
    .orderBy(schema.streamModeratorsTable.grantedAt);
  return rows.map((r) => ({
    userId: r.userId,
    username: (r.displayName ?? "").trim() || "viewer",
    grantedBy: r.grantedBy,
    grantedAtIso: r.grantedAt.toISOString(),
  }));
}

export async function addStreamModerator(input: {
  streamId: string;
  userId: string;
  grantedBy: string;
}): Promise<void> {
  await db
    .insert(schema.streamModeratorsTable)
    .values({
      streamId: input.streamId,
      userId: input.userId,
      grantedBy: input.grantedBy,
    })
    .onConflictDoNothing();
}

export async function removeStreamModerator(streamId: string, userId: string): Promise<boolean> {
  const rows = await db
    .delete(schema.streamModeratorsTable)
    .where(
      and(
        eq(schema.streamModeratorsTable.streamId, streamId),
        eq(schema.streamModeratorsTable.userId, userId),
      ),
    )
    .returning({ userId: schema.streamModeratorsTable.userId });
  return rows.length > 0;
}

/**
 * Look up the userId/username of the message author. Used by
 * `POST /streams/:streamId/moderators` so the host can promote
 * straight from a chat message id without ever seeing raw user ids
 * in the public chat payload.
 */
export async function lookupChatMessageAuthor(
  streamId: string,
  messageId: string,
): Promise<{ userId: string; username: string } | null> {
  const [row] = await db
    .select({
      userId: schema.streamChatMessagesTable.userId,
      username: schema.streamChatMessagesTable.username,
    })
    .from(schema.streamChatMessagesTable)
    .where(
      and(
        eq(schema.streamChatMessagesTable.streamId, streamId),
        eq(schema.streamChatMessagesTable.id, messageId),
      ),
    )
    .limit(1);
  if (!row) return null;
  return { userId: row.userId, username: row.username };
}
