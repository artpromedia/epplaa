import { pgTable, text, boolean, timestamp } from "drizzle-orm/pg-core";

export const onboardingTable = pgTable("onboarding", {
  userId: text("user_id").primaryKey(),
  completed: boolean("completed").notNull().default(false),
  interests: text("interests").array().notNull().default([]),
  notificationsOptIn: boolean("notifications_opt_in").notNull().default(false),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export type OnboardingRow = typeof onboardingTable.$inferSelect;
