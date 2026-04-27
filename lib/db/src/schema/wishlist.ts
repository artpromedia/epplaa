import { pgTable, text, primaryKey, timestamp } from "drizzle-orm/pg-core";

export const wishlistTable = pgTable(
  "wishlist",
  {
    userId: text("user_id").notNull(),
    productId: text("product_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.productId] })],
);

export type WishlistRow = typeof wishlistTable.$inferSelect;
