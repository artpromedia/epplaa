import { pgTable, text, integer, jsonb, timestamp } from "drizzle-orm/pg-core";

export const returnsTable = pgTable("returns", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  orderId: text("order_id").notNull(),
  productTitle: text("product_title").notNull(),
  productImage: text("product_image"),
  refundAmountMinor: integer("refund_amount_minor").notNull(),
  currencyCode: text("currency_code").notNull(),
  reason: text("reason").notNull(),
  reasonLabel: text("reason_label").notNull(),
  notes: text("notes").notNull().default(""),
  photoCount: integer("photo_count").notNull().default(0),
  status: text("status").notNull().default("requested"),
  timeline: jsonb("timeline").notNull().default([]),
  dispute: jsonb("dispute").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ReturnRow = typeof returnsTable.$inferSelect;
