import { pgTable, text, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const replaysTable = pgTable(
  "replays",
  {
    id: text("id").primaryKey(),
    hostName: text("host_name").notNull(),
    hostAvatar: text("host_avatar").notNull().default(""),
    posterImage: text("poster_image").notNull().default(""),
    title: text("title").notNull(),
    durationLabel: text("duration_label").notNull().default("0:00"),
    durationSeconds: integer("duration_seconds").notNull().default(0),
    viewCount: text("view_count").notNull().default("0"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    productIds: text("product_ids").array().notNull().default([]),
    liveStreamId: text("live_stream_id"),
    // HLS manifest URL for the recorded VOD. Populated from the streaming
    // provider after the stream ends (Cloudflare returns one per recording).
    // Nullable for legacy / stub seed rows that don't have a real recording.
    playbackUrl: text("playback_url"),
  },
  (t) => [
    // Partial unique index — at most one replay row per live stream.
    // Cloudflare's "video ready" webhook can deliver concurrently
    // (initial + retry), and the persist path is select-then-insert, so
    // without this constraint a retry storm would write duplicate
    // replays. Partial because legacy / stub seed rows have a null
    // live_stream_id and several can coexist.
    uniqueIndex("replays_live_stream_id_uniq")
      .on(t.liveStreamId)
      .where(sql`${t.liveStreamId} IS NOT NULL`),
  ],
);

export type Replay = typeof replaysTable.$inferSelect;
