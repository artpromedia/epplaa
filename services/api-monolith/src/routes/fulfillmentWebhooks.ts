import { Router, type IRouter, type Request, type Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { logger } from "../lib/logger";
import { ingestTrackingEvents } from "../lib/fulfillment/dispatch";
import { normalizeShipmentStatus, type TrackingEvent } from "../lib/fulfillment/types";

/**
 * Carrier tracking webhooks. Mounted under /api/fulfillment/webhooks/* with
 * `express.raw()` so HMAC verification (when a secret is configured) sees
 * the exact bytes the carrier signed. Same idempotency guarantee as
 * payment webhooks: duplicate deliveries with the same providerEventId are
 * dropped by a unique index on shipment_events.
 *
 * When the carrier secret env var is unset we accept the webhook without
 * signature checks — that's the dev / preview mode and is logged so it's
 * obvious in production logs that signing isn't enforced.
 */
const router: IRouter = Router();

router.post("/shipbubble", (req, res) =>
  handleWebhook("shipbubble", process.env.SHIPBUBBLE_WEBHOOK_SECRET, "x-shipbubble-signature", req, res),
);
router.post("/gig", (req, res) =>
  handleWebhook("gig", process.env.GIG_WEBHOOK_SECRET, "x-gig-signature", req, res),
);

interface ShipbubbleEvent {
  order_id?: string;
  tracking_id?: string;
  status?: string;
  description?: string;
  location?: string;
  date?: string;
  event_id?: string | number;
}

interface ShipbubblePayload {
  data?: ShipbubbleEvent | ShipbubbleEvent[];
  event?: string;
}

interface GigEvent {
  Waybill?: string;
  Status?: string;
  Description?: string;
  ScanLocation?: string;
  ScanDate?: string;
  EventId?: string | number;
}

async function handleWebhook(
  carrier: string,
  secret: string | undefined,
  signatureHeader: string,
  req: Request,
  res: Response,
): Promise<void> {
  const rawBody: Buffer = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}), "utf8");

  if (secret) {
    const sig = req.header(signatureHeader) ?? "";
    if (!verifyHmac(rawBody, sig, secret)) {
      logger.warn({ carrier, signatureHeader }, "fulfillment_webhook_bad_signature");
      // Always 200 so the carrier doesn't disable the endpoint, but log.
      res.status(200).json({ ok: false, reason: "invalid_signature" });
      return;
    }
  } else {
    // Fail-closed in production: refuse unsigned webhooks when no secret
    // is configured. In dev/test we accept and log so local simulators
    // (and the carrier stub mode) keep working.
    if (process.env.NODE_ENV === "production") {
      logger.error({ carrier }, "fulfillment_webhook_no_secret_configured");
      res.status(503).json({ ok: false, reason: "webhook_secret_not_configured" });
      return;
    }
    logger.warn({ carrier }, "fulfillment_webhook_unsigned_accepted");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    res.status(200).json({ ok: false, reason: "invalid_json" });
    return;
  }

  try {
    const grouped = carrier === "gig"
      ? extractGigEvents(payload)
      : extractShipbubbleEvents(payload);

    let totalInserted = 0;
    for (const [carrierRef, events] of grouped) {
      const [shipment] = await db
        .select()
        .from(schema.shipmentsTable)
        .where(and(eq(schema.shipmentsTable.carrier, carrier), eq(schema.shipmentsTable.carrierRef, carrierRef)))
        .limit(1);
      if (!shipment) {
        logger.warn({ carrier, carrierRef }, "fulfillment_webhook_unknown_shipment");
        continue;
      }
      const r = await ingestTrackingEvents(shipment.id, events);
      totalInserted += r.inserted;
    }
    res.status(200).json({ ok: true, inserted: totalInserted });
  } catch (err) {
    logger.error({ carrier, err: (err as Error).message }, "fulfillment_webhook_process_error");
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
}

function verifyHmac(body: Buffer, signature: string, secret: string): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  // Length-constant compare. timingSafeEqual throws on length mismatch so
  // pad both sides to a fixed length first.
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature.replace(/^sha256=/, ""), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function extractShipbubbleEvents(payload: unknown): Map<string, TrackingEvent[]> {
  const out = new Map<string, TrackingEvent[]>();
  const p = payload as ShipbubblePayload;
  const list = Array.isArray(p.data) ? p.data : p.data ? [p.data] : [];
  for (const ev of list) {
    const ref = String(ev.tracking_id ?? ev.order_id ?? "");
    if (!ref) continue;
    const arr = out.get(ref) ?? [];
    arr.push({
      providerEventId: String(ev.event_id ?? `${ref}:${ev.date ?? Date.now()}`),
      status: String(ev.status ?? "in_transit"),
      rawStatus: String(ev.status ?? ""),
      note: String(ev.description ?? ""),
      location: String(ev.location ?? ""),
      occurredAt: ev.date ? new Date(ev.date) : new Date(),
    });
    out.set(ref, arr);
  }
  return out;
}

function extractGigEvents(payload: unknown): Map<string, TrackingEvent[]> {
  const out = new Map<string, TrackingEvent[]>();
  const p = payload as { events?: GigEvent[]; Object?: GigEvent } & GigEvent;
  const list: GigEvent[] = Array.isArray(p.events)
    ? p.events
    : p.Object
      ? [p.Object]
      : p.Waybill
        ? [p]
        : [];
  for (const ev of list) {
    const ref = String(ev.Waybill ?? "");
    if (!ref) continue;
    const arr = out.get(ref) ?? [];
    const status = normalizeShipmentStatus(String(ev.Status ?? "in_transit"));
    arr.push({
      providerEventId: String(ev.EventId ?? `${ref}:${ev.ScanDate ?? Date.now()}`),
      status,
      rawStatus: String(ev.Status ?? ""),
      note: String(ev.Description ?? ""),
      location: String(ev.ScanLocation ?? ""),
      occurredAt: ev.ScanDate ? new Date(ev.ScanDate) : new Date(),
    });
    out.set(ref, arr);
  }
  return out;
}

export default router;
