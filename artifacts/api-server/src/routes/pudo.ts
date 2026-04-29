import { Router, type IRouter, type Request, type Response } from "express";
import { eq, inArray, or } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { logger } from "../lib/logger";
import { newManifestRunId } from "../lib/ids";
import { ingestTrackingEvents } from "../lib/fulfillment/dispatch";
import { buildManifestCsv } from "../lib/pudo/manifest";

/**
 * PUDO partner endpoints. Third-party pickup-drop-off operators (Pargo,
 * G4S, Speedaf, Paxi, etc.) consume these via a daily cron / mobile
 * scanner integration:
 *
 *   GET  /pudo/:partnerCode/manifest      → CSV of pending shipments
 *   POST /pudo/:partnerCode/collected     → mark shipments collected
 *
 * Auth: per-partner `apiKey` from pudo_partners (preferred), falling back
 * to the shared INTERNAL_API_KEY env var. Shared key is the path used in
 * dev / staging where partner rows haven't been provisioned yet.
 */
const router: IRouter = Router();

async function authPartner(req: Request, res: Response, partnerCode: string): Promise<boolean> {
  const presented = req.header("x-internal-key") ?? "";
  if (!presented) {
    res.status(401).json({ error: "missing_key" });
    return false;
  }
  const [partner] = await db
    .select()
    .from(schema.pudoPartnersTable)
    .where(eq(schema.pudoPartnersTable.code, partnerCode))
    .limit(1);
  if (partner?.apiKey && partner.apiKey === presented) return true;
  const shared = process.env.INTERNAL_API_KEY;
  if (shared && presented === shared) return true;
  res.status(403).json({ error: "forbidden" });
  return false;
}

router.get("/pudo/:partnerCode/manifest", async (req, res) => {
  const partnerCode = req.params.partnerCode;
  if (!(await authPartner(req, res, partnerCode))) return;

  const today = new Date().toISOString().slice(0, 10);
  // CSV generation lives in `lib/pudo/manifest.ts` so the daily push
  // cron (`lib/pudo/delivery.ts`, task #16) and this pull endpoint
  // produce byte-identical bytes — that's what makes `contentHash` a
  // useful dedupe key across both code paths.
  const built = await buildManifestCsv(partnerCode);
  if (built.locationIds.length === 0) {
    res.status(404).json({ error: "no_locations_for_partner" });
    return;
  }

  // Audit row — one per (partner, day). Re-runs on the same day update
  // the count + content hash so we can detect when nothing has changed.
  // We DO NOT touch the delivery columns here (`status`, `destination`,
  // `delivered_at`, `attempts`, `last_error`) — those are owned by the
  // cron and overwriting them on a partner pull would lie about the
  // push delivery state.
  await db
    .insert(schema.pudoManifestRunsTable)
    .values({
      id: newManifestRunId(),
      partnerCode,
      forDate: today,
      shipmentCount: built.shipmentCount,
      contentHash: built.contentHash,
    })
    .onConflictDoUpdate({
      target: [schema.pudoManifestRunsTable.partnerCode, schema.pudoManifestRunsTable.forDate],
      set: {
        shipmentCount: built.shipmentCount,
        contentHash: built.contentHash,
        createdAt: new Date(),
      },
    });

  res
    .setHeader("content-type", "text/csv; charset=utf-8")
    .setHeader("content-disposition", `attachment; filename="${partnerCode}-${today}.csv"`)
    .send(built.csv);
});

router.post("/pudo/:partnerCode/collected", async (req, res) => {
  const partnerCode = req.params.partnerCode;
  if (!(await authPartner(req, res, partnerCode))) return;
  const body = req.body as { shipmentIds?: unknown };
  const ids = Array.isArray(body.shipmentIds) ? body.shipmentIds.map(String).filter(Boolean) : [];
  if (ids.length === 0) {
    res.status(400).json({ error: "bad_request", detail: "shipmentIds required" });
    return;
  }
  // Resolve order ids → shipment rows so the partner doesn't need to know
  // our internal shipment ids; they can submit either order ids or
  // shipment ids and we accept both.
  // Authorization: limit shipments this partner may mutate to those whose
  // pickup location is owned by them (via fulfillment_locations.partnerCode).
  const partnerLocs = await db
    .select({ id: schema.fulfillmentLocationsTable.id })
    .from(schema.fulfillmentLocationsTable)
    .where(eq(schema.fulfillmentLocationsTable.partnerCode, partnerCode));
  const allowedLocIds = new Set(partnerLocs.map((l) => l.id));
  if (allowedLocIds.size === 0) {
    res.status(403).json({ error: "no_locations_for_partner" });
    return;
  }

  const candidateShipments = await db
    .select()
    .from(schema.shipmentsTable)
    .where(
      or(
        inArray(schema.shipmentsTable.id, ids),
        inArray(schema.shipmentsTable.orderId, ids),
      ),
    );
  if (candidateShipments.length === 0) {
    res.json({ ok: true, processed: 0, rejected: ids.length });
    return;
  }
  // Filter by the order's pickup location ownership.
  const orderIds = Array.from(new Set(candidateShipments.map((s) => s.orderId)));
  const ownerOrders = await db
    .select({ id: schema.ordersTable.id, fulfillment: schema.ordersTable.fulfillment })
    .from(schema.ordersTable)
    .where(inArray(schema.ordersTable.id, orderIds));
  const orderLoc = new Map(
    ownerOrders.map((o) => [o.id, String((o.fulfillment as { locationId?: string } | null)?.locationId ?? "")]),
  );
  const shipments = candidateShipments.filter((s) => allowedLocIds.has(orderLoc.get(s.orderId) ?? ""));

  let processed = 0;
  for (const s of shipments) {
    // Deterministic event id per (partner, shipment) so retries dedupe via
    // the (shipmentId, providerEventId) unique constraint.
    await ingestTrackingEvents(s.id, [
      {
        providerEventId: `pudo-collected:${partnerCode}:${s.id}`,
        status: "delivered",
        rawStatus: "picked_up_pudo",
        note: `Collected at ${partnerCode}`,
        location: partnerCode,
        occurredAt: new Date(),
      },
    ]);
    processed++;
  }
  const rejected = candidateShipments.length - processed;
  logger.info({ partnerCode, processed, rejected }, "pudo_collected_processed");
  res.json({ ok: true, processed, rejected });
});

export default router;
