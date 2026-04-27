import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

export const reviewsTable = pgTable("reviews", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  orderId: text("order_id").notNull(),
  productId: text("product_id").notNull(),
  sellerName: text("seller_name").notNull(),
  rating: integer("rating").notNull(),
  text: text("text").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Review = typeof reviewsTable.$inferSelect;
