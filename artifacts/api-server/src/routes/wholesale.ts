import { Router, type IRouter } from "express";
import { and, asc, desc, eq, ilike, inArray, type SQL } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { requireUserId } from "../lib/auth";
import { recordAudit } from "../lib/audit";
import { logger } from "../lib/logger";
import { COUNTRY_BY_CODE } from "../lib/static";
import { computeLandedCost, type ShipMode } from "../lib/landedCost";
import { selectFreightProvider } from "../lib/freight";
import {
  newCustomsEventId,
  newFreightBookingId,
  newWholesaleOrderId,
} from "../lib/manufacturers";

const router: IRouter = Router();

/**
 * Maps a manufacturer_listings row to the seller-facing wholesale catalog
 * shape. Drops the manufacturer's internal sku (kept) but does NOT include
 * the manufacturer's userId — sellers see manufacturerId only.
 */
function rowToCatalogListing(row: typeof schema.manufacturerListingsTable.$inferSelect) {
  return {
    id: row.id,
    manufacturerId: row.manufacturerId,
    sku: row.sku,
    title: row.title,
    description: row.description,
    hsCode: row.hsCode,
    originCountry: row.originCountry,
    originCurrencyCode: row.originCurrencyCode,
    wholesalePriceMinor: row.wholesalePriceMinor,
    moq: row.moq,
    leadDays: row.leadDays,
    weightGrams: row.weightGrams,
    images: row.images,
    category: row.category,
  };
}

function rowToWholesaleOrder(row: typeof schema.wholesaleOrdersTable.$inferSelect) {
  return {
    id: row.id,
    listingId: row.listingId,
    manufacturerId: row.manufacturerId,
    sellerUserId: row.sellerUserId,
    qty: row.qty,
    fobMinor: row.fobMinor,
    originCurrencyCode: row.originCurrencyCode,
    freightMinor: row.freightMinor,
    insuranceMinor: row.insuranceMinor,
    dutyMinor: row.dutyMinor,
    vatMinor: row.vatMinor,
    clearanceMinor: row.clearanceMinor,
    landedTotalMinor: row.landedTotalMinor,
    destinationCurrencyCode: row.destinationCurrencyCode,
    destinationCountryCode: row.destinationCountryCode,
    fxRate: row.fxRate,
    status: row.status,
    freightBookingId: row.freightBookingId,
    etaIso: row.etaIso,
    shipMode: row.shipMode,
    notes: row.notes,
    createdAtIso: row.createdAt.toISOString(),
    updatedAtIso: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Public catalog browse (any signed-in user — sellers placing wholesale orders)
// ---------------------------------------------------------------------------

router.get("/wholesale/listings", async (req, res) => {
  const { search, originCountry, category, hsCode } = req.query as {
    search?: string;
    originCountry?: string;
    category?: string;
    hsCode?: string;
  };
  const conditions: SQL[] = [eq(schema.manufacturerListingsTable.status, "active")];
  if (originCountry) conditions.push(eq(schema.manufacturerListingsTable.originCountry, originCountry));
  if (category) conditions.push(eq(schema.manufacturerListingsTable.category, category));
  if (hsCode) conditions.push(ilike(schema.manufacturerListingsTable.hsCode, `${hsCode}%`));
  if (search) conditions.push(ilike(schema.manufacturerListingsTable.title, `%${search}%`));
  const rows = await db
    .select()
    .from(schema.manufacturerListingsTable)
    .where(and(...conditions))
    .orderBy(desc(schema.manufacturerListingsTable.createdAt));
  res.json(rows.map(rowToCatalogListing));
});

router.get("/wholesale/listings/:listingId", async (req, res) => {
  const [row] = await db
    .select()
    .from(schema.manufacturerListingsTable)
    .where(eq(schema.manufacturerListingsTable.id, String(req.params.listingId ?? "")))
    .limit(1);
  if (!row || row.status !== "active") {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(rowToCatalogListing(row));
});

// ---------------------------------------------------------------------------
// Landed-cost quote (preview before placing an order)
// ---------------------------------------------------------------------------

router.post("/wholesale/quote", async (req, res) => {
  const body = (req.body ?? {}) as {
    listingId?: string;
    qty?: number;
    destinationCountryCode?: string;
    shipMode?: ShipMode;
  };
  const listingId = String(body.listingId ?? "");
  const qty = Math.max(1, Number(body.qty ?? 1));
  const destCountry = String(body.destinationCountryCode ?? "NG");
  const mode: ShipMode = body.shipMode === "sea" ? "sea" : "air";
  const [listing] = await db
    .select()
    .from(schema.manufacturerListingsTable)
    .where(eq(schema.manufacturerListingsTable.id, listingId))
    .limit(1);
  if (!listing || listing.status !== "active") {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (qty < listing.moq) {
    res.status(400).json({ error: "below_moq", moq: listing.moq });
    return;
  }
  const country = COUNTRY_BY_CODE.get(destCountry);
  const destCcy = country?.currency.code ?? "NGN";
  const breakdown = await computeLandedCost({
    fobUnitPriceMinor: listing.wholesalePriceMinor,
    qty,
    originCurrencyCode: listing.originCurrencyCode,
    destinationCurrencyCode: destCcy,
    destinationCountryCode: destCountry,
    hsCode: listing.hsCode,
    shipMode: mode,
    weightGrams: listing.weightGrams,
  });
  res.json({
    listingId: listing.id,
    qty,
    destinationCountryCode: destCountry,
    destinationCurrencyCode: destCcy,
    shipMode: mode,
    leadDays: listing.leadDays + breakdown.etaDays,
    productionLeadDays: listing.leadDays,
    transitDays: breakdown.etaDays,
    breakdown,
  });
});

// ---------------------------------------------------------------------------
// Place a wholesale order (freezes landed cost; books with the forwarder)
// ---------------------------------------------------------------------------

router.post("/wholesale/orders", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const body = (req.body ?? {}) as {
    listingId?: string;
    qty?: number;
    destinationCountryCode?: string;
    shipMode?: ShipMode;
    notes?: string;
  };
  const listingId = String(body.listingId ?? "");
  const qty = Math.max(1, Number(body.qty ?? 1));
  const destCountry = String(body.destinationCountryCode ?? "NG");
  const mode: ShipMode = body.shipMode === "sea" ? "sea" : "air";
  const [listing] = await db
    .select()
    .from(schema.manufacturerListingsTable)
    .where(eq(schema.manufacturerListingsTable.id, listingId))
    .limit(1);
  if (!listing || listing.status !== "active") {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (qty < listing.moq) {
    res.status(400).json({ error: "below_moq", moq: listing.moq });
    return;
  }
  const country = COUNTRY_BY_CODE.get(destCountry);
  const destCcy = country?.currency.code ?? "NGN";
  const breakdown = await computeLandedCost({
    fobUnitPriceMinor: listing.wholesalePriceMinor,
    qty,
    originCurrencyCode: listing.originCurrencyCode,
    destinationCurrencyCode: destCcy,
    destinationCountryCode: destCountry,
    hsCode: listing.hsCode,
    shipMode: mode,
    weightGrams: listing.weightGrams,
  });
  const orderId = newWholesaleOrderId();
  // Book freight first; if the booking errors we still create the order in
  // `draft` so the back office can manually retry. Booked → status=booked.
  let freightBookingId: string | null = null;
  let etaIso: string | null = null;
  let initialStatus = "draft";
  try {
    const provider = selectFreightProvider();
    const booking = await provider.book({
      wholesaleOrderId: orderId,
      originCountry: listing.originCountry,
      destinationCountry: destCountry,
      mode,
      weightGrams: listing.weightGrams,
      qty,
    });
    const [bookingRow] = await db
      .insert(schema.freightBookingsTable)
      .values({
        id: newFreightBookingId(),
        wholesaleOrderId: orderId,
        mode,
        forwarder: booking.provider,
        ref: booking.ref,
        originPort: booking.originPort,
        destinationPort: booking.destinationPort,
        status: booking.status,
        etaIso: booking.etaIso,
        costMinor: booking.costMinor,
        currencyCode: booking.currencyCode,
      })
      .returning();
    freightBookingId = bookingRow.id;
    etaIso = booking.etaIso;
    initialStatus = booking.status === "booked" ? "booked" : "booked"; // both flow into "booked" — manual_email starts paperwork
  } catch (err) {
    logger.error({ err: (err as Error).message, orderId }, "wholesale_freight_book_failed");
  }

  const [orderRow] = await db
    .insert(schema.wholesaleOrdersTable)
    .values({
      id: orderId,
      listingId: listing.id,
      manufacturerId: listing.manufacturerId,
      sellerUserId: userId,
      qty,
      fobMinor: breakdown.fobMinor,
      originCurrencyCode: listing.originCurrencyCode,
      freightMinor: breakdown.freightMinor,
      insuranceMinor: breakdown.insuranceMinor,
      dutyMinor: breakdown.dutyMinor,
      vatMinor: breakdown.vatMinor,
      clearanceMinor: breakdown.clearanceMinor,
      landedTotalMinor: breakdown.landedTotalMinor,
      destinationCurrencyCode: destCcy,
      destinationCountryCode: destCountry,
      fxRate: breakdown.fxRate,
      status: initialStatus,
      freightBookingId,
      etaIso,
      shipMode: mode,
      notes: body.notes ?? "",
    })
    .returning();
  await recordAudit({
    actorId: userId,
    action: "wholesale.order.create",
    entity: "wholesale_order",
    entityId: orderRow.id,
    payload: {
      listingId: listing.id,
      manufacturerId: listing.manufacturerId,
      qty,
      landedTotalMinor: breakdown.landedTotalMinor,
      destination: destCountry,
      mode,
    },
  });
  // Seed timeline with a "docs_submitted" event so the buyer sees activity
  // immediately. Subsequent customs events are appended by the back office.
  try {
    await db.insert(schema.customsEventsTable).values({
      id: newCustomsEventId(),
      wholesaleOrderId: orderRow.id,
      kind: "docs_submitted",
      note: "Order placed — commercial invoice and packing list queued",
      actorUserId: userId,
      payload: { etaIso },
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message, orderId }, "wholesale_seed_event_failed");
  }
  res.status(201).json(rowToWholesaleOrder(orderRow));
});

router.get("/wholesale/orders", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const rows = await db
    .select()
    .from(schema.wholesaleOrdersTable)
    .where(eq(schema.wholesaleOrdersTable.sellerUserId, userId))
    .orderBy(desc(schema.wholesaleOrdersTable.createdAt));
  res.json(rows.map(rowToWholesaleOrder));
});

router.get("/wholesale/orders/:orderId", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const [row] = await db
    .select()
    .from(schema.wholesaleOrdersTable)
    .where(
      and(
        eq(schema.wholesaleOrdersTable.sellerUserId, userId),
        eq(schema.wholesaleOrdersTable.id, String(req.params.orderId ?? "")),
      ),
    )
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const events = await db
    .select()
    .from(schema.customsEventsTable)
    .where(eq(schema.customsEventsTable.wholesaleOrderId, row.id))
    .orderBy(asc(schema.customsEventsTable.createdAt));
  const [booking] = row.freightBookingId
    ? await db
        .select()
        .from(schema.freightBookingsTable)
        .where(eq(schema.freightBookingsTable.id, row.freightBookingId))
        .limit(1)
    : [];
  const [bonded] = await db
    .select()
    .from(schema.bondedWarehouseInventoryTable)
    .where(eq(schema.bondedWarehouseInventoryTable.wholesaleOrderId, row.id))
    .limit(1);
  res.json({
    order: rowToWholesaleOrder(row),
    events: events.map((e) => ({
      id: e.id,
      kind: e.kind,
      note: e.note,
      payload: e.payload,
      createdAtIso: e.createdAt.toISOString(),
    })),
    booking: booking
      ? {
          id: booking.id,
          mode: booking.mode,
          forwarder: booking.forwarder,
          ref: booking.ref,
          originPort: booking.originPort,
          destinationPort: booking.destinationPort,
          status: booking.status,
          etaIso: booking.etaIso,
          actualEtaIso: booking.actualEtaIso,
          costMinor: booking.costMinor,
          currencyCode: booking.currencyCode,
        }
      : null,
    bondedInventory: bonded
      ? {
          warehouseCode: bonded.warehouseCode,
          qtyOnHand: bonded.qtyOnHand,
          qtyReleased: bonded.qtyReleased,
          arrivedAtIso: bonded.arrivedAt?.toISOString() ?? null,
          clearedAtIso: bonded.clearedAt?.toISOString() ?? null,
          releasedAtIso: bonded.releasedAt?.toISOString() ?? null,
        }
      : null,
  });
});

router.post("/wholesale/orders/:orderId/cancel", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const orderId = String(req.params.orderId ?? "");
  // Resolve current status under the seller-ownership filter so we can
  // distinguish "not yours / doesn't exist" (404) from "wrong state" (409).
  const [existing] = await db
    .select({ id: schema.wholesaleOrdersTable.id, status: schema.wholesaleOrdersTable.status })
    .from(schema.wholesaleOrdersTable)
    .where(
      and(
        eq(schema.wholesaleOrdersTable.sellerUserId, userId),
        eq(schema.wholesaleOrdersTable.id, orderId),
      ),
    )
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  // State-machine guard: cancellation is only legal pre-shipment. Once an
  // order is in_transit / at_customs / warehoused / delivered, finance and
  // logistics rely on the lifecycle and a silent "cancelled" flip would
  // corrupt landed-cost reconciliation, freight-cost capture, and the
  // manufacturer payout that fires on delivered transition.
  const CANCELLABLE = new Set(["draft", "booked"]);
  if (!CANCELLABLE.has(existing.status)) {
    res.status(409).json({ error: "wrong_state", currentStatus: existing.status });
    return;
  }
  // Conditional UPDATE so a concurrent state change between SELECT and
  // UPDATE cannot race past the guard — if the status moved, no row is
  // returned and we report the latest state.
  const [row] = await db
    .update(schema.wholesaleOrdersTable)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(schema.wholesaleOrdersTable.sellerUserId, userId),
        eq(schema.wholesaleOrdersTable.id, orderId),
        inArray(schema.wholesaleOrdersTable.status, ["draft", "booked"]),
      ),
    )
    .returning();
  if (!row) {
    res.status(409).json({ error: "wrong_state" });
    return;
  }
  await recordAudit({
    actorId: userId,
    action: "wholesale.order.cancel",
    entity: "wholesale_order",
    entityId: row.id,
    payload: { previousStatus: existing.status },
  });
  res.json(rowToWholesaleOrder(row));
});

export default router;
