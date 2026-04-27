import { pgTable, text, boolean } from "drizzle-orm/pg-core";

export const notificationPrefsTable = pgTable("notification_prefs", {
  userId: text("user_id").primaryKey(),
  liveDrops: boolean("live_drops").notNull().default(true),
  orderUpdates: boolean("order_updates").notNull().default(true),
  marketing: boolean("marketing").notNull().default(false),
  whatsapp: boolean("whatsapp").notNull().default(true),
  sms: boolean("sms").notNull().default(false),
  whatsappNumber: text("whatsapp_number").notNull().default(""),
  smsNumber: text("sms_number").notNull().default(""),
});

export type NotificationPrefsRow = typeof notificationPrefsTable.$inferSelect;
