import { pgTable, text, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const payoutsTable = pgTable("payouts", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  /** Seller user id when this payout pays out a seller share; same as userId for wallet withdrawals. */
  sellerId: text("seller_id"),
  /** Linked order whose split this payout is fulfilling (null for wallet withdrawals / batch payouts). */
  orderId: text("order_id"),
  /** Linked payment intent. */
  intentId: text("intent_id"),
  amountMinor: integer("amount_minor").notNull(),
  currencyCode: text("currency_code").notNull().default("NGN"),
  /** "pending" | "scheduled" | "processing" | "paid" | "failed" */
  status: text("status").notNull().default("pending"),
  /** "seller_share" | "wallet_withdrawal" | "manufacturer_share" */
  kind: text("kind").notNull().default("seller_share"),
  /** Gateway used to send the transfer ("paystack" | "flutterwave" | "devmock"). */
  gateway: text("gateway"),
  /** Gateway transfer reference / id. */
  gatewayReference: text("gateway_reference"),
  bankLabel: text("bank_label").notNull().default(""),
  bankCode: text("bank_code").notNull().default(""),
  bankLast4: text("bank_last4").notNull().default("0000"),
  /**
   * Full destination account number for wallet withdrawals. Required by the
   * payout gateway; stored here because non-seller users have no
   * `sellers.application` row to read from. Empty string for seller-share /
   * manufacturer-share payouts (those resolve via the seller's bank profile).
   */
  bankAccount: text("bank_account").notNull().default(""),
  /** Account holder name (defaults to "Epplaa Seller" when missing). */
  bankAccountName: text("bank_account_name").notNull().default(""),
  reference: text("reference").notNull().default(""),
  /** Hold release time — funds cannot be paid out before this. */
  holdUntil: timestamp("hold_until", { withTimezone: true }),
  errorMessage: text("error_message"),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  paidAt: timestamp("paid_at", { withTimezone: true }),
}, (t) => [
  /**
   * Idempotency guard for seller-share payouts: at most one payout row per
   * (order, seller). Prevents double payouts if `finalizeOrderAfterPayment`
   * runs concurrently for the same order or if a webhook is replayed.
   */
  uniqueIndex("payouts_order_seller_share_uniq")
    .on(t.orderId, t.sellerId)
    .where(sql`${t.kind} = 'seller_share' AND ${t.orderId} IS NOT NULL`),
  /**
   * Same idempotency guard for manufacturer-share payouts so a replayed
   * webhook cannot double-pay a manufacturer.
   */
  uniqueIndex("payouts_order_manufacturer_share_uniq")
    .on(t.orderId, t.sellerId)
    .where(sql`${t.kind} = 'manufacturer_share' AND ${t.orderId} IS NOT NULL`),
]);

export type Payout = typeof payoutsTable.$inferSelect;
