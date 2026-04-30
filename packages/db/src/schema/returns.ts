import { pgTable, text, integer, jsonb, timestamp } from "drizzle-orm/pg-core";

export const returnsTable = pgTable("returns", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  orderId: text("order_id").notNull(),
  productTitle: text("product_title").notNull(),
  productImage: text("product_image"),
  refundAmountMinor: integer("refund_amount_minor").notNull(),
  currencyCode: text("currency_code").notNull(),
  reason: text("reason").notNull(),
  reasonLabel: text("reason_label").notNull(),
  notes: text("notes").notNull().default(""),
  photoCount: integer("photo_count").notNull().default(0),
  status: text("status").notNull().default("requested"),
  timeline: jsonb("timeline").notNull().default([]),
  dispute: jsonb("dispute").notNull().default([]),
  /** Reverse-pickup label url issued by the carrier (PDF). */
  pickupLabelUrl: text("pickup_label_url").notNull().default(""),
  /** Carrier waybill / tracking id for the reverse pickup. */
  pickupCarrierRef: text("pickup_carrier_ref").notNull().default(""),
  /** Carrier code that issued the reverse label. */
  pickupCarrier: text("pickup_carrier").notNull().default(""),
  /**
   * Linked moderation_cases.id when the return entered `disputed` and was
   * enqueued into the operator dispute queue. NULL otherwise.
   */
  caseId: text("case_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ReturnRow = typeof returnsTable.$inferSelect;
