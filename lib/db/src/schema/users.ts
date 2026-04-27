import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";

export const usersTable = pgTable("users", {
  clerkId: text("clerk_id").primaryKey(),
  email: text("email").notNull(),
  displayName: text("display_name").notNull().default(""),
  avatarUrl: text("avatar_url").notNull().default(""),
  countryCode: text("country_code").notNull().default("NG"),
  // Phone identity. `phone` is the E.164 international form (+234…). We
  // store the country separately so the UI can format/dial correctly even
  // before verification finishes.
  phone: text("phone"),
  phoneCountry: text("phone_country"),
  phoneVerifiedAt: timestamp("phone_verified_at", { withTimezone: true }),
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
