import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

export const sellerStreamsTable = pgTable("seller_streams", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  title: text("title").notNull(),
  category: text("category").notNull().default("Other"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  durationMinutes: integer("duration_minutes").notNull().default(0),
  peakViewers: integer("peak_viewers").notNull().default(0),
  totalViewers: integer("total_viewers").notNull().default(0),
  ordersCount: integer("orders_count").notNull().default(0),
  grossMinor: integer("gross_minor").notNull().default(0),
  posterImage: text("poster_image").notNull().default(""),
  productIds: text("product_ids").array().notNull().default([]),
});

export type SellerStreamRow = typeof sellerStreamsTable.$inferSelect;
