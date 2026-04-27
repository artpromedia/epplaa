import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

export const sellerOrdersTable = pgTable("seller_orders", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  buyerName: text("buyer_name").notNull(),
  buyerHandle: text("buyer_handle").notNull(),
  buyerAvatar: text("buyer_avatar"),
  productTitle: text("product_title").notNull(),
  productImage: text("product_image").notNull().default(""),
  qty: integer("qty").notNull().default(1),
  unitPriceMinor: integer("unit_price_minor").notNull(),
  countryCode: text("country_code").notNull(),
  currencyCode: text("currency_code").notNull(),
  status: text("status").notNull().default("new"),
  fulfillmentLabel: text("fulfillment_label").notNull().default(""),
  pickupOtp: text("pickup_otp"),
  pickupLocationName: text("pickup_location_name"),
  trackingNote: text("tracking_note"),
  placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow(),
  shippedAt: timestamp("shipped_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
});

export type SellerOrder = typeof sellerOrdersTable.$inferSelect;
