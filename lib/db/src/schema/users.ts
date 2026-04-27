import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";

export const usersTable = pgTable("users", {
  clerkId: text("clerk_id").primaryKey(),
  email: text("email").notNull(),
  displayName: text("display_name").notNull().default(""),
  avatarUrl: text("avatar_url").notNull().default(""),
  countryCode: text("country_code").notNull().default("NG"),
  addresses: jsonb("addresses")
    .$type<Record<string, unknown>[]>()
    .notNull()
    .default([]),
  paymentMethods: jsonb("payment_methods")
    .$type<Record<string, unknown>[]>()
    .notNull()
    .default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type User = typeof usersTable.$inferSelect;
