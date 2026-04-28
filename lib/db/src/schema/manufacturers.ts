import {
  pgTable,
  text,
  integer,
  real,
  timestamp,
  jsonb,
  date,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/**
 * Cross-border manufacturer side of Epplaa (Vietnam / China / Japan / Taiwan
 * → 16 African markets). Every PK is `text` to match every other table in
 * this project — `initManufacturerSchema()` in `lib/manufacturers.ts`
 * creates the underlying Postgres tables additively at boot.
 *
 * Onboarding flow:
 *   1. POST /manufacturer/apply        → manufacturers row, status='pending'
 *   2. POST /manufacturer/kyc (xN)     → manufacturer_kyc rows, status='pending'
 *   3. Admin POST /admin/manufacturer-kyc/:id/decide → all required → manufacturer.status='approved'
 *   4. POST /manufacturer/listings     → wholesale catalog visible to sellers
 */
export const manufacturersTable = pgTable("manufacturers", {
  id: text("id").primaryKey(),
  /** Clerk user id; unique because one Clerk identity = one manufacturer. */
  userId: text("user_id").notNull().unique(),
  /** Origin country code (ISO-3166 alpha-2: VN, CN, JP, TW, etc.). */
  originCountry: text("origin_country").notNull(),
  legalName: text("legal_name").notNull(),
  contactEmail: text("contact_email").notNull().default(""),
  contactPhone: text("contact_phone").notNull().default(""),
  /** Free-form export licence number; document URLs live in manufacturer_kyc. */
  exportLicenceNumber: text("export_licence_number").notNull().default(""),
  /** "pending" | "approved" | "suspended" | "rejected" */
  status: text("status").notNull().default("pending"),
  /** Free-form application JSON (factory address, capacity, categories, etc.). */
  application: jsonb("application").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type Manufacturer = typeof manufacturersTable.$inferSelect;

export const manufacturerKycTable = pgTable(
  "manufacturer_kyc",
  {
    id: text("id").primaryKey(),
    manufacturerId: text("manufacturer_id").notNull(),
    /** "export_licence" | "business_registration" | "tax_id" | "ubo" | "factory_audit" */
    kind: text("kind").notNull(),
    /** Object-storage URL for the uploaded document. */
    documentUrl: text("document_url").notNull().default(""),
    /** "pending" | "approved" | "rejected" */
    status: text("status").notNull().default("pending"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    rejectReason: text("reject_reason").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("manufacturer_kyc_mfr_idx").on(t.manufacturerId),
    index("manufacturer_kyc_status_idx").on(t.status),
  ],
);

export type ManufacturerKyc = typeof manufacturerKycTable.$inferSelect;

/**
 * Wholesale catalog: priced in the manufacturer's origin currency.
 * Sellers browse this catalog and place wholesale orders; landed cost
 * (FOB + freight + insurance + duty + VAT + clearance) is computed at
 * quote/checkout time using `fx_rates` for the FX leg.
 */
export const manufacturerListingsTable = pgTable(
  "manufacturer_listings",
  {
    id: text("id").primaryKey(),
    manufacturerId: text("manufacturer_id").notNull(),
    sku: text("sku").notNull().default(""),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    /** Harmonized System (HS) commodity code, 6 to 10 digits. */
    hsCode: text("hs_code").notNull().default(""),
    originCountry: text("origin_country").notNull(),
    /** Origin-currency code: USD, CNY, VND, JPY, TWD. */
    originCurrencyCode: text("origin_currency_code").notNull().default("USD"),
    /** Wholesale unit price in origin-currency minor units. */
    wholesalePriceMinor: integer("wholesale_price_minor").notNull(),
    /** Minimum order quantity. */
    moq: integer("moq").notNull().default(1),
    /** Production lead time in days before the unit can ship. */
    leadDays: integer("lead_days").notNull().default(14),
    weightGrams: integer("weight_grams").notNull().default(0),
    dimensions: jsonb("dimensions").notNull().default({}),
    images: text("images").array().notNull().default([]),
    category: text("category").notNull().default("Other"),
    /** "draft" | "active" | "paused" */
    status: text("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("manufacturer_listings_mfr_idx").on(t.manufacturerId),
    index("manufacturer_listings_status_idx").on(t.status),
    index("manufacturer_listings_origin_idx").on(t.originCountry),
  ],
);

export type ManufacturerListing = typeof manufacturerListingsTable.$inferSelect;

/**
 * Wholesale order placed by a seller against a manufacturer listing.
 * Holds the frozen landed-cost breakdown plus references to the freight
 * booking and customs/bonded-warehouse timeline.
 *
 * State machine:
 *   draft → booked → in_transit → at_customs → cleared → delivered
 *                                            ↘ on_hold
 *   any non-terminal → cancelled
 */
export const wholesaleOrdersTable = pgTable(
  "wholesale_orders",
  {
    id: text("id").primaryKey(),
    listingId: text("listing_id").notNull(),
    manufacturerId: text("manufacturer_id").notNull(),
    sellerUserId: text("seller_user_id").notNull(),
    qty: integer("qty").notNull(),
    /** FOB unit price * qty in origin currency minor units. */
    fobMinor: integer("fob_minor").notNull(),
    originCurrencyCode: text("origin_currency_code").notNull(),
    /** All cost legs are normalised to destination currency minor units. */
    freightMinor: integer("freight_minor").notNull().default(0),
    insuranceMinor: integer("insurance_minor").notNull().default(0),
    dutyMinor: integer("duty_minor").notNull().default(0),
    vatMinor: integer("vat_minor").notNull().default(0),
    clearanceMinor: integer("clearance_minor").notNull().default(0),
    landedTotalMinor: integer("landed_total_minor").notNull(),
    destinationCurrencyCode: text("destination_currency_code").notNull().default("NGN"),
    destinationCountryCode: text("destination_country_code").notNull().default("NG"),
    /** FX rate from origin currency → destination currency at order time. */
    fxRate: real("fx_rate").notNull().default(1),
    /** "draft" | "booked" | "in_transit" | "at_customs" | "cleared" | "delivered" | "cancelled" | "on_hold" */
    status: text("status").notNull().default("draft"),
    freightBookingId: text("freight_booking_id"),
    /** Forwarder-quoted ETA at order time. */
    etaIso: text("eta_iso"),
    shipMode: text("ship_mode").notNull().default("air"),
    notes: text("notes").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("wholesale_orders_seller_idx").on(t.sellerUserId),
    index("wholesale_orders_mfr_idx").on(t.manufacturerId),
    index("wholesale_orders_status_idx").on(t.status),
  ],
);

export type WholesaleOrder = typeof wholesaleOrdersTable.$inferSelect;

export const freightBookingsTable = pgTable(
  "freight_bookings",
  {
    id: text("id").primaryKey(),
    wholesaleOrderId: text("wholesale_order_id").notNull(),
    /** "air" | "sea" */
    mode: text("mode").notNull().default("air"),
    /** Provider key: "manual_email" | "forto" | "flexport" | "devmock". */
    forwarder: text("forwarder").notNull().default("manual_email"),
    /** Forwarder-issued reference (BL, AWB, booking number). */
    ref: text("ref").notNull().default(""),
    originPort: text("origin_port").notNull().default(""),
    destinationPort: text("destination_port").notNull().default(""),
    /** "pending" | "booked" | "in_transit" | "at_customs" | "delivered" | "cancelled" */
    status: text("status").notNull().default("pending"),
    etaIso: text("eta_iso"),
    actualEtaIso: text("actual_eta_iso"),
    costMinor: integer("cost_minor").notNull().default(0),
    currencyCode: text("currency_code").notNull().default("USD"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("freight_bookings_order_idx").on(t.wholesaleOrderId),
    index("freight_bookings_status_idx").on(t.status),
  ],
);

export type FreightBooking = typeof freightBookingsTable.$inferSelect;

/**
 * Append-only customs/shipment timeline. Frontend renders this as a
 * vertical timeline on the wholesale-order detail page.
 *
 * Kinds: "docs_submitted" | "duty_assessed" | "duty_paid" | "customs_held" |
 *        "customs_cleared" | "released" | "carrier_pickup" | "delivered" |
 *        "exception"
 */
export const customsEventsTable = pgTable(
  "customs_events",
  {
    id: text("id").primaryKey(),
    wholesaleOrderId: text("wholesale_order_id").notNull(),
    kind: text("kind").notNull(),
    note: text("note").notNull().default(""),
    actorUserId: text("actor_user_id"),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("customs_events_order_idx").on(t.wholesaleOrderId),
    index("customs_events_kind_idx").on(t.kind),
  ],
);

export type CustomsEvent = typeof customsEventsTable.$inferSelect;

export const bondedWarehouseInventoryTable = pgTable(
  "bonded_warehouse_inventory",
  {
    id: text("id").primaryKey(),
    wholesaleOrderId: text("wholesale_order_id").notNull().unique(),
    /** Free-form warehouse code (e.g. "LOS-BWH-1" for Apapa Lagos). */
    warehouseCode: text("warehouse_code").notNull().default(""),
    qtyOnHand: integer("qty_on_hand").notNull().default(0),
    qtyReleased: integer("qty_released").notNull().default(0),
    arrivedAt: timestamp("arrived_at", { withTimezone: true }),
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("bonded_inv_warehouse_idx").on(t.warehouseCode)],
);

export type BondedWarehouseInventory = typeof bondedWarehouseInventoryTable.$inferSelect;

/**
 * Daily FX rates used by the landed-cost calculator. Multiple sources are
 * supported (CBN, OpenExchange, manual override) with the latest available
 * rate per (base, quote) wins. `getRate()` in `lib/fx.ts` reads this table.
 */
export const fxRatesTable = pgTable(
  "fx_rates",
  {
    id: text("id").primaryKey(),
    baseCurrency: text("base_currency").notNull(),
    quoteCurrency: text("quote_currency").notNull(),
    rate: real("rate").notNull(),
    /** "cbn" | "openexchange" | "manual" | "seed" */
    source: text("source").notNull().default("seed"),
    asOfDate: date("as_of_date").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("fx_rates_unique_idx").on(t.baseCurrency, t.quoteCurrency, t.asOfDate, t.source),
    index("fx_rates_pair_idx").on(t.baseCurrency, t.quoteCurrency),
  ],
);

export type FxRate = typeof fxRatesTable.$inferSelect;
