import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { requireUserId } from "../lib/auth";
import { newReturnId, newWalletTxnId } from "../lib/ids";
import { logger } from "../lib/logger";
import { openModerationCase } from "../lib/moderation";
import { getCarrier } from "../lib/fulfillment";
import type { DispatchRequest, ShippingAddress } from "../lib/fulfillment";

const router: IRouter = Router();

interface TimelineEvent {
  status: string;
  atIso: string;
  note?: string;
}
interface DisputeMessage {
  id: string;
  actor: "buyer" | "seller" | "epplaa";
  body: string;
  atIso: string;
}

function rowToReturn(r: typeof schema.returnsTable.$inferSelect) {
  return {
    id: r.id,
    userId: r.userId,
    orderId: r.orderId,
    productTitle: r.productTitle,
    productImage: r.productImage,
    refundAmountMinor: r.refundAmountMinor,
    currencyCode: r.currencyCode,
    reason: r.reason,
    reasonLabel: r.reasonLabel,
    notes: r.notes,
    photoCount: r.photoCount,
    status: r.status,
    timeline: r.timeline,
    dispute: r.dispute,
    pickupLabelUrl: r.pickupLabelUrl || null,
    pickupCarrierRef: r.pickupCarrierRef || null,
    pickupCarrier: r.pickupCarrier || null,
    createdAtIso: r.createdAt.toISOString(),
  };
}

async function maybeRefundWallet(userId: string, ret: typeof schema.returnsTable.$inferSelect) {
  if (ret.status !== "refunded") return;
  const existing = await db
    .select({ id: schema.walletTxnsTable.id })
    .from(schema.walletTxnsTable)
    .where(
      and(
        eq(schema.walletTxnsTable.userId, userId),
        eq(schema.walletTxnsTable.refId, ret.id),
        eq(schema.walletTxnsTable.kind, "refund"),
      ),
    )
    .limit(1);
  if (existing.length > 0) return;
  await db.insert(schema.walletTxnsTable).values({
    id: newWalletTxnId(),
    userId,
    kind: "refund",
    amountMinor: ret.refundAmountMinor,
    label: `Refund ${ret.id}`,
    refId: ret.id,
  });
}

router.get("/returns", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const rows = await db
    .select()
    .from(schema.returnsTable)
    .where(eq(schema.returnsTable.userId, userId))
    .orderBy(desc(schema.returnsTable.createdAt));
  res.json(rows.map(rowToReturn));
});

router.get("/returns/:returnId", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const [row] = await db
    .select()
    .from(schema.returnsTable)
    .where(and(eq(schema.returnsTable.userId, userId), eq(schema.returnsTable.id, req.params.returnId)))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(rowToReturn(row));
});

router.post("/returns", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const body = req.body as Record<string, unknown>;
  const id = newReturnId();
  const now = new Date().toISOString();
  const initial: TimelineEvent[] = [{ status: "requested", atIso: now }];
  const [row] = await db
    .insert(schema.returnsTable)
    .values({
      id,
      userId,
      orderId: String(body.orderId ?? ""),
      productTitle: String(body.productTitle ?? ""),
      productImage: (body.productImage as string | undefined) ?? null,
      refundAmountMinor: Number(body.refundAmountMinor ?? 0),
      currencyCode: String(body.currencyCode ?? "NGN"),
      reason: String(body.reason ?? "other"),
      reasonLabel: String(body.reasonLabel ?? "Other"),
      notes: String(body.notes ?? ""),
      photoCount: Number(body.photoCount ?? 0),
      status: "requested",
      timeline: initial,
      dispute: [],
    })
    .returning();
  res.status(201).json(rowToReturn(row));
});

router.post("/returns/:returnId/transitions", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const status = String((req.body as { status?: string }).status ?? "");
  if (!status) {
    res.status(400).json({ error: "bad_request", detail: "status required" });
    return;
  }
  const [existing] = await db
    .select()
    .from(schema.returnsTable)
    .where(and(eq(schema.returnsTable.userId, userId), eq(schema.returnsTable.id, req.params.returnId)))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const timeline = ([...(existing.timeline as TimelineEvent[])]).concat([{ status, atIso: new Date().toISOString() }]);
  const [row] = await db
    .update(schema.returnsTable)
    .set({ status, timeline })
    .where(eq(schema.returnsTable.id, existing.id))
    .returning();
  await maybeRefundWallet(userId, row);
  // When the return enters `disputed`, enqueue a dispute case for the
  // operator queue. Idempotent: if the row already has a `case_id` we skip.
  if (status === "disputed" && !row.caseId) {
    try {
      const caseId = await openModerationCase({
        kind: "dispute",
        targetKind: "return",
        targetId: row.id,
        severity: "normal",
        evidence: {
          returnId: row.id,
          orderId: row.orderId,
          refundAmountMinor: row.refundAmountMinor,
          currencyCode: row.currencyCode,
          reason: row.reason,
          reasonLabel: row.reasonLabel,
        },
        sourceUserId: userId,
      });
      await db
        .update(schema.returnsTable)
        .set({ caseId })
        .where(eq(schema.returnsTable.id, row.id));
      row.caseId = caseId;
    } catch (err) {
      logger.error({ err: (err as Error).message, returnId: row.id }, "return_dispute_case_open_failed");
    }
  }
  res.json(rowToReturn(row));
});

/**
 * POST /returns/:returnId/pickup-label
 *
 * Issue a reverse-pickup label for a return. The original shipment's
 * carrier is used by default (so the buyer drops the parcel back where
 * the rider can collect it most easily). Idempotent: a return that
 * already has a label returns the existing one rather than creating a
 * second waybill.
 */
router.post("/returns/:returnId/pickup-label", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const [ret] = await db
    .select()
    .from(schema.returnsTable)
    .where(and(eq(schema.returnsTable.userId, userId), eq(schema.returnsTable.id, req.params.returnId)))
    .limit(1);
  if (!ret) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  // Idempotent reuse.
  if (ret.pickupLabelUrl && ret.pickupCarrierRef) {
    res.json({
      labelUrl: ret.pickupLabelUrl,
      carrierRef: ret.pickupCarrierRef,
      carrier: ret.pickupCarrier,
      reused: true,
    });
    return;
  }

  const [order] = await db
    .select()
    .from(schema.ordersTable)
    .where(eq(schema.ordersTable.id, ret.orderId))
    .limit(1);
  if (!order) {
    res.status(404).json({ error: "order_not_found" });
    return;
  }
  const [shipment] = await db
    .select()
    .from(schema.shipmentsTable)
    .where(eq(schema.shipmentsTable.orderId, ret.orderId))
    .limit(1);
  // Fall back to Shipbubble when the original shipment is missing (legacy
  // orders) so the buyer can still get a return label.
  const carrierCode = shipment?.carrier ?? "shipbubble";
  const carrier = getCarrier(carrierCode);

  const fulfillment = (order.fulfillment as Record<string, unknown>) ?? {};
  const da = (fulfillment.deliveryAddress as Record<string, unknown> | undefined) ?? {};
  const pickupAddress: ShippingAddress = {
    line: String(da.street ?? ""),
    area: String(da.area ?? ""),
    city: String(da.city ?? ""),
    countryCode: order.countryCode,
    lat: typeof da.lat === "number" ? (da.lat as number) : undefined,
    lng: typeof da.lng === "number" ? (da.lng as number) : undefined,
    placeId: typeof da.placeId === "string" ? (da.placeId as string) : undefined,
  };

  const dispatchReq: DispatchRequest = {
    orderId: order.id,
    service: shipment?.service ?? `${carrierCode}:standard`,
    rate: {
      carrier: carrierCode,
      service: shipment?.service ?? `${carrierCode}:standard`,
      serviceLabel: "Reverse pickup",
      priceMinor: 0,
      currencyCode: order.currencyCode,
      etaLabel: "1-3 business days",
      etaDaysMin: 1,
      etaDaysMax: 3,
      raw: {},
    },
    origin: pickupAddress,
    destination: {
      line: "Epplaa Returns Hub",
      area: "Ikoyi",
      city: "Lagos",
      countryCode: "NG",
    },
    items: ((order.items as Array<{ productId: string; qty: number; priceMinor: number }>) ?? []).map((it) => ({
      productId: it.productId,
      qty: it.qty,
      valueMinor: it.priceMinor * it.qty,
    })),
    currencyCode: order.currencyCode,
  };

  let label;
  try {
    label = await carrier.reverse(dispatchReq);
  } catch (err) {
    logger.error({ err: (err as Error).message, returnId: ret.id }, "reverse_label_failed");
    res.status(502).json({ error: "carrier_failed", detail: (err as Error).message });
    return;
  }

  const timeline = ([...(ret.timeline as TimelineEvent[])]).concat([
    { status: "label_issued", atIso: new Date().toISOString(), note: `Reverse pickup ${label.carrierRef}` },
  ]);
  const [updated] = await db
    .update(schema.returnsTable)
    .set({
      pickupLabelUrl: label.labelUrl,
      pickupCarrierRef: label.carrierRef,
      pickupCarrier: carrierCode,
      timeline,
    })
    .where(eq(schema.returnsTable.id, ret.id))
    .returning();
  if (shipment) {
    await db
      .update(schema.shipmentsTable)
      .set({ reverseLabelUrl: label.labelUrl, reverseCarrierRef: label.carrierRef })
      .where(eq(schema.shipmentsTable.id, shipment.id));
  }
  res.json({
    labelUrl: updated.pickupLabelUrl,
    carrierRef: updated.pickupCarrierRef,
    carrier: updated.pickupCarrier,
    trackingUrl: label.trackingUrl,
    reused: false,
  });
});

router.post("/returns/:returnId/messages", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const body = req.body as { actor?: string; body?: string };
  if (!body.actor || !body.body) {
    res.status(400).json({ error: "bad_request" });
    return;
  }
  const [existing] = await db
    .select()
    .from(schema.returnsTable)
    .where(and(eq(schema.returnsTable.userId, userId), eq(schema.returnsTable.id, req.params.returnId)))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const dispute: DisputeMessage[] = ([...(existing.dispute as DisputeMessage[])]).concat([
    {
      id: `msg_${Date.now().toString(36)}`,
      actor: body.actor as DisputeMessage["actor"],
      body: body.body,
      atIso: new Date().toISOString(),
    },
  ]);
  const [row] = await db.update(schema.returnsTable).set({ dispute }).where(eq(schema.returnsTable.id, existing.id)).returning();
  res.json(rowToReturn(row));
});

export default router;
