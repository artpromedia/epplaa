import { Router, type IRouter, type Request } from "express";
import { eq, and, lt, sql } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { logger } from "../lib/logger";
import { newShipmentEventId } from "../lib/ids";
import { enqueueNotification } from "../lib/notifications";
import { scheduleCodPayoutsOnDelivery } from "../lib/payments";

const router: IRouter = Router();

/**
 * In-process anti-bruteforce throttle for /box/unlock.
 *
 *  - Per-reservation: lock out for 15 minutes after 5 wrong OTPs.
 *  - Per-IP: max 30 attempts per minute (covers scanner-style abuse where
 *    one attacker iterates many reservations).
 *
 * This is a best-effort guard. A multi-replica deployment should swap this
 * for Redis-backed counters; the limits chosen are conservative enough
 * that legitimate buyers never hit them.
 */
const RESV_MAX_ATTEMPTS = 5;
const RESV_LOCKOUT_MS = 15 * 60 * 1000;
const IP_WINDOW_MS = 60 * 1000;
const IP_MAX_ATTEMPTS = 30;
const reservationAttempts = new Map<string, { count: number; firstAt: number; lockedUntil: number }>();
const ipAttempts = new Map<string, { count: number; windowStart: number }>();

function clientIp(req: Request): string {
  const xff = req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

function checkAndRecordAttempt(reservationId: string, ip: string, now: number): { ok: true } | { ok: false; reason: string; retryAfterSec: number } {
  const ipRow = ipAttempts.get(ip);
  if (!ipRow || now - ipRow.windowStart > IP_WINDOW_MS) {
    ipAttempts.set(ip, { count: 1, windowStart: now });
  } else {
    ipRow.count++;
    if (ipRow.count > IP_MAX_ATTEMPTS) {
      return { ok: false, reason: "ip_rate_limited", retryAfterSec: Math.ceil((ipRow.windowStart + IP_WINDOW_MS - now) / 1000) };
    }
  }
  const r = reservationAttempts.get(reservationId);
  if (r && r.lockedUntil > now) {
    return { ok: false, reason: "reservation_locked", retryAfterSec: Math.ceil((r.lockedUntil - now) / 1000) };
  }
  return { ok: true };
}

function recordOtpFailure(reservationId: string, now: number): void {
  const r = reservationAttempts.get(reservationId);
  if (!r) {
    reservationAttempts.set(reservationId, { count: 1, firstAt: now, lockedUntil: 0 });
    return;
  }
  r.count++;
  if (r.count >= RESV_MAX_ATTEMPTS) {
    r.lockedUntil = now + RESV_LOCKOUT_MS;
  }
}

function clearOtpAttempts(reservationId: string): void {
  reservationAttempts.delete(reservationId);
}

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
  const ip = clientIp(req);
  const nowMs = Date.now();
  const gate = checkAndRecordAttempt(reservationId, ip, nowMs);
  if (!gate.ok) {
    logger.warn({ reservationId, ip, reason: gate.reason }, "box_unlock_throttled");
    res.setHeader("retry-after", String(gate.retryAfterSec));
    res.status(429).json({ error: gate.reason, retryAfterSec: gate.retryAfterSec });
    return;
  }
  const [reservation] = await db
    .select()
    .from(schema.boxReservationsTable)
    .where(eq(schema.boxReservationsTable.id, reservationId))
    .limit(1);
  if (!reservation) {
    recordOtpFailure(reservationId, nowMs);
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
    recordOtpFailure(reservationId, nowMs);
    res.status(404).json({ error: "order_not_found" });
    return;
  }
  if (!order.pickupOtp || order.pickupOtp.toLowerCase() !== otp.toLowerCase()) {
    recordOtpFailure(reservationId, nowMs);
    logger.warn({ reservationId, ip }, "box_unlock_wrong_otp");
    res.status(403).json({ error: "wrong_otp" });
    return;
  }
  clearOtpAttempts(reservationId);

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

  // COD orders are charged at the box: until the buyer unlocks here, the
  // platform doesn't actually have the cash and so deferred scheduling
  // the seller payout. No-op for prepaid orders; idempotent for COD.
  await scheduleCodPayoutsOnDelivery(order.id);

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
