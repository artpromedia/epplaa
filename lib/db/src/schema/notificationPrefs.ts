import { pgTable, text, boolean, integer } from "drizzle-orm/pg-core";

export const notificationPrefsTable = pgTable("notification_prefs", {
  userId: text("user_id").primaryKey(),
  // Event-type toggles (consulted by the outbox before fan-out).
  liveDrops: boolean("live_drops").notNull().default(true),
  orderUpdates: boolean("order_updates").notNull().default(true),
  marketing: boolean("marketing").notNull().default(false),
  promos: boolean("promos").notNull().default(true),
  referrals: boolean("referrals").notNull().default(true),
  walletCredits: boolean("wallet_credits").notNull().default(true),
  // Channel toggles.
  whatsapp: boolean("whatsapp").notNull().default(true),
  sms: boolean("sms").notNull().default(false),
  push: boolean("push").notNull().default(true),
  email: boolean("email").notNull().default(true),
  whatsappNumber: text("whatsapp_number").notNull().default(""),
  smsNumber: text("sms_number").notNull().default(""),
  // Quiet hours: integer minutes from local midnight (0-1439). When null,
  // quiet hours are disabled regardless of `quietHoursEnabled`.
  quietHoursEnabled: boolean("quiet_hours_enabled").notNull().default(false),
  quietHoursStartMinutes: integer("quiet_hours_start_minutes"),
  quietHoursEndMinutes: integer("quiet_hours_end_minutes"),
  // IANA tz used to evaluate quiet hours. Falls back to country tz when blank.
  timezone: text("timezone").notNull().default(""),
});

export type NotificationPrefsRow = typeof notificationPrefsTable.$inferSelect;
