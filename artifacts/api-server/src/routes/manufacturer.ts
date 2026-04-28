import { Router, type IRouter } from "express";
import { and, asc, desc, eq } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { requireUserId } from "../lib/auth";
import { recordAudit } from "../lib/audit";
import { logger } from "../lib/logger";
import {
  getManufacturerForUser,
  newManufacturerId,
  newManufacturerKycId,
  newManufacturerListingId,
  requireManufacturer,
  type ManufacturerRequest,
} from "../lib/manufacturers";
import { SUPPORTED_ORIGIN_CURRENCIES } from "../lib/fx";
import { validateHsCode } from "../lib/customs";

const router: IRouter = Router();

/**
 * Returns the rendered Manufacturer view of a Postgres row. Drops timestamps
 * to ISO so the client doesn't have to deal with Date instances.
 */
function rowToManufacturer(row: typeof schema.manufacturersTable.$inferSelect) {
  return {
    id: row.id,
    userId: row.userId,
    originCountry: row.originCountry,
    legalName: row.legalName,
    contactEmail: row.contactEmail,
    contactPhone: row.contactPhone,
    exportLicenceNumber: row.exportLicenceNumber,
    status: row.status,
    application: row.application,
    createdAtIso: row.createdAt.toISOString(),
    updatedAtIso: row.updatedAt.toISOString(),
  };
}

function rowToKyc(row: typeof schema.manufacturerKycTable.$inferSelect) {
  return {
    id: row.id,
    manufacturerId: row.manufacturerId,
    kind: row.kind,
    documentUrl: row.documentUrl,
    status: row.status,
    reviewedBy: row.reviewedBy,
    reviewedAtIso: row.reviewedAt?.toISOString() ?? null,
    rejectReason: row.rejectReason,
    createdAtIso: row.createdAt.toISOString(),
    updatedAtIso: row.updatedAt.toISOString(),
  };
}

function rowToListing(row: typeof schema.manufacturerListingsTable.$inferSelect) {
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
    dimensions: row.dimensions,
    images: row.images,
    category: row.category,
    status: row.status,
    createdAtIso: row.createdAt.toISOString(),
    updatedAtIso: row.updatedAt.toISOString(),
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
// Manufacturer profile + onboarding
// ---------------------------------------------------------------------------

router.get("/manufacturer/me", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const mfr = await getManufacturerForUser(userId);
  if (!mfr) {
    res.json({ status: "none", manufacturer: null });
    return;
  }
  res.json({ status: mfr.status, manufacturer: rowToManufacturer(mfr) });
});

router.post("/manufacturer/apply", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const body = (req.body ?? {}) as {
    originCountry?: string;
    legalName?: string;
    contactEmail?: string;
    contactPhone?: string;
    exportLicenceNumber?: string;
    application?: Record<string, unknown>;
  };
  if (!body.originCountry || !body.legalName) {
    res.status(400).json({ error: "bad_request", detail: "origin_country and legal_name required" });
    return;
  }
  const existing = await getManufacturerForUser(userId);
  if (existing) {
    // Allow editing the application until approved.
    if (existing.status === "approved" || existing.status === "suspended") {
      res.status(409).json({ error: "manufacturer_already_finalised", status: existing.status });
      return;
    }
    const [updated] = await db
      .update(schema.manufacturersTable)
      .set({
        originCountry: body.originCountry,
        legalName: body.legalName,
        contactEmail: body.contactEmail ?? existing.contactEmail,
        contactPhone: body.contactPhone ?? existing.contactPhone,
        exportLicenceNumber: body.exportLicenceNumber ?? existing.exportLicenceNumber,
        application: body.application ?? existing.application,
      })
      .where(eq(schema.manufacturersTable.id, existing.id))
      .returning();
    await recordAudit({
      actorId: userId,
      action: "manufacturer.apply.update",
      entity: "manufacturer",
      entityId: updated.id,
      payload: { originCountry: updated.originCountry },
    });
    res.json({ status: updated.status, manufacturer: rowToManufacturer(updated) });
    return;
  }
  const [row] = await db
    .insert(schema.manufacturersTable)
    .values({
      id: newManufacturerId(),
      userId,
      originCountry: body.originCountry,
      legalName: body.legalName,
      contactEmail: body.contactEmail ?? "",
      contactPhone: body.contactPhone ?? "",
      exportLicenceNumber: body.exportLicenceNumber ?? "",
      application: body.application ?? {},
      status: "pending",
    })
    .returning();
  await recordAudit({
    actorId: userId,
    action: "manufacturer.apply.create",
    entity: "manufacturer",
    entityId: row.id,
    payload: { originCountry: row.originCountry, legalName: row.legalName },
  });
  res.status(201).json({ status: row.status, manufacturer: rowToManufacturer(row) });
});

// ---------------------------------------------------------------------------
// KYC documents (any logged-in manufacturer can list/upload, even if pending)
// ---------------------------------------------------------------------------

router.get("/manufacturer/kyc", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const mfr = await getManufacturerForUser(userId);
  if (!mfr) {
    res.status(403).json({ error: "manufacturer_required" });
    return;
  }
  const rows = await db
    .select()
    .from(schema.manufacturerKycTable)
    .where(eq(schema.manufacturerKycTable.manufacturerId, mfr.id))
    .orderBy(desc(schema.manufacturerKycTable.createdAt));
  res.json(rows.map(rowToKyc));
});

router.post("/manufacturer/kyc", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const mfr = await getManufacturerForUser(userId);
  if (!mfr) {
    res.status(403).json({ error: "manufacturer_required" });
    return;
  }
  const body = (req.body ?? {}) as { kind?: string; documentUrl?: string };
  const kind = String(body.kind ?? "").trim();
  const documentUrl = String(body.documentUrl ?? "").trim();
  const allowed = ["export_licence", "business_registration", "tax_id", "ubo", "factory_audit"];
  if (!allowed.includes(kind)) {
    res.status(400).json({ error: "bad_request", detail: "invalid_kind" });
    return;
  }
  if (!documentUrl) {
    res.status(400).json({ error: "bad_request", detail: "document_url_required" });
    return;
  }
  const [row] = await db
    .insert(schema.manufacturerKycTable)
    .values({
      id: newManufacturerKycId(),
      manufacturerId: mfr.id,
      kind,
      documentUrl,
      status: "pending",
    })
    .returning();
  await recordAudit({
    actorId: userId,
    action: "manufacturer.kyc.upload",
    entity: "manufacturer_kyc",
    entityId: row.id,
    payload: { manufacturerId: mfr.id, kind },
  });
  res.status(201).json(rowToKyc(row));
});

// ---------------------------------------------------------------------------
// Wholesale catalog (manufacturer-side CRUD)
// ---------------------------------------------------------------------------

router.get("/manufacturer/listings", requireManufacturer, async (req, res) => {
  const mfr = (req as ManufacturerRequest).manufacturer;
  const rows = await db
    .select()
    .from(schema.manufacturerListingsTable)
    .where(eq(schema.manufacturerListingsTable.manufacturerId, mfr.id))
    .orderBy(desc(schema.manufacturerListingsTable.createdAt));
  res.json(rows.map(rowToListing));
});

router.post("/manufacturer/listings", requireManufacturer, async (req, res) => {
  const mfr = (req as ManufacturerRequest).manufacturer;
  const body = (req.body ?? {}) as {
    sku?: string;
    title: string;
    description?: string;
    hsCode: string;
    originCurrencyCode: string;
    wholesalePriceMinor: number;
    moq?: number;
    leadDays?: number;
    weightGrams?: number;
    dimensions?: Record<string, unknown>;
    images?: string[];
    category?: string;
  };
  if (!body.title || typeof body.wholesalePriceMinor !== "number" || body.wholesalePriceMinor <= 0) {
    res.status(400).json({ error: "bad_request", detail: "title and wholesalePriceMinor required" });
    return;
  }
  if (!SUPPORTED_ORIGIN_CURRENCIES.includes(body.originCurrencyCode as never)) {
    res.status(400).json({ error: "bad_request", detail: "unsupported_currency" });
    return;
  }
  const hsErr = validateHsCode(body.hsCode);
  if (hsErr) {
    res.status(400).json({ error: "bad_request", detail: hsErr });
    return;
  }
  const [row] = await db
    .insert(schema.manufacturerListingsTable)
    .values({
      id: newManufacturerListingId(),
      manufacturerId: mfr.id,
      sku: body.sku ?? "",
      title: body.title,
      description: body.description ?? "",
      hsCode: body.hsCode,
      originCountry: mfr.originCountry,
      originCurrencyCode: body.originCurrencyCode,
      wholesalePriceMinor: Math.round(body.wholesalePriceMinor),
      moq: Math.max(1, Number(body.moq ?? 1)),
      leadDays: Math.max(0, Number(body.leadDays ?? 14)),
      weightGrams: Math.max(0, Number(body.weightGrams ?? 0)),
      dimensions: body.dimensions ?? {},
      images: body.images ?? [],
      category: body.category ?? "Other",
      status: "active",
    })
    .returning();
  await recordAudit({
    actorId: mfr.userId,
    action: "manufacturer.listing.create",
    entity: "manufacturer_listing",
    entityId: row.id,
    payload: { manufacturerId: mfr.id, hsCode: row.hsCode, currency: row.originCurrencyCode },
  });
  res.status(201).json(rowToListing(row));
});

router.patch("/manufacturer/listings/:listingId", requireManufacturer, async (req, res) => {
  const mfr = (req as ManufacturerRequest).manufacturer;
  const body = (req.body ?? {}) as Partial<{
    title: string;
    description: string;
    hsCode: string;
    wholesalePriceMinor: number;
    moq: number;
    leadDays: number;
    weightGrams: number;
    dimensions: Record<string, unknown>;
    images: string[];
    category: string;
    status: "draft" | "active" | "paused";
  }>;
  const patch: Partial<typeof schema.manufacturerListingsTable.$inferInsert> = {};
  if (typeof body.title === "string") patch.title = body.title;
  if (typeof body.description === "string") patch.description = body.description;
  if (typeof body.hsCode === "string") {
    const err = validateHsCode(body.hsCode);
    if (err) {
      res.status(400).json({ error: "bad_request", detail: err });
      return;
    }
    patch.hsCode = body.hsCode;
  }
  if (typeof body.wholesalePriceMinor === "number") patch.wholesalePriceMinor = Math.round(body.wholesalePriceMinor);
  if (typeof body.moq === "number") patch.moq = Math.max(1, body.moq);
  if (typeof body.leadDays === "number") patch.leadDays = Math.max(0, body.leadDays);
  if (typeof body.weightGrams === "number") patch.weightGrams = Math.max(0, body.weightGrams);
  if (body.dimensions !== undefined) patch.dimensions = body.dimensions;
  if (Array.isArray(body.images)) patch.images = body.images;
  if (typeof body.category === "string") patch.category = body.category;
  if (body.status === "draft" || body.status === "active" || body.status === "paused") patch.status = body.status;
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "no_fields" });
    return;
  }
  const [row] = await db
    .update(schema.manufacturerListingsTable)
    .set(patch)
    .where(
      and(
        eq(schema.manufacturerListingsTable.manufacturerId, mfr.id),
        eq(schema.manufacturerListingsTable.id, String(req.params.listingId ?? "")),
      ),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  await recordAudit({
    actorId: mfr.userId,
    action: "manufacturer.listing.update",
    entity: "manufacturer_listing",
    entityId: row.id,
    payload: { fields: Object.keys(patch) },
  });
  res.json(rowToListing(row));
});

router.delete("/manufacturer/listings/:listingId", requireManufacturer, async (req, res) => {
  const mfr = (req as ManufacturerRequest).manufacturer;
  const result = await db
    .delete(schema.manufacturerListingsTable)
    .where(
      and(
        eq(schema.manufacturerListingsTable.manufacturerId, mfr.id),
        eq(schema.manufacturerListingsTable.id, String(req.params.listingId ?? "")),
      ),
    )
    .returning({ id: schema.manufacturerListingsTable.id });
  if (result.length === 0) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  await recordAudit({
    actorId: mfr.userId,
    action: "manufacturer.listing.delete",
    entity: "manufacturer_listing",
    entityId: result[0].id,
  });
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Wholesale orders (manufacturer-side view + transitions)
// ---------------------------------------------------------------------------

router.get("/manufacturer/orders", requireManufacturer, async (req, res) => {
  const mfr = (req as ManufacturerRequest).manufacturer;
  const rows = await db
    .select()
    .from(schema.wholesaleOrdersTable)
    .where(eq(schema.wholesaleOrdersTable.manufacturerId, mfr.id))
    .orderBy(desc(schema.wholesaleOrdersTable.createdAt));
  res.json(rows.map(rowToWholesaleOrder));
});

router.get("/manufacturer/orders/:orderId", requireManufacturer, async (req, res) => {
  const mfr = (req as ManufacturerRequest).manufacturer;
  const [row] = await db
    .select()
    .from(schema.wholesaleOrdersTable)
    .where(
      and(
        eq(schema.wholesaleOrdersTable.manufacturerId, mfr.id),
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
  });
});

router.post("/manufacturer/orders/:orderId/ship", requireManufacturer, async (req, res) => {
  const mfr = (req as ManufacturerRequest).manufacturer;
  const orderId = String(req.params.orderId ?? "");
  // State-machine guard: only "booked" → "in_transit". Idempotent: if the
  // row is already in_transit/at_customs/etc the call is a no-op success.
  const [row] = await db
    .update(schema.wholesaleOrdersTable)
    .set({ status: "in_transit" })
    .where(
      and(
        eq(schema.wholesaleOrdersTable.manufacturerId, mfr.id),
        eq(schema.wholesaleOrdersTable.id, orderId),
        eq(schema.wholesaleOrdersTable.status, "booked"),
      ),
    )
    .returning();
  if (!row) {
    res.status(409).json({ error: "wrong_state" });
    return;
  }
  await recordAudit({
    actorId: mfr.userId,
    action: "manufacturer.order.ship",
    entity: "wholesale_order",
    entityId: row.id,
  });
  // Append a customs/timeline event for buyer visibility.
  try {
    await db.insert(schema.customsEventsTable).values({
      id: `cev_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
      wholesaleOrderId: row.id,
      kind: "carrier_pickup",
      note: "Manufacturer marked as shipped",
      actorUserId: mfr.userId,
      payload: {},
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message, orderId }, "manufacturer_ship_event_failed");
  }
  res.json(rowToWholesaleOrder(row));
});

// ---------------------------------------------------------------------------
// Manufacturer payouts (filtered view of `payouts` table)
// ---------------------------------------------------------------------------

router.get("/manufacturer/payouts", requireManufacturer, async (req, res) => {
  const mfr = (req as ManufacturerRequest).manufacturer;
  const rows = await db
    .select()
    .from(schema.payoutsTable)
    .where(and(eq(schema.payoutsTable.userId, mfr.userId), eq(schema.payoutsTable.kind, "manufacturer_share")))
    .orderBy(desc(schema.payoutsTable.requestedAt));
  res.json(
    rows.map((p) => ({
      id: p.id,
      amountMinor: p.amountMinor,
      currencyCode: p.currencyCode,
      status: p.status,
      reference: p.reference,
      requestedAtIso: p.requestedAt.toISOString(),
      paidAtIso: p.paidAt?.toISOString() ?? null,
    })),
  );
});

export default router;
