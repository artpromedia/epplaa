import { pgTable, text, primaryKey, timestamp } from "drizzle-orm/pg-core";

export const recentlyViewedTable = pgTable(
  "recently_viewed",
  {
    userId: text("user_id").notNull(),
    productId: text("product_id").notNull(),
    viewedAt: timestamp("viewed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.productId] })],
);

export type RecentlyViewed = typeof recentlyViewedTable.$inferSelect;
