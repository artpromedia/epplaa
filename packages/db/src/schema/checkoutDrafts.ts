import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";

export const checkoutDraftsTable = pgTable("checkout_drafts", {
  userId: text("user_id").primaryKey(),
  draft: jsonb("draft").notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type CheckoutDraftRow = typeof checkoutDraftsTable.$inferSelect;
