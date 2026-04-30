import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { requireUserId } from "../lib/auth";
import { requireRole } from "../lib/roles";
import { recordAudit } from "../lib/audit";
import { logger } from "../lib/logger";
import { newBondedInventoryId, newCustomsEventId } from "../lib/manufacturers";
import { enqueueManufacturerPayoutForWholesaleOrder } from "../lib/manufacturerPayouts";

const router: IRouter = Router();

const ADMIN_ROLES = ["admin", "moderator"] as const;

// ---------------------------------------------------------------------------
// Manufacturer onboarding moderation
// ---------------------------------------------------------------------------

router.get("/admin/manufacturers", requireRole(ADMIN_ROLES), async (req, res) => {
  const status = String(req.query.status ?? "");
  const rows = status
    ? await db
        .select()
        .from(schema.manufacturersTable)
        .where(eq(schema.manufacturersTable.status, status))
        .orderBy(desc(schema.manufacturersTable.createdAt))
    : await db.select().from(schema.manufacturersTable).orderBy(desc(schema.manufacturersTable.createdAt));
  res.json(
    rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      originCountry: r.originCountry,
      legalName: r.legalName,
      contactEmail: r.contactEmail,
      contactPhone: r.contactPhone,
      exportLicenceNumber: r.exportLicenceNumber,
      status: r.status,
      createdAtIso: r.createdAt.toISOString(),
      updatedAtIso: r.updatedAt.toISOString(),
    })),
  );
});

router.post("/admin/manufacturers/:manufacturerId/decide", requireRole(ADMIN_ROLES), async (req, res) => {
  const adminId = requireUserId(req, res);
  if (!adminId) return;
  const decision = String((req.body ?? {}).decision ?? "");
  if (decision !== "approve" && decision !== "reject" && decision !== "suspend") {
    res.status(400).json({ error: "bad_request", detail: "decision must be approve|reject|suspend" });
    return;
  }
  const targetStatus = decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "suspended";
  const manufacturerId = String(req.params.manufacturerId ?? "");
  // SELECT first so we can capture the *real* pre-update status for the audit
  // trail — reading row.status off the .returning() row would only show the
  // post-update value, making the audit payload misleading.
  const [pre] = await db
    .select({ id: schema.manufacturersTable.id, status: schema.manufacturersTable.status })
    .from(schema.manufacturersTable)
    .where(eq(schema.manufacturersTable.id, manufacturerId))
    .limit(1);
  if (!pre) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const previousStatus = pre.status;
  const [row] = await db
    .update(schema.manufacturersTable)
    .set({ status: targetStatus })
    .where(eq(schema.manufacturersTable.id, manufacturerId))
    .returning();
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  await recordAudit({
    actorId: adminId,
    action: `admin.manufacturer.${decision}`,
    entity: "manufacturer",
    entityId: row.id,
    payload: { previousStatus, newStatus: targetStatus },
  });
  res.json({ id: row.id, status: row.status });
});

router.post("/admin/manufacturer-kyc/:kycId/decide", requireRole(ADMIN_ROLES), async (req, res) => {
  const adminId = requireUserId(req, res);
  if (!adminId) return;
  const decision = String((req.body ?? {}).decision ?? "");
  const reason = String((req.body ?? {}).reason ?? "");
  if (decision !== "approve" && decision !== "reject") {
    res.status(400).json({ error: "bad_request", detail: "decision must be approve|reject" });
    return;
  }
  const [row] = await db
    .update(schema.manufacturerKycTable)
    .set({
      status: decision === "approve" ? "approved" : "rejected",
      reviewedBy: adminId,
      reviewedAt: new Date(),
      rejectReason: decision === "reject" ? reason : "",
    })
    .where(eq(schema.manufacturerKycTable.id, String(req.params.kycId ?? "")))
    .returning();
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  await recordAudit({
    actorId: adminId,
    action: `admin.manufacturer_kyc.${decision}`,
    entity: "manufacturer_kyc",
    entityId: row.id,
    payload: { manufacturerId: row.manufacturerId, kind: row.kind, reason },
  });
  // If all required docs are approved, auto-approve the manufacturer.
  const REQUIRED = ["export_licence", "business_registration", "tax_id"];
  const docs = await db
    .select()
    .from(schema.manufacturerKycTable)
    .where(eq(schema.manufacturerKycTable.manufacturerId, row.manufacturerId));
  const haveAllRequired = REQUIRED.every((kind) => docs.some((d) => d.kind === kind && d.status === "approved"));
  if (haveAllRequired) {
    const [mfr] = await db
      .update(schema.manufacturersTable)
      .set({ status: "approved" })
      .where(and(eq(schema.manufacturersTable.id, row.manufacturerId), eq(schema.manufacturersTable.status, "pending")))
      .returning();
    if (mfr) {
      await recordAudit({
        actorId: adminId,
        action: "admin.manufacturer.auto_approve",
        entity: "manufacturer",
        entityId: mfr.id,
        payload: { reason: "all_required_kyc_approved" },
      });
    }
  }
  res.json({ id: row.id, status: row.status });
});

// ---------------------------------------------------------------------------
// Customs / freight ops
// ---------------------------------------------------------------------------

router.post("/admin/customs/:wholesaleOrderId/events", requireRole(ADMIN_ROLES), async (req, res) => {
  const adminId = requireUserId(req, res);
  if (!adminId) return;
  const orderId = String(req.params.wholesaleOrderId ?? "");
  const kind = String((req.body ?? {}).kind ?? "");
  const note = String((req.body ?? {}).note ?? "");
  const allowedKinds = [
    "docs_submitted",
    "carrier_pickup",
    "in_transit",
    "arrived_port",
    "customs_filed",
    "duty_paid",
    "released",
    "exception",
  ];
  if (!allowedKinds.includes(kind)) {
    res.status(400).json({ error: "bad_request", detail: "invalid_event_kind" });
    return;
  }
  const [order] = await db
    .select()
    .from(schema.wholesaleOrdersTable)
    .where(eq(schema.wholesaleOrdersTable.id, orderId))
    .limit(1);
  if (!order) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const [event] = await db
    .insert(schema.customsEventsTable)
    .values({
      id: newCustomsEventId(),
      wholesaleOrderId: orderId,
      kind,
      note,
      actorUserId: adminId,
      payload: (req.body ?? {}).payload ?? {},
    })
    .returning();
  // State-machine: certain customs events bump the order status forward.
  let newStatus: string | null = null;
  if (kind === "in_transit" && order.status === "booked") newStatus = "in_transit";
  else if (kind === "arrived_port" && (order.status === "in_transit" || order.status === "booked")) newStatus = "at_customs";
  else if (kind === "released" && order.status === "at_customs") newStatus = "cleared";
  if (newStatus) {
    await db.update(schema.wholesaleOrdersTable).set({ status: newStatus }).where(eq(schema.wholesaleOrdersTable.id, orderId));
  }
  await recordAudit({
    actorId: adminId,
    action: "admin.customs.event",
    entity: "wholesale_order",
    entityId: orderId,
    payload: { kind, note, statusTransition: newStatus },
  });
  res.status(201).json({
    id: event.id,
    kind: event.kind,
    note: event.note,
    payload: event.payload,
    createdAtIso: event.createdAt.toISOString(),
    statusTransition: newStatus,
  });
});

router.post("/admin/freight-bookings/:bookingId/status", requireRole(ADMIN_ROLES), async (req, res) => {
  const adminId = requireUserId(req, res);
  if (!adminId) return;
  const status = String((req.body ?? {}).status ?? "");
  const ref = String((req.body ?? {}).ref ?? "");
  const allowed = ["pending", "booked", "in_transit", "arrived", "delivered", "cancelled"];
  if (!allowed.includes(status)) {
    res.status(400).json({ error: "bad_request", detail: "invalid_status" });
    return;
  }
  const patch: Partial<typeof schema.freightBookingsTable.$inferInsert> = { status };
  if (ref) patch.ref = ref;
  if (status === "delivered") patch.actualEtaIso = new Date().toISOString();
  const [row] = await db
    .update(schema.freightBookingsTable)
    .set(patch)
    .where(eq(schema.freightBookingsTable.id, String(req.params.bookingId ?? "")))
    .returning();
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  await recordAudit({
    actorId: adminId,
    action: "admin.freight_booking.status",
    entity: "freight_booking",
    entityId: row.id,
    payload: { status, ref: row.ref },
  });
  res.json({ id: row.id, status: row.status, ref: row.ref });
});

// ---------------------------------------------------------------------------
// Bonded warehouse handoff
// ---------------------------------------------------------------------------

router.post("/admin/bonded-inventory/:wholesaleOrderId/arrived", requireRole(ADMIN_ROLES), async (req, res) => {
  const adminId = requireUserId(req, res);
  if (!adminId) return;
  const orderId = String(req.params.wholesaleOrderId ?? "");
  const warehouseCode = String((req.body ?? {}).warehouseCode ?? "LOS-BWH-01");
  // Distinguish "qty omitted entirely" from "qty explicitly provided" — the
  // common back-office case is that the whole order arrives at once, so an
  // omitted qty must fall through to order.qty rather than silently defaulting
  // to 1 (which would fragment bonded inventory and delay delivered+payout).
  const rawQty = (req.body ?? {}).qty;
  const qtyProvided = rawQty !== undefined && rawQty !== null && rawQty !== "";
  const parsedQty = qtyProvided ? Math.max(1, Math.floor(Number(rawQty) || 0)) : 0;
  const [order] = await db
    .select()
    .from(schema.wholesaleOrdersTable)
    .where(eq(schema.wholesaleOrdersTable.id, orderId))
    .limit(1);
  if (!order) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const finalQty = qtyProvided ? parsedQty : order.qty;
  const [row] = await db
    .insert(schema.bondedWarehouseInventoryTable)
    .values({
      id: newBondedInventoryId(),
      wholesaleOrderId: orderId,
      warehouseCode,
      qtyOnHand: finalQty,
      qtyReleased: 0,
      arrivedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.bondedWarehouseInventoryTable.wholesaleOrderId,
      set: { warehouseCode, qtyOnHand: finalQty, arrivedAt: new Date() },
    })
    .returning();
  await db.update(schema.wholesaleOrdersTable).set({ status: "warehoused" }).where(eq(schema.wholesaleOrdersTable.id, orderId));
  // Append a customs/timeline event so the manufacturer + seller order pages
  // see the bonded-warehouse arrival in the chronological timeline alongside
  // shipping and customs events. The order-detail UI orders these by
  // createdAt asc so the new "warehouse_arrived" row appears in sequence.
  await db.insert(schema.customsEventsTable).values({
    id: newCustomsEventId(),
    wholesaleOrderId: orderId,
    kind: "warehouse_arrived",
    note: `Arrived at bonded warehouse ${warehouseCode}`,
    actorUserId: adminId,
    payload: { warehouseCode, qty: finalQty },
  });
  await recordAudit({
    actorId: adminId,
    action: "admin.bonded.arrived",
    entity: "wholesale_order",
    entityId: orderId,
    payload: { warehouseCode, qty: finalQty },
  });
  res.status(201).json({
    wholesaleOrderId: orderId,
    warehouseCode: row.warehouseCode,
    qtyOnHand: row.qtyOnHand,
    qtyReleased: row.qtyReleased,
    arrivedAtIso: row.arrivedAt?.toISOString() ?? null,
  });
});

router.post("/admin/bonded-inventory/:wholesaleOrderId/released", requireRole(ADMIN_ROLES), async (req, res) => {
  const adminId = requireUserId(req, res);
  if (!adminId) return;
  const orderId = String(req.params.wholesaleOrderId ?? "");
  // As with /arrived: when qty is omitted entirely, release the full on-hand
  // balance (the canonical "ship everything we have" case). Only clamp when
  // qty was explicitly supplied so we never silently default to 1.
  const rawQty = (req.body ?? {}).qty;
  const qtyProvided = rawQty !== undefined && rawQty !== null && rawQty !== "";
  const parsedQty = qtyProvided ? Math.max(1, Math.floor(Number(rawQty) || 0)) : 0;
  const [bonded] = await db
    .select()
    .from(schema.bondedWarehouseInventoryTable)
    .where(eq(schema.bondedWarehouseInventoryTable.wholesaleOrderId, orderId))
    .limit(1);
  if (!bonded) {
    res.status(404).json({ error: "not_warehoused" });
    return;
  }
  const releaseQty = qtyProvided ? parsedQty : bonded.qtyOnHand;
  if (releaseQty > bonded.qtyOnHand) {
    res.status(400).json({ error: "qty_exceeds_on_hand", qtyOnHand: bonded.qtyOnHand });
    return;
  }
  const newOnHand = bonded.qtyOnHand - releaseQty;
  const [row] = await db
    .update(schema.bondedWarehouseInventoryTable)
    .set({
      qtyOnHand: newOnHand,
      qtyReleased: bonded.qtyReleased + releaseQty,
      releasedAt: newOnHand === 0 ? new Date() : bonded.releasedAt,
      clearedAt: bonded.clearedAt ?? new Date(),
    })
    .where(eq(schema.bondedWarehouseInventoryTable.wholesaleOrderId, orderId))
    .returning();
  // Fully released → mark wholesale order delivered + enqueue manufacturer payout.
  let payoutEnqueued = false;
  if (newOnHand === 0) {
    await db.update(schema.wholesaleOrdersTable).set({ status: "delivered" }).where(eq(schema.wholesaleOrdersTable.id, orderId));
    try {
      payoutEnqueued = await enqueueManufacturerPayoutForWholesaleOrder(orderId);
    } catch (err) {
      logger.error({ err: (err as Error).message, orderId }, "manufacturer_payout_enqueue_failed");
    }
  }
  // Timeline event for bonded release. Mirrors the warehouse_arrived event
  // and is what the manufacturer-portal Order Detail page renders next to
  // customs clearance and freight legs.
  await db.insert(schema.customsEventsTable).values({
    id: newCustomsEventId(),
    wholesaleOrderId: orderId,
    kind: "warehouse_released",
    note:
      newOnHand === 0
        ? `Fully released from bonded warehouse (${releaseQty} units)`
        : `Released ${releaseQty} units; ${newOnHand} remain in bonded warehouse`,
    actorUserId: adminId,
    payload: { releaseQty, qtyOnHand: newOnHand, fullyDelivered: newOnHand === 0 },
  });
  await recordAudit({
    actorId: adminId,
    action: "admin.bonded.released",
    entity: "wholesale_order",
    entityId: orderId,
    payload: { releaseQty, payoutEnqueued, fullyDelivered: newOnHand === 0 },
  });
  res.json({
    wholesaleOrderId: orderId,
    qtyOnHand: row.qtyOnHand,
    qtyReleased: row.qtyReleased,
    releasedAtIso: row.releasedAt?.toISOString() ?? null,
    delivered: newOnHand === 0,
    payoutEnqueued,
  });
});

export default router;
