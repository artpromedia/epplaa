import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";

export const ordersTable = pgTable("orders", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  status: text("status").notNull().default("placed"),
  countryCode: text("country_code").notNull(),
  currencyCode: text("currency_code").notNull(),
  items: jsonb("items").notNull().default([]),
  fulfillment: jsonb("fulfillment").notNull().default({}),
  payment: jsonb("payment").notNull().default({}),
  notificationPrefs: jsonb("notification_prefs").notNull().default({}),
  totalsMinor: jsonb("totals_minor").notNull().default({}),
  promo: jsonb("promo"),
  pickupOtp: text("pickup_otp"),
  etaLabel: text("eta_label").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Order = typeof ordersTable.$inferSelect;
