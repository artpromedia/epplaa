import { Router, type IRouter } from "express";
import { COUNTRY_BY_CODE, PROMO_CODES } from "../lib/static";

const router: IRouter = Router();

router.post("/promo-codes/apply", (req, res) => {
  const { code, subtotalMinor, shippingMinor, countryCode } = req.body as {
    code?: string;
    subtotalMinor?: number;
    shippingMinor?: number;
    countryCode?: string;
  };
  const empty = { ok: false, discountMinor: 0, shippingDiscountMinor: 0 };
  if (!code || !code.trim()) {
    res.json({ ...empty, error: "Enter a code" });
    return;
  }
  const country = countryCode ? COUNTRY_BY_CODE.get(countryCode) : null;
  if (!country) {
    res.json({ ...empty, error: "Unknown country" });
    return;
  }
  const promo = PROMO_CODES[code.trim().toUpperCase()];
  if (!promo) {
    res.json({ ...empty, error: "Code not recognised" });
    return;
  }
  const subtotal = subtotalMinor ?? 0;
  const shipping = shippingMinor ?? 0;
  const minorPerMajor = country.currency.minorPerMajor;
  if (promo.minSubtotalMajor && subtotal < promo.minSubtotalMajor * minorPerMajor) {
    res.json({
      ...empty,
      promo,
      error: `Spend at least ${promo.minSubtotalMajor.toLocaleString()} ${country.currency.code} to use this code`,
    });
    return;
  }
  if (promo.kind === "percent") {
    let discount = Math.floor((subtotal * promo.value) / 100);
    if (promo.maxDiscountMajor) {
      const cap = promo.maxDiscountMajor * minorPerMajor;
      if (discount > cap) discount = cap;
    }
    res.json({ ok: true, promo, discountMinor: discount, shippingDiscountMinor: 0, label: promo.label });
    return;
  }
  if (promo.kind === "fixed_minor") {
    const cap = promo.value * minorPerMajor;
    res.json({ ok: true, promo, discountMinor: Math.min(cap, subtotal), shippingDiscountMinor: 0, label: promo.label });
    return;
  }
  res.json({ ok: true, promo, discountMinor: 0, shippingDiscountMinor: shipping, label: promo.label });
});

export default router;
