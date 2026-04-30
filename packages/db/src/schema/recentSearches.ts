import { pgTable, text, timestamp, serial } from "drizzle-orm/pg-core";

export const recentSearchesTable = pgTable("recent_searches", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  query: text("query").notNull(),
  searchedAt: timestamp("searched_at", { withTimezone: true }).notNull().defaultNow(),
});

export type RecentSearch = typeof recentSearchesTable.$inferSelect;
