import { pgTable, text, integer, real, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";

export const productsTable = pgTable("products", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  priceMinor: integer("price_minor").notNull(),
  originalPriceMinor: integer("original_price_minor"),
  originCountry: text("origin_country").notNull(),
  originLabel: text("origin_label").notNull(),
  sellerName: text("seller_name").notNull(),
  sellerAvatar: text("seller_avatar").notNull().default(""),
  rating: real("rating").notNull().default(0),
  soldCount: integer("sold_count").notNull().default(0),
  isLiveNow: boolean("is_live_now").notNull().default(false),
  images: text("images").array().notNull().default([]),
  variants: jsonb("variants").notNull().default([]),
  category: text("category").notNull().default("Other"),
  countryCode: text("country_code").notNull().default("NG"),
  sellerUserId: text("seller_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Product = typeof productsTable.$inferSelect;
