import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

export const payoutsTable = pgTable("payouts", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  status: text("status").notNull().default("pending"),
  bankLabel: text("bank_label").notNull().default(""),
  bankLast4: text("bank_last4").notNull().default("0000"),
  reference: text("reference").notNull().default(""),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  paidAt: timestamp("paid_at", { withTimezone: true }),
});

export type Payout = typeof payoutsTable.$inferSelect;
