import { pgTable, text, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const walletTxnsTable = pgTable(
  "wallet_txns",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    /** "topup" | "spend" | "withdrawal" | "refund" | "promo" */
    kind: text("kind").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    label: text("label").notNull(),
    refId: text("ref_id"),
    /** "pending" | "succeeded" | "failed" — top-ups & withdrawals start pending. */
    status: text("status").notNull().default("succeeded"),
    /** Linked payment intent for top-ups, or payout id for withdrawals. */
    intentId: text("intent_id"),
    payoutId: text("payout_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * Hard idempotency for wallet credits derived from a payment intent.
     * Prevents double-credit if the gateway re-delivers the webhook while a
     * verify call is in flight, or if two webhook workers race.
     */
    uniqueIndex("wallet_txns_topup_intent_uniq")
      .on(t.intentId)
      .where(sql`${t.kind} = 'topup' AND ${t.intentId} IS NOT NULL`),
    uniqueIndex("wallet_txns_withdrawal_payout_uniq")
      .on(t.payoutId)
      .where(sql`${t.kind} = 'withdrawal' AND ${t.payoutId} IS NOT NULL`),
  ],
);

export const walletSettingsTable = pgTable("wallet_settings", {
  userId: text("user_id").primaryKey(),
  currencyCode: text("currency_code").notNull().default("NGN"),
});

export type WalletTxn = typeof walletTxnsTable.$inferSelect;
export type WalletSettings = typeof walletSettingsTable.$inferSelect;
