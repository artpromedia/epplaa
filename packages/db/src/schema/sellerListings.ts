import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

export const sellerListingsTable = pgTable("seller_listings", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  title: text("title").notNull(),
  priceMinor: integer("price_minor").notNull(),
  countryCode: text("country_code").notNull(),
  category: text("category").notNull().default("Other"),
  inventory: integer("inventory").notNull().default(0),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SellerListing = typeof sellerListingsTable.$inferSelect;
