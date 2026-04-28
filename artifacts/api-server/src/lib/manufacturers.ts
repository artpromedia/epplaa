import type { Request, Response, NextFunction, RequestHandler } from "express";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "./db";
import { getUserId } from "./auth";
import { logger } from "./logger";
import { newSafeId } from "./ids";

/**
 * Boot-time bootstrap for the cross-border manufacturer side. Mirrors the
 * `initAuditChain` / `initAdminSchema` pattern: idempotent additive SQL
 * (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS) executed at boot,
 * not via `drizzle-kit push --force`. Every PK is `text` to match the rest
 * of the project — a force-push would attempt destructive ALTER TABLE
 * statements on existing PKs.
 */
export async function initManufacturerSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS manufacturers (
      id text PRIMARY KEY,
      user_id text NOT NULL UNIQUE,
      origin_country text NOT NULL,
      legal_name text NOT NULL,
      contact_email text NOT NULL DEFAULT '',
      contact_phone text NOT NULL DEFAULT '',
      export_licence_number text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'pending',
      application jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS manufacturer_kyc (
      id text PRIMARY KEY,
      manufacturer_id text NOT NULL,
      kind text NOT NULL,
      document_url text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'pending',
      reviewed_by text,
      reviewed_at timestamptz,
      reject_reason text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS manufacturer_kyc_mfr_idx ON manufacturer_kyc (manufacturer_id);`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS manufacturer_kyc_status_idx ON manufacturer_kyc (status);`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS manufacturer_listings (
      id text PRIMARY KEY,
      manufacturer_id text NOT NULL,
      sku text NOT NULL DEFAULT '',
      title text NOT NULL,
      description text NOT NULL DEFAULT '',
      hs_code text NOT NULL DEFAULT '',
      origin_country text NOT NULL,
      origin_currency_code text NOT NULL DEFAULT 'USD',
      wholesale_price_minor integer NOT NULL,
      moq integer NOT NULL DEFAULT 1,
      lead_days integer NOT NULL DEFAULT 14,
      weight_grams integer NOT NULL DEFAULT 0,
      dimensions jsonb NOT NULL DEFAULT '{}'::jsonb,
      images text[] NOT NULL DEFAULT '{}',
      category text NOT NULL DEFAULT 'Other',
      status text NOT NULL DEFAULT 'draft',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS manufacturer_listings_mfr_idx ON manufacturer_listings (manufacturer_id);`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS manufacturer_listings_status_idx ON manufacturer_listings (status);`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS manufacturer_listings_origin_idx ON manufacturer_listings (origin_country);`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS wholesale_orders (
      id text PRIMARY KEY,
      listing_id text NOT NULL,
      manufacturer_id text NOT NULL,
      seller_user_id text NOT NULL,
      qty integer NOT NULL,
      fob_minor integer NOT NULL,
      origin_currency_code text NOT NULL,
      freight_minor integer NOT NULL DEFAULT 0,
      insurance_minor integer NOT NULL DEFAULT 0,
      duty_minor integer NOT NULL DEFAULT 0,
      vat_minor integer NOT NULL DEFAULT 0,
      clearance_minor integer NOT NULL DEFAULT 0,
      landed_total_minor integer NOT NULL,
      destination_currency_code text NOT NULL DEFAULT 'NGN',
      destination_country_code text NOT NULL DEFAULT 'NG',
      fx_rate real NOT NULL DEFAULT 1,
      status text NOT NULL DEFAULT 'draft',
      freight_booking_id text,
      eta_iso text,
      ship_mode text NOT NULL DEFAULT 'air',
      notes text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS wholesale_orders_seller_idx ON wholesale_orders (seller_user_id);`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS wholesale_orders_mfr_idx ON wholesale_orders (manufacturer_id);`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS wholesale_orders_status_idx ON wholesale_orders (status);`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS freight_bookings (
      id text PRIMARY KEY,
      wholesale_order_id text NOT NULL,
      mode text NOT NULL DEFAULT 'air',
      forwarder text NOT NULL DEFAULT 'manual_email',
      ref text NOT NULL DEFAULT '',
      origin_port text NOT NULL DEFAULT '',
      destination_port text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'pending',
      eta_iso text,
      actual_eta_iso text,
      cost_minor integer NOT NULL DEFAULT 0,
      currency_code text NOT NULL DEFAULT 'USD',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS freight_bookings_order_idx ON freight_bookings (wholesale_order_id);`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS freight_bookings_status_idx ON freight_bookings (status);`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS customs_events (
      id text PRIMARY KEY,
      wholesale_order_id text NOT NULL,
      kind text NOT NULL,
      note text NOT NULL DEFAULT '',
      actor_user_id text,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS customs_events_order_idx ON customs_events (wholesale_order_id);`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS customs_events_kind_idx ON customs_events (kind);`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS bonded_warehouse_inventory (
      id text PRIMARY KEY,
      wholesale_order_id text NOT NULL UNIQUE,
      warehouse_code text NOT NULL DEFAULT '',
      qty_on_hand integer NOT NULL DEFAULT 0,
      qty_released integer NOT NULL DEFAULT 0,
      arrived_at timestamptz,
      cleared_at timestamptz,
      released_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS bonded_inv_warehouse_idx ON bonded_warehouse_inventory (warehouse_code);`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS fx_rates (
      id text PRIMARY KEY,
      base_currency text NOT NULL,
      quote_currency text NOT NULL,
      rate real NOT NULL,
      source text NOT NULL DEFAULT 'seed',
      as_of_date date NOT NULL,
      fetched_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS fx_rates_unique_idx
      ON fx_rates (base_currency, quote_currency, as_of_date, source);
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS fx_rates_pair_idx ON fx_rates (base_currency, quote_currency);`);

  // --- Additive columns on `payouts` for manufacturer payouts ---
  // Both columns already exist in the Drizzle schema; the IF NOT EXISTS is
  // for environments that pre-date this addition.
  await db.execute(sql`ALTER TABLE payouts ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'seller_share';`);
  await db.execute(sql`ALTER TABLE payouts ADD COLUMN IF NOT EXISTS currency_code text NOT NULL DEFAULT 'NGN';`);

  logger.info("manufacturer_schema_initialised");
}

/**
 * Loads the manufacturer profile for a Clerk userId, or null if the user
 * has not applied yet. Used by `requireManufacturer` and the GET /me route.
 */
export async function getManufacturerForUser(
  userId: string,
): Promise<typeof schema.manufacturersTable.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(schema.manufacturersTable)
    .where(eq(schema.manufacturersTable.userId, userId))
    .limit(1);
  return row ?? null;
}

export interface ManufacturerRequest extends Request {
  manufacturer: typeof schema.manufacturersTable.$inferSelect;
}

/**
 * Middleware: require an approved manufacturer profile. Stuffs the row
 * onto `req.manufacturer` for the route handler. Pending/suspended/rejected
 * manufacturers get 403 with a status field so the portal can render
 * the right empty state.
 */
export const requireManufacturer: RequestHandler = async (req, res, next) => {
  const userId = getUserId(req);
  if (!userId) {
    res.status(401).json({ error: "unauthorized", detail: "Sign-in required" });
    return;
  }
  const mfr = await getManufacturerForUser(userId);
  if (!mfr) {
    res.status(403).json({ error: "manufacturer_required", status: "none" });
    return;
  }
  if (mfr.status !== "approved") {
    res.status(403).json({ error: "manufacturer_not_approved", status: mfr.status });
    return;
  }
  (req as ManufacturerRequest).manufacturer = mfr;
  next();
};

/** Helper: generates a manufacturer-side ID with the given prefix. */
export function newManufacturerId(): string {
  return newSafeId("mfr");
}
export function newManufacturerKycId(): string {
  return newSafeId("mfk");
}
export function newManufacturerListingId(): string {
  return newSafeId("mlst");
}
export function newWholesaleOrderId(): string {
  return newSafeId("wo");
}
export function newFreightBookingId(): string {
  return newSafeId("frb");
}
export function newCustomsEventId(): string {
  return newSafeId("cev");
}
export function newBondedInventoryId(): string {
  return newSafeId("binv");
}
export function newFxRateId(): string {
  return newSafeId("fx");
}
