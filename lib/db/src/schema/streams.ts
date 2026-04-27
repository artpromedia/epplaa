import { pgTable, text, boolean, timestamp } from "drizzle-orm/pg-core";

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
});

export type Stream = typeof streamsTable.$inferSelect;
