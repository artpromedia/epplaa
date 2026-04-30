import { pgTable, text, jsonb, timestamp, boolean, integer } from "drizzle-orm/pg-core";

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
  /**
   * Compliance/KYC tier for payouts (distinct from the commercial seller
   * tier above). 1 = phone+email, 2 = government ID + bank verification,
   * 3 = CAC business + UBO declaration. Used by the pre-payout gate to
   * block transfers that exceed the rolling-30d threshold for the tier.
   */
  kycTier: integer("kyc_tier").notNull().default(1),
  /** Earliest the system may run the next quarterly KYC re-screen. */
  nextKycReviewAt: timestamp("next_kyc_review_at", { withTimezone: true }),
  /** Last time sanctions screening cleared this seller. Null = never screened. */
  sanctionsClearedAt: timestamp("sanctions_cleared_at", { withTimezone: true }),
  application: jsonb("application"),
  stats: jsonb("stats"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type Seller = typeof sellersTable.$inferSelect;
