// Promo codes applied at checkout. Frontend-only — production would validate
// against a server. Codes are case-insensitive on input but stored uppercased
// in checkout draft. All amounts are in minor units of the active country.

import type { Country } from "./countries";

export type PromoKind = "percent" | "fixed_minor" | "free_shipping";

export interface PromoCode {
  code: string;
  label: string;
  kind: PromoKind;
  // For percent: 1–100. For fixed_minor: an amount in major units (multiplied
  // by minorPerMajor at apply time so e.g. 20 = 20 NGN / 20 KES depending on
  // the country, and the cap below is also in major units).
  value: number;
  // Optional max discount cap (major units, multiplied by minorPerMajor).
  maxDiscountMajor?: number;
  // Optional minimum subtotal required (major units).
  minSubtotalMajor?: number;
}

export const PROMO_CODES: Record<string, PromoCode> = {
  WELCOME10: {
    code: "WELCOME10",
    label: "10% off your order",
    kind: "percent",
    value: 10,
    maxDiscountMajor: 5000,
  },
  EPPLAA20: {
    code: "EPPLAA20",
    label: "20% off (max 10K)",
    kind: "percent",
    value: 20,
    maxDiscountMajor: 10000,
    minSubtotalMajor: 5000,
  },
  FIRSTORDER: {
    code: "FIRSTORDER",
    label: "Free shipping",
    kind: "free_shipping",
    value: 0,
  },
  LAGOS500: {
    code: "LAGOS500",
    label: "500 off",
    kind: "fixed_minor",
    value: 500,
    minSubtotalMajor: 2000,
  },
};

export interface PromoApplyResult {
  ok: boolean;
  promo?: PromoCode;
  discountMinor: number; // discount applied to subtotal
  shippingDiscountMinor: number; // discount applied to shipping
  label?: string;
  error?: string;
}

export function lookupPromo(code: string): PromoCode | undefined {
  return PROMO_CODES[code.trim().toUpperCase()];
}

export function applyPromo(
  code: string,
  subtotalMinor: number,
  shippingMinor: number,
  country: Country,
): PromoApplyResult {
  const empty: PromoApplyResult = {
    ok: false,
    discountMinor: 0,
    shippingDiscountMinor: 0,
  };
  if (!code.trim()) return { ...empty, error: "Enter a code" };

  const promo = lookupPromo(code);
  if (!promo) return { ...empty, error: "Code not recognised" };

  const minorPerMajor = country.currency.minorPerMajor;

  if (
    promo.minSubtotalMajor &&
    subtotalMinor < promo.minSubtotalMajor * minorPerMajor
  ) {
    return {
      ...empty,
      promo,
      error: `Spend at least ${promo.minSubtotalMajor.toLocaleString()} ${country.currency.code} to use this code`,
    };
  }

  if (promo.kind === "percent") {
    let discount = Math.floor((subtotalMinor * promo.value) / 100);
    if (promo.maxDiscountMajor) {
      const cap = promo.maxDiscountMajor * minorPerMajor;
      if (discount > cap) discount = cap;
    }
    return {
      ok: true,
      promo,
      discountMinor: discount,
      shippingDiscountMinor: 0,
      label: promo.label,
    };
  }

  if (promo.kind === "fixed_minor") {
    const cap = promo.value * minorPerMajor;
    return {
      ok: true,
      promo,
      discountMinor: Math.min(cap, subtotalMinor),
      shippingDiscountMinor: 0,
      label: promo.label,
    };
  }

  // free_shipping
  return {
    ok: true,
    promo,
    discountMinor: 0,
    shippingDiscountMinor: shippingMinor,
    label: promo.label,
  };
}
