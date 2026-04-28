import { Router, type IRouter } from "express";
import { eq, and, lt, sql } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { logger } from "../lib/logger";
import { newShipmentEventId } from "../lib/ids";
import { enqueueNotification } from "../lib/notifications";

const router: IRouter = Router();

/**
 * POST /box/unlock
 *
 * Buyer-facing endpoint that the on-locker keypad (or the in-app "I'm at
 * the box" button) calls to unlock their reservation. The OTP is the
 * pickup OTP we generated on `POST /orders` for pickup-point orders.
 *
 * On success: the reservation flips to "collected", a "delivered"
 * shipment event is inserted, the linked order goes to "delivered", and
 * the buyer gets a "Picked up" notification.
 *
 * The OTP comparison is case-insensitive (codes are 4-digit numerics
 * today, but we trim/lower defensively in case future codes use letters).
 */
router.post("/box/unlock", async (req, res) => {
  const body = req.body as { reservationId?: string; otp?: string };
  const reservationId = String(body.reservationId ?? "").trim();
  const otp = String(body.otp ?? "").trim();
  if (!reservationId || !otp) {
    res.status(400).json({ error: "bad_request", detail: "reservationId and otp required" });
    return;
  }
  const [reservation] = await db
    .select()
    .from(schema.boxReservationsTable)
    .where(eq(schema.boxReservationsTable.id, reservationId))
    .limit(1);
  if (!reservation) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (reservation.status === "collected") {
    res.status(409).json({ error: "already_collected" });
    return;
  }
  if (reservation.status === "returned" || reservation.status === "expired") {
    res.status(409).json({ error: "reservation_closed", detail: reservation.status });
    return;
  }
  const [order] = await db
    .select()
    .from(schema.ordersTable)
    .where(eq(schema.ordersTable.id, reservation.orderId))
    .limit(1);
  if (!order) {
    res.status(404).json({ error: "order_not_found" });
    return;
  }
  if (!order.pickupOtp || order.pickupOtp.toLowerCase() !== otp.toLowerCase()) {
    res.status(403).json({ error: "wrong_otp" });
    return;
  }

  const now = new Date();
  await db
    .update(schema.boxReservationsTable)
    .set({ status: "collected", collectedAt: now })
    .where(eq(schema.boxReservationsTable.id, reservationId));

  if (reservation.shipmentId) {
    await db
      .insert(schema.shipmentEventsTable)
      .values({
        id: newShipmentEventId(),
        shipmentId: reservation.shipmentId,
        providerEventId: `box-unlock:${reservationId}`,
        status: "delivered",
        rawStatus: "box_unlocked",
        note: `Picked up from box ${reservation.boxId}`,
        location: reservation.locationId,
        occurredAt: now,
      })
      .onConflictDoNothing();
    await db
      .update(schema.shipmentsTable)
      .set({ status: "delivered", deliveredAt: now })
      .where(eq(schema.shipmentsTable.id, reservation.shipmentId));
  }

  await db
    .update(schema.ordersTable)
    .set({ status: "delivered" })
    .where(eq(schema.ordersTable.id, order.id));

  await enqueueNotification({
    userId: order.userId,
    eventType: "order_delivered",
    payload: {
      title: "Picked up",
      body: `You've collected order ${order.id} from your Epplaa Box.`,
      url: `/orders/${order.id}`,
      orderId: order.id,
    },
  }).catch(() => undefined);

  res.json({ ok: true, reservationId, collectedAtIso: now.toISOString() });
});

/**
 * Internal cron tick: auto-return any box reservations whose hold window
 * has elapsed. Mounted on a setInterval in app.ts (safe to call
 * concurrently — the WHERE clause + status check is idempotent).
 */
export async function autoReturnExpiredBoxReservations(): Promise<{ returned: number }> {
  const now = new Date();
  const expired = await db
    .select()
    .from(schema.boxReservationsTable)
    .where(
      and(
        sql`${schema.boxReservationsTable.status} IN ('reserved','stocked')`,
        lt(schema.boxReservationsTable.expiresAt, now),
      ),
    );
  let returned = 0;
  for (const r of expired) {
    const upd = await db
      .update(schema.boxReservationsTable)
      .set({ status: "returned", returnedAt: now })
      .where(
        and(
          eq(schema.boxReservationsTable.id, r.id),
          sql`${schema.boxReservationsTable.status} IN ('reserved','stocked')`,
        ),
      )
      .returning();
    if (upd.length === 0) continue;
    returned++;
    if (r.shipmentId) {
      await db
        .insert(schema.shipmentEventsTable)
        .values({
          id: newShipmentEventId(),
          shipmentId: r.shipmentId,
          providerEventId: `box-auto-return:${r.id}`,
          status: "returned",
          rawStatus: "auto_return_expired",
          note: `Hold window expired — returned to seller`,
          location: r.locationId,
          occurredAt: now,
        })
        .onConflictDoNothing();
      await db
        .update(schema.shipmentsTable)
        .set({ status: "returned" })
        .where(eq(schema.shipmentsTable.id, r.shipmentId));
    }
    const [order] = await db
      .select({ userId: schema.ordersTable.userId })
      .from(schema.ordersTable)
      .where(eq(schema.ordersTable.id, r.orderId))
      .limit(1);
    if (order) {
      await enqueueNotification({
        userId: order.userId,
        eventType: "box_reservation_expired",
        payload: {
          title: "Box returned to seller",
          body: `Your Box pickup for ${r.orderId} expired. Open a return for a refund.`,
          url: `/orders/${r.orderId}`,
          orderId: r.orderId,
        },
      }).catch(() => undefined);
    }
  }
  if (returned > 0) {
    logger.info({ returned }, "box_reservations_auto_returned");
  }
  return { returned };
}

export default router;
