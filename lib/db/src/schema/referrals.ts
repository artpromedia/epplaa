import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

export const referralsTable = pgTable("referrals", {
  userId: text("user_id").primaryKey(),
  code: text("code").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const referralActivityTable = pgTable("referral_activity", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  inviteeHandle: text("invitee_handle").notNull(),
  status: text("status").notNull().default("joined"),
  rewardMinor: integer("reward_minor").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Referral = typeof referralsTable.$inferSelect;
export type ReferralActivity = typeof referralActivityTable.$inferSelect;
