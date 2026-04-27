import { Router, type IRouter } from "express";
import { eq, and, desc, inArray } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { requireUserId } from "../lib/auth";
import { newOrderId, newOtp } from "../lib/ids";
import { createPaymentIntent } from "../lib/payments";
import { computeVatMinor, getVatRateBp } from "../lib/vat";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const PICKUP_OPTION_IDS = new Set([
  "epplaa-box", "pudo", "epplaa-box-accra", "speedaf-pickup",
  "epplaa-box-nbo", "g4s-pickup", "pargo-locker", "paxi-pickup",
  "epplaa-box-abj", "pickup-ci",
]);

/**
 * Pay-on-collection (cash) is only allowed at Box / pickup points. The
 * frontend country catalog uses country-suffixed IDs ("cod-ke", "cod-za",
 * "cod-ug", "cod-rw", "cod-et") for clarity; Nigeria still uses bare "cod"
 * for backwards compatibility. Recognize all variants here.
 */
function isCodMethodId(id: string | undefined): boolean {
  if (!id) return false;
  return id === "cod" || id.startsWith("cod-");
}

function rowToOrder(r: typeof schema.ordersTable.$inferSelect) {
  return {
    id: r.id,
    userId: r.userId,
    status: r.status,
    countryCode: r.countryCode,
    currencyCode: r.currencyCode,
    items: r.items,
    fulfillment: r.fulfillment,
    payment: r.payment,
    notificationPrefs: r.notificationPrefs,
    totalsMinor: r.totalsMinor,
    vatMinor: r.vatMinor,
    promo: r.promo ?? undefined,
    pickupOtp: r.pickupOtp,
    etaLabel: r.etaLabel,
    gateway: r.gateway,
    gatewayReference: r.gatewayReference,
    paymentIntentId: r.paymentIntentId,
    paidAtIso: r.paidAt?.toISOString() ?? null,
    holdUntilIso: r.holdUntil?.toISOString() ?? null,
    settledAtIso: r.settledAt?.toISOString() ?? null,
    createdAtIso: r.createdAt.toISOString(),
  };
}

// POST /orders/quote — server-computed totals (VAT eligibility per seller).
// The checkout review UI calls this so the displayed VAT matches what
// /orders will charge (only VAT-registered sellers' lines are taxable).
router.post("/orders/quote", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const body = req.body as Record<string, unknown>;
  const countryCode = String(body.countryCode ?? "NG");
  const totalsRaw = (body.totalsMinor as Record<string, number> | undefined) ?? {};
  const subtotal = Number(totalsRaw.subtotal ?? 0);
  const shipping = Number(totalsRaw.shipping ?? 0);
  const discount = Number(totalsRaw.discount ?? 0);
  const shippingDiscount = Number(totalsRaw.shippingDiscount ?? 0);
  const items = (body.items as Array<{ productId?: string; priceMinor?: number; qty?: number }> | undefined) ?? [];

  const vatRateBp = await getVatRateBp(countryCode);
  let vatEligibleSubtotal = 0;
  if (vatRateBp > 0) {
    const productIds = Array.from(new Set(items.map((it) => String(it.productId ?? "")).filter(Boolean)));
    if (productIds.length > 0) {
      const productRows = await db
        .select({ id: schema.productsTable.id, sellerUserId: schema.productsTable.sellerUserId })
        .from(schema.productsTable)
        .where(inArray(schema.productsTable.id, productIds));
      const productSellerMap = new Map(productRows.map((p) => [p.id, p.sellerUserId]));
      const sellerIds = Array.from(new Set(productRows.map((p) => p.sellerUserId).filter((s): s is string => !!s)));
      let vatRegistered = new Set<string>();
      if (sellerIds.length > 0) {
        const sellerRows = await db
          .select({ userId: schema.sellersTable.userId, vatRegistered: schema.sellersTable.vatRegistered })
          .from(schema.sellersTable)
          .where(inArray(schema.sellersTable.userId, sellerIds));
        vatRegistered = new Set(sellerRows.filter((s) => s.vatRegistered).map((s) => s.userId));
      }
      for (const it of items) {
        const sellerId = productSellerMap.get(String(it.productId ?? "")) ?? null;
        if (sellerId && vatRegistered.has(sellerId)) {
          vatEligibleSubtotal += Number(it.priceMinor ?? 0) * Number(it.qty ?? 0);
        }
      }
    }
  }
  const vatShare = subtotal > 0 ? vatEligibleSubtotal / subtotal : 0;
  const vatTaxable = Math.max(0, vatEligibleSubtotal + (shipping - discount - shippingDiscount) * vatShare);
  const vatMinor = computeVatMinor(Math.round(vatTaxable), vatRateBp);
  const taxable = Math.max(0, subtotal + shipping - discount - shippingDiscount);
  res.json({
    countryCode,
    vatRateBp,
    vatMinor,
    vatEligibleSubtotalMinor: vatEligibleSubtotal,
    totalMinor: taxable + vatMinor,
  });
});

router.get("/orders", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const rows = await db
    .select()
    .from(schema.ordersTable)
    .where(eq(schema.ordersTable.userId, userId))
    .orderBy(desc(schema.ordersTable.createdAt));
  res.json(rows.map(rowToOrder));
});

router.get("/orders/:orderId", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const [row] = await db
    .select()
    .from(schema.ordersTable)
    .where(and(eq(schema.ordersTable.userId, userId), eq(schema.ordersTable.id, req.params.orderId)))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(rowToOrder(row));
});

/**
 * POST /orders — Create the order in pending_payment state, compute VAT, and
 * either:
 *   1) Create a payment intent (returns authorization URL for redirect), OR
 *   2) Mark as placed immediately (Pay-on-Delivery at pickup points).
 *
 * The order remains pending_payment until the gateway webhook fires.
 */
router.post("/orders", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const body = req.body as Record<string, unknown>;

  const id = (body.id as string | undefined) ?? newOrderId();
  const fulfillment = (body.fulfillment as Record<string, unknown> | undefined) ?? {};
  const payment = (body.payment as { methodId?: string; methodLabel?: string } | undefined) ?? {};
  const optionId = String(fulfillment.optionId ?? "");
  const isPickup = PICKUP_OPTION_IDS.has(optionId);
  const needsOtp = isPickup;
  const countryCode = String(body.countryCode ?? "NG");
  const currencyCode = String(body.currencyCode ?? "NGN");

  const isCod = isCodMethodId(payment.methodId);

  // Reject pay-on-delivery for non-pickup options.
  if (isCod && !isPickup) {
    res.status(400).json({ error: "cod_not_allowed", detail: "Pay on collection is only available for Box/PUDO pickups." });
    return;
  }

  // Re-compute VAT server-side (don't trust client totals).
  const totalsRaw = (body.totalsMinor as Record<string, number> | undefined) ?? {};
  const subtotal = Number(totalsRaw.subtotal ?? 0);
  const shipping = Number(totalsRaw.shipping ?? 0);
  const discount = Number(totalsRaw.discount ?? 0);
  const shippingDiscount = Number(totalsRaw.shippingDiscount ?? 0);
  const vatRateBp = await getVatRateBp(countryCode);

  // VAT applies only to line items sold by VAT-registered sellers.
  // Look up the seller for each item, check their `vatRegistered` flag, and
  // build the VAT-eligible subtotal. Shipping / discounts are apportioned
  // pro-rata to the VAT-eligible share so VAT reflects only the registered
  // portion of the order.
  const items = (body.items as Array<{ productId?: string; priceMinor?: number; qty?: number }> | undefined) ?? [];
  const productIds = Array.from(new Set(items.map((it) => String(it.productId ?? "")).filter(Boolean)));
  let vatEligibleSubtotal = 0;
  if (productIds.length > 0 && vatRateBp > 0) {
    const productRows = await db
      .select({ id: schema.productsTable.id, sellerUserId: schema.productsTable.sellerUserId })
      .from(schema.productsTable)
      .where(inArray(schema.productsTable.id, productIds));
    const productSellerMap = new Map<string, string | null>(
      productRows.map((p) => [p.id, p.sellerUserId]),
    );
    const sellerIds = Array.from(
      new Set(productRows.map((p) => p.sellerUserId).filter((s): s is string => !!s)),
    );
    let vatRegisteredSellers = new Set<string>();
    if (sellerIds.length > 0) {
      const sellerRows = await db
        .select({ userId: schema.sellersTable.userId, vatRegistered: schema.sellersTable.vatRegistered })
        .from(schema.sellersTable)
        .where(inArray(schema.sellersTable.userId, sellerIds));
      vatRegisteredSellers = new Set(
        sellerRows.filter((s) => s.vatRegistered).map((s) => s.userId),
      );
    }
    for (const it of items) {
      const sellerId = productSellerMap.get(String(it.productId ?? ""));
      if (sellerId && vatRegisteredSellers.has(sellerId)) {
        vatEligibleSubtotal += Number(it.priceMinor ?? 0) * Number(it.qty ?? 0);
      }
    }
  }
  const vatShare = subtotal > 0 ? vatEligibleSubtotal / subtotal : 0;
  const vatTaxable = Math.max(
    0,
    vatEligibleSubtotal + (shipping - discount - shippingDiscount) * vatShare,
  );
  const vatMinor = computeVatMinor(Math.round(vatTaxable), vatRateBp);
  const taxable = Math.max(0, subtotal + shipping - discount - shippingDiscount);
  const total = taxable + vatMinor;

  const totalsMinor = {
    subtotal,
    shipping,
    discount: discount > 0 ? discount : undefined,
    shippingDiscount: shippingDiscount > 0 ? shippingDiscount : undefined,
    vat: vatMinor > 0 ? vatMinor : undefined,
    vatRateBp,
    total,
  };

  const [row] = await db
    .insert(schema.ordersTable)
    .values({
      id,
      userId,
      status: "pending_payment",
      countryCode,
      currencyCode,
      items: (body.items as unknown[] | undefined) ?? [],
      fulfillment,
      payment,
      notificationPrefs: (body.notificationPrefs as Record<string, unknown> | undefined) ?? {},
      totalsMinor,
      vatMinor,
      promo: (body.promo as Record<string, unknown> | undefined) ?? null,
      pickupOtp: needsOtp ? newOtp() : null,
      etaLabel: String(body.etaLabel ?? ""),
    })
    .returning();

  // Web app and API server share the same proxy host, so this resolves to
  // the public origin the gateway should redirect back to.
  const appOrigin = `${req.protocol}://${req.get("host")}`;
  const userEmail = `${userId}@epplaa.local`; // Real email comes from Clerk JWT in T009.

  let intentResult: Awaited<ReturnType<typeof createPaymentIntent>> | null = null;
  try {
    intentResult = await createPaymentIntent({
      userId,
      email: userEmail,
      purpose: "order",
      orderId: id,
      amountMinor: total,
      vatMinor,
      currencyCode,
      // The processing page route is /checkout/processing/:orderId/:intentId.
      buildCallbackUrl: (intentId) =>
        `${appOrigin}/checkout/processing/${encodeURIComponent(id)}/${encodeURIComponent(intentId)}`,
      manualConfirm: isCod,
      metadata: { orderId: id, optionId, methodId: payment.methodId, minorPerMajor: 100 },
    });
  } catch (err) {
    logger.error({ err: (err as Error).message, orderId: id }, "create_intent_failed");
    // Roll the order back to cancelled so the user can retry.
    await db.update(schema.ordersTable).set({ status: "cancelled" }).where(eq(schema.ordersTable.id, id));
    res.status(502).json({ error: "payment_init_failed", detail: (err as Error).message });
    return;
  }

  // Link intent → order before potentially clearing cart.
  const intent = intentResult.intent;
  await db
    .update(schema.ordersTable)
    .set({
      paymentIntentId: intent.id,
      gateway: intent.gateway,
      gatewayReference: intent.reference,
      // For COD the intent is auto-succeeded; finalize order immediately.
      ...(isCod ? { status: isPickup ? "ready_for_pickup" : "out_for_delivery", paidAt: new Date() } : {}),
    })
    .where(eq(schema.ordersTable.id, id));

  // Only clear cart/draft once we've handed back an intent the user can complete.
  if (isCod) {
    await db.delete(schema.cartItemsTable).where(eq(schema.cartItemsTable.userId, userId));
    await db.delete(schema.checkoutDraftsTable).where(eq(schema.checkoutDraftsTable.userId, userId));
  }

  const fresh = await db
    .select()
    .from(schema.ordersTable)
    .where(eq(schema.ordersTable.id, id))
    .limit(1);
  const order = rowToOrder(fresh[0]);
  res.status(201).json({
    ...order,
    paymentIntent: {
      id: intent.id,
      reference: intent.reference,
      gateway: intent.gateway,
      status: isCod ? "succeeded" : intent.status,
      authorizationUrl: intentResult.authorizationUrl ?? null,
    },
  });
});

router.post("/orders/:orderId/cancel", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const [existing] = await db
    .select()
    .from(schema.ordersTable)
    .where(and(eq(schema.ordersTable.userId, userId), eq(schema.ordersTable.id, req.params.orderId)))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (existing.status === "delivered" || existing.status === "cancelled") {
    res.json(rowToOrder(existing));
    return;
  }
  const [row] = await db
    .update(schema.ordersTable)
    .set({ status: "cancelled" })
    .where(and(eq(schema.ordersTable.userId, userId), eq(schema.ordersTable.id, req.params.orderId)))
    .returning();
  res.json(rowToOrder(row));
});

export default router;
