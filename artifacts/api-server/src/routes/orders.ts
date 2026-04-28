import { Router, type IRouter } from "express";
import { eq, and, desc, inArray } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { addressFingerprint, verifyVerificationToken } from "../lib/fulfillment/verifyToken";
import { requireUserId } from "../lib/auth";
import { newOrderId, newOtp } from "../lib/ids";
import { createPaymentIntent } from "../lib/payments";
import { computeVatMinor, getVatRateBp } from "../lib/vat";
import { logger } from "../lib/logger";
import { enqueueNotification } from "../lib/notifications";

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
    shipmentId: r.shipmentId ?? null,
    trackingUrl: r.trackingUrl ?? null,
    paidAtIso: r.paidAt?.toISOString() ?? null,
    holdUntilIso: r.holdUntil?.toISOString() ?? null,
    settledAtIso: r.settledAt?.toISOString() ?? null,
    createdAtIso: r.createdAt.toISOString(),
  };
}

/**
 * Project a shipment + its events into the order detail payload. Returned
 * as `shipment` on `GET /orders/:id`. Null when the order has not been
 * dispatched yet (e.g. cash on delivery, unpaid).
 */
async function loadShipmentForOrder(orderId: string) {
  const [shipment] = await db
    .select()
    .from(schema.shipmentsTable)
    .where(eq(schema.shipmentsTable.orderId, orderId))
    .limit(1);
  if (!shipment) return null;
  const events = await db
    .select()
    .from(schema.shipmentEventsTable)
    .where(eq(schema.shipmentEventsTable.shipmentId, shipment.id))
    .orderBy(desc(schema.shipmentEventsTable.occurredAt));
  return {
    id: shipment.id,
    orderId: shipment.orderId,
    carrier: shipment.carrier,
    service: shipment.service,
    carrierRef: shipment.carrierRef,
    trackingUrl: shipment.trackingUrl,
    labelUrl: shipment.labelUrl,
    status: shipment.status,
    quotedPriceMinor: shipment.quotedPriceMinor,
    currencyCode: shipment.currencyCode,
    shippedAtIso: shipment.dispatchedAt?.toISOString() ?? null,
    deliveredAtIso: shipment.deliveredAt?.toISOString() ?? null,
    events: events.map((e) => ({
      id: e.id,
      status: e.status,
      rawStatus: e.rawStatus,
      note: e.note,
      location: e.location,
      occurredAtIso: e.occurredAt.toISOString(),
    })),
  };
}

/**
 * Server-side totals computation. Item prices are ALWAYS resolved from the
 * products table — client-supplied priceMinor is ignored to prevent
 * tampering. Returns the canonical line snapshot, subtotal, vat, total, and
 * vatRateBp. Used by both /orders/quote and POST /orders so the displayed
 * quote and the charged total are guaranteed identical.
 */
type ClientItemInput = { productId?: string; qty?: number };
type ResolvedLine = {
  productId: string;
  qty: number;
  priceMinor: number;
  sellerUserId: string | null;
  vatEligible: boolean;
};
async function resolveOrderTotals(opts: {
  items: ClientItemInput[];
  countryCode: string;
  shipping: number;
  discount: number;
  shippingDiscount: number;
}): Promise<{
  lines: ResolvedLine[];
  subtotal: number;
  vatEligibleSubtotal: number;
  vatRateBp: number;
  vatMinor: number;
  total: number;
}> {
  const cleanItems = opts.items
    .map((it) => ({
      productId: String(it.productId ?? "").trim(),
      qty: Math.max(0, Math.floor(Number(it.qty ?? 0))),
    }))
    .filter((it) => it.productId && it.qty > 0);
  const productIds = Array.from(new Set(cleanItems.map((it) => it.productId)));
  const productRows = productIds.length
    ? await db
        .select({
          id: schema.productsTable.id,
          priceMinor: schema.productsTable.priceMinor,
          sellerUserId: schema.productsTable.sellerUserId,
        })
        .from(schema.productsTable)
        .where(inArray(schema.productsTable.id, productIds))
    : [];
  const productMap = new Map(productRows.map((p) => [p.id, p]));
  const sellerIds = Array.from(
    new Set(productRows.map((p) => p.sellerUserId).filter((s): s is string => !!s)),
  );
  const sellerRows = sellerIds.length
    ? await db
        .select({
          userId: schema.sellersTable.userId,
          vatRegistered: schema.sellersTable.vatRegistered,
        })
        .from(schema.sellersTable)
        .where(inArray(schema.sellersTable.userId, sellerIds))
    : [];
  const vatRegistered = new Set(
    sellerRows.filter((s) => s.vatRegistered).map((s) => s.userId),
  );
  const vatRateBp = await getVatRateBp(opts.countryCode);

  const lines: ResolvedLine[] = [];
  let subtotal = 0;
  let vatEligibleSubtotal = 0;
  for (const it of cleanItems) {
    const p = productMap.get(it.productId);
    if (!p) continue; // unknown product — drop silently (do not let client fabricate lines)
    const lineSubtotal = p.priceMinor * it.qty;
    subtotal += lineSubtotal;
    const isVatEligible = !!p.sellerUserId && vatRegistered.has(p.sellerUserId);
    if (isVatEligible) vatEligibleSubtotal += lineSubtotal;
    lines.push({
      productId: p.id,
      qty: it.qty,
      priceMinor: p.priceMinor,
      sellerUserId: p.sellerUserId,
      vatEligible: isVatEligible,
    });
  }
  const vatShare = subtotal > 0 ? vatEligibleSubtotal / subtotal : 0;
  const vatTaxable = Math.max(
    0,
    vatEligibleSubtotal + (opts.shipping - opts.discount - opts.shippingDiscount) * vatShare,
  );
  const vatMinor = computeVatMinor(Math.round(vatTaxable), vatRateBp);
  const taxable = Math.max(
    0,
    subtotal + opts.shipping - opts.discount - opts.shippingDiscount,
  );
  return {
    lines,
    subtotal,
    vatEligibleSubtotal,
    vatRateBp,
    vatMinor,
    total: taxable + vatMinor,
  };
}

router.post("/orders/quote", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const body = req.body as Record<string, unknown>;
  const countryCode = String(body.countryCode ?? "NG");
  const totalsRaw = (body.totalsMinor as Record<string, number> | undefined) ?? {};
  const items = (body.items as ClientItemInput[] | undefined) ?? [];
  const computed = await resolveOrderTotals({
    items,
    countryCode,
    shipping: Math.max(0, Number(totalsRaw.shipping ?? 0)),
    discount: Math.max(0, Number(totalsRaw.discount ?? 0)),
    shippingDiscount: Math.max(0, Number(totalsRaw.shippingDiscount ?? 0)),
  });
  res.json({
    countryCode,
    vatRateBp: computed.vatRateBp,
    vatMinor: computed.vatMinor,
    vatEligibleSubtotalMinor: computed.vatEligibleSubtotal,
    totalMinor: computed.total,
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
  const shipment = await loadShipmentForOrder(row.id);
  res.json({ ...rowToOrder(row), shipment });
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

  // Server-side address verification gate. Home delivery requires the
  // signed verification token issued by /fulfillment/verify-address, and
  // the token's bound address fingerprint must match the order's
  // deliveryAddress. This makes the check tamper-proof: a client cannot
  // fabricate a placeId / confidencePct without a real OkHi round-trip.
  if (!isPickup) {
    const deliveryAddress =
      (fulfillment.deliveryAddress as
        | { line?: unknown; area?: unknown; city?: unknown; lat?: unknown; lng?: unknown }
        | undefined) ?? {};
    const addrLine = String(deliveryAddress.line ?? "").trim();
    const addrArea = String(deliveryAddress.area ?? "").trim();
    const addrCity = String(deliveryAddress.city ?? "").trim();
    const addrLat = typeof deliveryAddress.lat === "number" ? deliveryAddress.lat : undefined;
    const addrLng = typeof deliveryAddress.lng === "number" ? deliveryAddress.lng : undefined;
    if (!addrLine) {
      res.status(400).json({ error: "bad_request", detail: "deliveryAddress required for home delivery" });
      return;
    }
    const expectedHash = addressFingerprint({
      countryCode,
      line: addrLine,
      area: addrArea,
      city: addrCity,
      lat: addrLat,
      lng: addrLng,
    });
    const token = String(fulfillment.verificationToken ?? "");
    const verdict = verifyVerificationToken(token, { addrHash: expectedHash, minConfidence: 70 });
    if (!verdict.ok) {
      res.status(400).json({
        error: "address_not_verified",
        detail: `Home delivery requires a verified address (${verdict.reason}). Please re-verify or choose Box/PUDO pickup.`,
      });
      return;
    }
    // Persist the verified placeId on the fulfillment payload (don't
    // trust the client's copy) so dispatch + downstream auditing read
    // the server-validated value.
    fulfillment.placeId = verdict.placeId;
    (deliveryAddress as Record<string, unknown>).confidencePct = verdict.confidencePct;
  }

  // Resolve totals + line snapshot server-side. Client-supplied priceMinor
  // and subtotal/total are NEVER trusted — only productId + qty are honored.
  const totalsRaw = (body.totalsMinor as Record<string, number> | undefined) ?? {};
  const shipping = Math.max(0, Number(totalsRaw.shipping ?? 0));
  const discount = Math.max(0, Number(totalsRaw.discount ?? 0));
  const shippingDiscount = Math.max(0, Number(totalsRaw.shippingDiscount ?? 0));
  const computed = await resolveOrderTotals({
    items: (body.items as ClientItemInput[] | undefined) ?? [],
    countryCode,
    shipping,
    discount,
    shippingDiscount,
  });
  if (computed.lines.length === 0) {
    res.status(400).json({ error: "no_valid_items" });
    return;
  }
  const subtotal = computed.subtotal;
  const vatMinor = computed.vatMinor;
  const total = computed.total;
  const vatRateBp = computed.vatRateBp;

  // Persist the server-resolved snapshot. Downstream split/payout math
  // (finalizeOrderAfterPayment) reads order.items[*].priceMinor — that
  // must come from the products table, never from the request body.
  const itemsSnapshot = computed.lines.map((l) => ({
    productId: l.productId,
    qty: l.qty,
    priceMinor: l.priceMinor,
    sellerUserId: l.sellerUserId,
  }));

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
      items: itemsSnapshot,
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
  // Order placed event. For COD this is the final settled state — fire
  // both placed + paid so the buyer's WhatsApp / push reflects reality.
  await enqueueNotification({
    userId,
    eventType: "order_placed",
    payload: {
      title: "Order placed",
      body: `Order ${id} confirmed. Total ${currencyCode} ${(total / 100).toFixed(2)}.`,
      url: `/orders/${id}`,
      orderId: id,
    },
  }).catch((err) => logger.error({ err: (err as Error).message }, "notify_order_placed_failed"));
  if (isCod) {
    const eventType = isPickup ? "order_ready_for_pickup" : "order_dispatched";
    await enqueueNotification({
      userId,
      eventType,
      payload: {
        title: isPickup ? "Ready for pickup" : "On the way",
        body: isPickup
          ? `Pickup code: ${fresh[0].pickupOtp ?? ""}. Show this at the Box.`
          : `Order ${id} is on the way to you.`,
        url: `/orders/${id}`,
        orderId: id,
      },
    }).catch(() => undefined);
  }
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
