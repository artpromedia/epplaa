import { pgTable, text, jsonb, timestamp, integer } from "drizzle-orm/pg-core";

export const ordersTable = pgTable("orders", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  /**
   * Order lifecycle:
   *   pending_payment → placed → ready_for_pickup | out_for_delivery → delivered
   *   pending_payment → cancelled (gateway failure / user abandon)
   *   any non-terminal → cancelled (manual)
   *   delivered → refunded (full refund)
   */
  status: text("status").notNull().default("pending_payment"),
  countryCode: text("country_code").notNull(),
  currencyCode: text("currency_code").notNull(),
  items: jsonb("items").notNull().default([]),
  fulfillment: jsonb("fulfillment").notNull().default({}),
  payment: jsonb("payment").notNull().default({}),
  notificationPrefs: jsonb("notification_prefs").notNull().default({}),
  /**
   * Snapshot of price components: subtotal, shipping, vat, discount,
   * shippingDiscount, total. The vat field is also broken out into the
   * dedicated `vatMinor` column for finance reporting.
   */
  totalsMinor: jsonb("totals_minor").notNull().default({}),
  vatMinor: integer("vat_minor").notNull().default(0),
  promo: jsonb("promo"),
  pickupOtp: text("pickup_otp"),
  etaLabel: text("eta_label").notNull().default(""),
  /** Gateway used for the original charge ("paystack" / "flutterwave" / "devmock" / "cod"). */
  gateway: text("gateway"),
  /** The payment intent reference / gateway transaction reference. */
  gatewayReference: text("gateway_reference"),
  /** Payment intent foreign key. */
  paymentIntentId: text("payment_intent_id"),
  /** When the gateway confirmed payment. */
  paidAt: timestamp("paid_at", { withTimezone: true }),
  /** When funds become eligible for seller payout (paidAt + tier hold days). */
  holdUntil: timestamp("hold_until", { withTimezone: true }),
  /** When funds were released to the seller as a payout. */
  settledAt: timestamp("settled_at", { withTimezone: true }),
  /**
   * Concurrency guard for buyer self-serve refunds. Set via a CAS update
   * (`SET refund_started_at = now() WHERE id = ? AND refund_started_at IS NULL`)
   * before calling the gateway, so two simultaneous refund POSTs cannot
   * both fire `gw.refund(...)` for the same order. Cleared back to NULL
   * only if the gateway call fails before any side-effects, leaving the
   * row available for retry.
   */
  refundStartedAt: timestamp("refund_started_at", { withTimezone: true }),
  /** Linked shipment id (set by dispatch on payment captured). */
  shipmentId: text("shipment_id"),
  /** Carrier-specific tracking URL (set when shipment dispatched). */
  trackingUrl: text("tracking_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Order = typeof ordersTable.$inferSelect;
