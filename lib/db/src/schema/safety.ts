import { pgTable, text, boolean, timestamp, primaryKey } from "drizzle-orm/pg-core";

export const safetyReportsTable = pgTable("safety_reports", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  targetKind: text("target_kind").notNull(),
  targetId: text("target_id").notNull(),
  targetLabel: text("target_label").notNull(),
  reason: text("reason").notNull(),
  notes: text("notes").notNull().default(""),
  status: text("status").notNull().default("submitted"),
  blockedAtSubmit: boolean("blocked_at_submit").notNull().default(false),
  /**
   * Linked moderation_cases.id — populated when the report is enqueued
   * into the operator T&S queue. NULL means the report exists but has not
   * (yet) been turned into a queued case (legacy rows or queue write-failure).
   */
  caseId: text("case_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const blockedSellersTable = pgTable(
  "blocked_sellers",
  {
    userId: text("user_id").notNull(),
    sellerName: text("seller_name").notNull(),
    reason: text("reason").notNull().default("manual"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.sellerName] })],
);

export type SafetyReport = typeof safetyReportsTable.$inferSelect;
export type BlockedSeller = typeof blockedSellersTable.$inferSelect;
