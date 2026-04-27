import { pgTable, text, jsonb, timestamp, boolean } from "drizzle-orm/pg-core";

export const sellersTable = pgTable("sellers", {
  userId: text("user_id").primaryKey(),
  status: text("status").notNull().default("none"),
  tier: text("tier").notNull().default("starter"),
  mode: text("mode").notNull().default("buyer"),
  /**
   * VAT registration flag. VAT (e.g. NG 7.5%) is only applied to line items
   * sold by VAT-registered sellers. Defaults false; sellers complete tax
   * registration to flip this on (e.g. via the seller-onboarding tax screen).
   */
  vatRegistered: boolean("vat_registered").notNull().default(false),
  application: jsonb("application"),
  stats: jsonb("stats"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type Seller = typeof sellersTable.$inferSelect;
