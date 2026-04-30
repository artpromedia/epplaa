import { pgTable, text, integer } from "drizzle-orm/pg-core";

export const promoCodesTable = pgTable("promo_codes", {
  code: text("code").primaryKey(),
  label: text("label").notNull(),
  kind: text("kind").notNull(),
  value: integer("value").notNull(),
  maxDiscountMajor: integer("max_discount_major"),
  minSubtotalMajor: integer("min_subtotal_major"),
});

export type PromoCode = typeof promoCodesTable.$inferSelect;
