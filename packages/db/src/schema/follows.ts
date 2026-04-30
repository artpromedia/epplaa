import { pgTable, text, primaryKey, timestamp } from "drizzle-orm/pg-core";

export const followsTable = pgTable(
  "follows",
  {
    userId: text("user_id").notNull(),
    sellerName: text("seller_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.sellerName] })],
);

export type Follow = typeof followsTable.$inferSelect;
