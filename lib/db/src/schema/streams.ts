import { pgTable, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";

export const streamsTable = pgTable("streams", {
  id: text("id").primaryKey(),
  hostName: text("host_name").notNull(),
  hostAvatar: text("host_avatar").notNull().default(""),
  viewerCount: text("viewer_count").notNull().default("0"),
  posterImage: text("poster_image").notNull().default(""),
  title: text("title").notNull(),
  currentProductId: text("current_product_id"),
  isLive: boolean("is_live").notNull().default(true),
  sellerUserId: text("seller_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

  // Cloudflare Stream provisioning. cf_input_id is the Live Input UID; the
  // RTMP key is treated as a credential and rotated on each new session via
  // POST /streams/:id/rotate-key. hls_url is the playback URL the buyer
  // player loads. cf_video_uid is populated when the recording finishes
  // (used to wire up the replay row).
  cfInputId: text("cf_input_id"),
  rtmpUrl: text("rtmp_url"),
  rtmpStreamKey: text("rtmp_stream_key"),
  whipUrl: text("whip_url"),
  hlsUrl: text("hls_url"),
  cfVideoUid: text("cf_video_uid"),
  provider: text("provider").notNull().default("stub"),

  // Lifecycle. status is the source of truth for whether a stream is
  // ingesting; the legacy isLive column is kept in sync for back-compat
  // with the GET /streams listing card.
  status: text("status").notNull().default("idle"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  peakViewers: integer("peak_viewers").notNull().default(0),
  currentViewers: integer("current_viewers").notNull().default(0),

  // Moderation knobs the host can flip mid-stream. banned_words is a
  // simple text[] of additional substrings to strip on top of the global
  // default profanity list (see lib/chat.ts). slow_mode_seconds rate
  // limits each viewer to one message per N seconds.
  slowModeSeconds: integer("slow_mode_seconds").notNull().default(0),
  bannedWords: text("banned_words").array().notNull().default([]),
  keyRotatedAt: timestamp("key_rotated_at", { withTimezone: true }),
});

export type Stream = typeof streamsTable.$inferSelect;
