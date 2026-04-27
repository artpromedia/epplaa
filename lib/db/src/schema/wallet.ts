import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

export const walletTxnsTable = pgTable("wallet_txns", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  kind: text("kind").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  label: text("label").notNull(),
  refId: text("ref_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const walletSettingsTable = pgTable("wallet_settings", {
  userId: text("user_id").primaryKey(),
  currencyCode: text("currency_code").notNull().default("NGN"),
});

export type WalletTxn = typeof walletTxnsTable.$inferSelect;
export type WalletSettings = typeof walletSettingsTable.$inferSelect;
