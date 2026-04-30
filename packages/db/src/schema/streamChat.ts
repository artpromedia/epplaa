import { pgTable, text, integer, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Append-only chat log for a live stream. We persist every message
 * (post-redaction) so we can render history when a viewer joins late and
 * so moderation has an audit trail. `deleted_at` is a soft-delete marker
 * — the row stays for moderation review but isn't surfaced to viewers.
 *
 * `role` is the author's role *at the time of posting*, snapshotted so a
 * later role change doesn't retroactively re-attribute messages.
 */
export const streamChatMessagesTable = pgTable(
  "stream_chat_messages",
  {
    id: text("id").primaryKey(),
    streamId: text("stream_id").notNull(),
    userId: text("user_id").notNull(),
    username: text("username").notNull(),
    text: text("text").notNull(),
    role: text("role").notNull().default("viewer"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: text("deleted_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    streamRecentIdx: index("stream_chat_stream_recent_idx").on(t.streamId, t.createdAt),
  }),
);

export type StreamChatMessage = typeof streamChatMessagesTable.$inferSelect;

/**
 * Reaction events bucketed server-side at 250ms boundaries so we can
 * cheaply broadcast aggregated counts to viewers (heart spam during a
 * drop can otherwise saturate the socket). `bucket_at` is rounded down
 * to the nearest 250ms; `kind` is the reaction emoji slug.
 */
export const streamReactionsTable = pgTable(
  "stream_reactions",
  {
    id: text("id").primaryKey(),
    streamId: text("stream_id").notNull(),
    bucketAt: timestamp("bucket_at", { withTimezone: true }).notNull(),
    kind: text("kind").notNull().default("heart"),
    count: integer("count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    streamBucketIdx: index("stream_reaction_bucket_idx").on(t.streamId, t.bucketAt),
  }),
);

export type StreamReactionBucket = typeof streamReactionsTable.$inferSelect;
