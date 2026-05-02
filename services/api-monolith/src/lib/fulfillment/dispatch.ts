import { and, desc, eq, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { logger } from "../logger";
import { enqueueNotification } from "../notifications";
import {
  newShipmentId,
  newShipmentEventId,
  newBoxReservationId,
} from "../ids";
import { getCarrier } from "./registry";
import { normalizeShipmentStatus } from "./types";
import type {
  DispatchRequest,
  ShippingAddress,
  ShipmentItem,
  TrackingEvent,
} from "./types";

/**
 * Default origin warehouse used when the seller has not configured one.
 * In production this would be looked up per-seller; for now Epplaa's
 * Lagos hub is the canonical pickup origin for all carriers.
 */
const ORIGIN: ShippingAddress = {
  line: "Epplaa Hub, 14 Awolowo Rd",
  area: "Ikoyi",
  city: "Lagos",
  state: "Lagos",
  countryCode: "NG",
  recipientName: "Epplaa",
};

/**
 * Box reservations expire after 72 hours by default — the box auto-returns
 * unsold inventory to the seller after that. Override per-deployment via
 * BOX_RESERVATION_HOURS.
 */
const BOX_HOLD_HOURS = Number(process.env.BOX_RESERVATION_HOURS ?? 72);

/**
 * Look up the buyer's recipient contact (name + phone) from the users
 * table so the carrier label has a real phone number, not a placeholder.
 */
async function loadRecipient(userId: string): Promise<{ name: string; phone: string }> {
  const [u] = await db
    .select({ name: schema.usersTable.displayName, phone: schema.usersTable.phone })
    .from(schema.usersTable)
    .where(eq(schema.usersTable.clerkId, userId))
    .limit(1);
  return { name: u?.name ?? "Buyer", phone: u?.phone ?? "" };
}

/**
 * Build ShipmentItems from the order line snapshot. We use a flat 500g
 * default weight per unit until the products table tracks weight; this
 * keeps stub quotes deterministic and is good enough for the current
 * SKU mix (mostly fashion + small electronics).
 */
function itemsFromOrder(order: typeof schema.ordersTable.$inferSelect): ShipmentItem[] {
  const items = (order.items as Array<{ productId: string; qty: number; priceMinor: number }>) ?? [];
  return items.map((it) => ({
    productId: it.productId,
    qty: it.qty,
    valueMinor: it.priceMinor * it.qty,
  }));
}

function destinationFromOrder(
  order: typeof schema.ordersTable.$inferSelect,
  recipient: { name: string; phone: string },
): ShippingAddress {
  const f = (order.fulfillment as Record<string, unknown>) ?? {};
  const da = (f.deliveryAddress as Record<string, unknown> | undefined) ?? {};
  return {
    line: String(da.street ?? f.locationAddress ?? ""),
    area: String(da.area ?? ""),
    city: String(da.city ?? f.city ?? ""),
    countryCode: order.countryCode,
    lat: typeof da.lat === "number" ? (da.lat as number) : undefined,
    lng: typeof da.lng === "number" ? (da.lng as number) : undefined,
    placeId: typeof da.placeId === "string" ? (da.placeId as string) : undefined,
    recipientName: recipient.name,
    recipientPhone: recipient.phone,
  };
}

/**
 * Create a shipment row and call the chosen carrier's dispatch. Idempotent
 * on orderId via the unique index — if a shipment already exists we
 * return it without re-charging the carrier. Called from
 * `finalizeOrderAfterPayment` immediately after the order is marked paid.
 *
 * Selection rules:
 *  - order.fulfillment.carrier is the explicit choice the buyer made on
 *    the rate-quote screen. If unset (legacy orders) we default to box
 *    when the option looks like a pickup, else shipbubble.
 *  - order.fulfillment.service holds the specific service tier (e.g.
 *    "shipbubble:standard") so the dispatch call uses the same rate the
 *    buyer was quoted.
 */
export async function dispatchShipmentForOrder(orderId: string): Promise<void> {
  const [order] = await db
    .select()
    .from(schema.ordersTable)
    .where(eq(schema.ordersTable.id, orderId))
    .limit(1);
  if (!order) return;

  // Idempotency: if we already dispatched, return early.
  const [existing] = await db
    .select()
    .from(schema.shipmentsTable)
    .where(eq(schema.shipmentsTable.orderId, orderId))
    .limit(1);
  if (existing) return;

  const fulfillment = (order.fulfillment as Record<string, unknown>) ?? {};
  const optionId = String(fulfillment.optionId ?? "");
  const isBox = /\b(box|locker|pudo|pickup|paxi|pargo|speedaf|g4s)\b/i.test(optionId);
  const carrierCode = String(
    fulfillment.carrier ?? (isBox ? "box" : "shipbubble"),
  );
  const service = String(fulfillment.service ?? `${carrierCode}:standard`);
  const rateMinor = Number(fulfillment.rateMinor ?? 0);

  const recipient = await loadRecipient(order.userId);
  const destination = destinationFromOrder(order, recipient);
  const items = itemsFromOrder(order);
  const carrier = getCarrier(carrierCode);

  const dispatchReq: DispatchRequest = {
    orderId,
    service,
    rate: {
      carrier: carrierCode,
      service,
      serviceLabel: String(fulfillment.serviceLabel ?? service),
      priceMinor: rateMinor,
      currencyCode: order.currencyCode,
      etaLabel: order.etaLabel,
      etaDaysMin: 1,
      etaDaysMax: 7,
      raw: (fulfillment.rateRaw as Record<string, unknown> | undefined) ?? {},
    },
    origin: ORIGIN,
    destination,
    items,
    currencyCode: order.currencyCode,
  };

  let result;
  try {
    result = await carrier.dispatch(dispatchReq);
  } catch (err) {
    logger.error({ err: (err as Error).message, orderId, carrier: carrierCode }, "dispatch_failed");
    return;
  }

  const shipmentId = newShipmentId();
  await db.insert(schema.shipmentsTable).values({
    id: shipmentId,
    orderId,
    userId: order.userId,
    carrier: result.carrier,
    service,
    carrierRef: result.carrierRef,
    trackingUrl: result.trackingUrl,
    labelUrl: result.labelUrl,
    quotedPriceMinor: rateMinor,
    currencyCode: order.currencyCode,
    status: normalizeShipmentStatus(result.status),
    address: destination as unknown as Record<string, unknown>,
    dispatchedAt: new Date(),
  });
  await db
    .update(schema.ordersTable)
    .set({ shipmentId, trackingUrl: result.trackingUrl })
    .where(eq(schema.ordersTable.id, orderId));

  // Box reservation — required so the unlock endpoint can match the OTP
  // back to a specific locker. The box id is stable (BX-<orderId-suffix>)
  // so the same locker is reused across retries.
  if (carrierCode === "box") {
    const locationId = String(fulfillment.locationId ?? "");
    if (locationId) {
      const expiresAt = new Date(Date.now() + BOX_HOLD_HOURS * 3600 * 1000);
      const boxId = `BX-${orderId.replace(/[^A-Z0-9]/gi, "").slice(-6).toUpperCase()}`;
      await db
        .insert(schema.boxReservationsTable)
        .values({
          id: newBoxReservationId(),
          orderId,
          shipmentId,
          locationId,
          boxId,
          status: "reserved",
          expiresAt,
        })
        .onConflictDoNothing();
    }
  }

  // Seed the timeline with the initial event so the order detail screen
  // has something to render before the first webhook lands.
  await db.insert(schema.shipmentEventsTable).values({
    id: newShipmentEventId(),
    shipmentId,
    providerEventId: `init:${shipmentId}`,
    status: "label_created",
    rawStatus: result.status,
    note: `Shipment created with ${result.carrier}`,
    location: ORIGIN.city,
  });

  // Notify the buyer with the live tracking link.
  await enqueueNotification({
    userId: order.userId,
    eventType: "order_dispatched",
    payload: {
      title: "Shipment created",
      body: `Your order is on its way. Tracking: ${result.carrierRef}`,
      url: `/orders/${orderId}`,
      orderId,
      trackingUrl: result.trackingUrl,
      carrier: result.carrier,
    },
  }).catch(() => undefined);
}

/**
 * Project tracking events into the shipment_events + orders tables. Called
 * by the webhook handlers and by the on-demand /shipments/:id/refresh
 * route. Idempotent on (shipmentId, providerEventId).
 *
 * If the latest event resolves to "delivered" we flip the order status
 * accordingly so downstream queries (orders list, seller dashboard,
 * payouts) all see the same truth without polling the carrier.
 */
export async function ingestTrackingEvents(
  shipmentId: string,
  events: TrackingEvent[],
): Promise<{ inserted: number; latestStatus?: string }> {
  if (events.length === 0) return { inserted: 0 };
  let inserted = 0;
  for (const ev of events) {
    const status = normalizeShipmentStatus(ev.status);
    const r = await db
      .insert(schema.shipmentEventsTable)
      .values({
        id: newShipmentEventId(),
        shipmentId,
        providerEventId: ev.providerEventId || `${shipmentId}:${ev.occurredAt.getTime()}`,
        status,
        rawStatus: ev.rawStatus,
        note: ev.note,
        location: ev.location,
        occurredAt: ev.occurredAt,
      })
      .onConflictDoNothing();
    if ((r as { rowCount?: number }).rowCount && (r as { rowCount?: number }).rowCount! > 0) inserted++;
  }
  // Determine projected status from the newest event in the DB (not just
  // this batch) so out-of-order webhook deliveries can't regress state.
  // We also guard terminal states: once delivered/returned/cancelled we
  // never overwrite with an in-transit status.
  const TERMINAL = new Set(["delivered", "returned", "cancelled"]);
  const [newest] = await db
    .select({ status: schema.shipmentEventsTable.status, occurredAt: schema.shipmentEventsTable.occurredAt })
    .from(schema.shipmentEventsTable)
    .where(eq(schema.shipmentEventsTable.shipmentId, shipmentId))
    .orderBy(desc(schema.shipmentEventsTable.occurredAt))
    .limit(1);
  const latest = normalizeShipmentStatus(newest?.status ?? events[0]!.status);

  const [current] = await db
    .select({ status: schema.shipmentsTable.status })
    .from(schema.shipmentsTable)
    .where(eq(schema.shipmentsTable.id, shipmentId))
    .limit(1);
  const shouldSkip = current && TERMINAL.has(current.status) && !TERMINAL.has(latest);
  if (!shouldSkip) {
    await db
      .update(schema.shipmentsTable)
      .set({
        status: latest,
        ...(latest === "delivered" ? { deliveredAt: new Date() } : {}),
      })
      .where(eq(schema.shipmentsTable.id, shipmentId));
  }

  // Project onto the order. We only flip the order to "delivered" when
  // the shipment is delivered; intermediate states stay as-is on the
  // order so we don't undo manual seller transitions.
  if (latest === "delivered") {
    const [shipment] = await db
      .select()
      .from(schema.shipmentsTable)
      .where(eq(schema.shipmentsTable.id, shipmentId))
      .limit(1);
    if (shipment) {
      await db
        .update(schema.ordersTable)
        .set({ status: "delivered" })
        .where(and(eq(schema.ordersTable.id, shipment.orderId), sql`${schema.ordersTable.status} <> 'delivered'`));
      await enqueueNotification({
        userId: shipment.userId,
        eventType: "order_delivered",
        payload: {
          title: "Delivered",
          body: `Order ${shipment.orderId} was delivered. Tap to rate.`,
          url: `/orders/${shipment.orderId}`,
          orderId: shipment.orderId,
        },
      }).catch(() => undefined);
      // COD orders skip the payment-gateway path that schedules seller
      // payouts at charge-confirmation time. Delivery is the trigger:
      // the platform only "has" the buyer's cash once the courier or
      // pickup partner confirms collection. scheduleCodPayoutsOnDelivery
      // is a no-op for prepaid orders (gateway != "cod") and idempotent
      // for COD via the partial unique index on payouts(order_id, seller_id).
      const { scheduleCodPayoutsOnDelivery } = await import("../payments");
      await scheduleCodPayoutsOnDelivery(shipment.orderId);
    }
  }
  return { inserted, latestStatus: latest };
}
