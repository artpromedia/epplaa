import { pgTable, text, integer, timestamp, jsonb, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { ordersTable } from "./orders";
import { usersTable } from "./users";

/**
 * Authoritative ledger of money-movement intents. One row per
 * "buyer wants to pay X" or "user wants to top up wallet by X".
 */
export const paymentIntentsTable = pgTable("payment_intents", {
  id: text("id").primaryKey(),
  /**
   * Owning buyer / wallet owner. Real DB-level FK to `users.clerk_id` so a
   * money-movement intent can never be written for a non-existent user
   * (the failure mode the backup verifier's anti-join catches as exit 7).
   * Users are anonymised-in-place by NDPR, never hard-deleted, so default
   * `NO ACTION` is the right semantics.
   */
  userId: text("user_id")
    .notNull()
    .references(() => usersTable.clerkId),
  /** "order" (linked to orders.id) or "wallet_topup" (no order). */
  purpose: text("purpose").notNull(),
  /**
   * Linked order id when `purpose = "order"`, NULL for `"wallet_topup"`.
   * Real DB-level FK to `orders.id` so an order-linked intent can never
   * point at a deleted/missing order. Nullable on purpose: wallet top-ups
   * legitimately have no order to link to.
   */
  orderId: text("order_id").references(() => ordersTable.id),
  /** Selected/initial gateway; failover may move it to the other one. */
  gateway: text("gateway").notNull(),
  /** Stable, single-use reference passed to the gateway (also our public id). */
  reference: text("reference").notNull().unique(),
  amountMinor: integer("amount_minor").notNull(),
  vatMinor: integer("vat_minor").notNull().default(0),
  currencyCode: text("currency_code").notNull(),
  /** "pending" → "processing" → "succeeded" | "failed" | "cancelled" | "refunded". */
  status: text("status").notNull().default("pending"),
  /** Authorization URL returned by the gateway for redirect flows. */
  authorizationUrl: text("authorization_url"),
  /** Free-form metadata snapshot (cart items, fulfillment, etc.). */
  metadata: jsonb("metadata").notNull().default({}),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * Each gateway call (charge / verify / refund / payout) appended to this
 * append-only audit log. `gatewayResponse` is sanitized of secrets before
 * persistence.
 */
export const paymentAttemptsTable = pgTable("payment_attempts", {
  id: text("id").primaryKey(),
  intentId: text("intent_id").notNull(),
  gateway: text("gateway").notNull(),
  /** "charge" | "verify" | "refund" | "payout". */
  kind: text("kind").notNull(),
  /** "ok" | "error". */
  status: text("status").notNull(),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  gatewayReference: text("gateway_reference"),
  responseSummary: jsonb("response_summary"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Idempotency log for inbound webhook deliveries. The `gatewayEventId` is the
 * stable dedupe key the gateway sends (or one we synthesize from the body).
 */
export const paymentWebhooksTable = pgTable(
  "payment_webhooks",
  {
    id: text("id").primaryKey(),
    gateway: text("gateway").notNull(),
    gatewayEventId: text("gateway_event_id").notNull(),
    eventType: text("event_type").notNull(),
    reference: text("reference"),
    signatureValid: boolean("signature_valid").notNull(),
    payload: jsonb("payload").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    processError: text("process_error"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("payment_webhooks_event_uniq").on(t.gateway, t.gatewayEventId)],
);

/**
 * Rolling success/failure counters per gateway. The router uses a 5-minute
 * window: counters reset whenever `windowStartedAt` is older than 5 minutes.
 */
export const gatewayHealthTable = pgTable("gateway_health", {
  gateway: text("gateway").primaryKey(),
  successCount: integer("success_count").notNull().default(0),
  failureCount: integer("failure_count").notNull().default(0),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull().defaultNow(),
  circuitOpenUntil: timestamp("circuit_open_until", { withTimezone: true }),
  lastEventAt: timestamp("last_event_at", { withTimezone: true }),
});

/**
 * Refund attempts initiated against the original gateway. One refund may
 * trigger multiple attempts if the gateway needs retries.
 */
export const refundAttemptsTable = pgTable("refund_attempts", {
  id: text("id").primaryKey(),
  intentId: text("intent_id").notNull(),
  orderId: text("order_id"),
  amountMinor: integer("amount_minor").notNull(),
  reason: text("reason"),
  /** "pending" | "processed" | "failed". */
  status: text("status").notNull().default("pending"),
  gateway: text("gateway").notNull(),
  gatewayReference: text("gateway_reference"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

/**
 * Daily reconciliation run log. `mismatches` is an array of intent / gateway
 * settlement pairs that did not match.
 */
export const reconciliationRunsTable = pgTable("reconciliation_runs", {
  id: text("id").primaryKey(),
  gateway: text("gateway").notNull(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
  ledgerCount: integer("ledger_count").notNull().default(0),
  settlementCount: integer("settlement_count").notNull().default(0),
  matchedCount: integer("matched_count").notNull().default(0),
  mismatches: jsonb("mismatches").notNull().default([]),
  /** "ok" | "discrepancies" | "error". */
  status: text("status").notNull(),
  errorMessage: text("error_message"),
  ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Per-country VAT configuration. `rateBp` is basis points (750 == 7.5%).
 * Stored in the database (not just static config) so finance teams can update
 * rates without redeploying.
 */
export const vatRatesTable = pgTable("vat_rates", {
  countryCode: text("country_code").primaryKey(),
  rateBp: integer("rate_bp").notNull().default(0),
  appliesToB2c: boolean("applies_to_b2c").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type PaymentIntent = typeof paymentIntentsTable.$inferSelect;
export type PaymentAttempt = typeof paymentAttemptsTable.$inferSelect;
export type PaymentWebhook = typeof paymentWebhooksTable.$inferSelect;
export type GatewayHealth = typeof gatewayHealthTable.$inferSelect;
export type RefundAttempt = typeof refundAttemptsTable.$inferSelect;
export type ReconciliationRun = typeof reconciliationRunsTable.$inferSelect;
export type VatRate = typeof vatRatesTable.$inferSelect;
