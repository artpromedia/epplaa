import { pgTable, text, integer, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Shipment row — one per dispatched order. Created when an order is paid
 * and a carrier dispatch succeeds. The `carrier` is the chosen provider
 * (shipbubble | gig | box | pudo). `service` is the speed tier the buyer
 * picked at checkout (e.g. "shipbubble:standard"). `carrierRef` is the
 * provider's tracking id; `labelUrl` is the printable shipping label PDF.
 */
export const shipmentsTable = pgTable(
  "shipments",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull(),
    userId: text("user_id").notNull(),
    carrier: text("carrier").notNull(),
    service: text("service").notNull().default(""),
    carrierRef: text("carrier_ref").notNull().default(""),
    trackingUrl: text("tracking_url").notNull().default(""),
    labelUrl: text("label_url").notNull().default(""),
    /** rate quoted at dispatch time (minor units of order currency). */
    quotedPriceMinor: integer("quoted_price_minor").notNull().default(0),
    currencyCode: text("currency_code").notNull().default(""),
    /**
     * Lifecycle:
     *   pending → label_created → picked_up → in_transit → arrived
     *           → delivered | failed | returned | cancelled
     */
    status: text("status").notNull().default("pending"),
    /** Snapshot of the shipping address (street/area/city/lat/lng/placeId). */
    address: jsonb("address").$type<Record<string, unknown>>().notNull().default({}),
    /** Reverse-pickup label url + tracking id (returns flow). */
    reverseLabelUrl: text("reverse_label_url").notNull().default(""),
    reverseCarrierRef: text("reverse_carrier_ref").notNull().default(""),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrder: uniqueIndex("shipments_order_uniq").on(t.orderId),
    byCarrierRef: index("shipments_carrier_ref_idx").on(t.carrier, t.carrierRef),
    byStatus: index("shipments_status_idx").on(t.status),
  }),
);

export type Shipment = typeof shipmentsTable.$inferSelect;

/**
 * Tracking events posted by carrier webhooks. Idempotent on
 * (shipmentId, providerEventId) so duplicate webhook deliveries do not
 * append duplicate timeline entries. `status` is the normalized lifecycle
 * code; `rawStatus` is what the provider sent.
 */
export const shipmentEventsTable = pgTable(
  "shipment_events",
  {
    id: text("id").primaryKey(),
    shipmentId: text("shipment_id").notNull(),
    providerEventId: text("provider_event_id").notNull().default(""),
    status: text("status").notNull(),
    rawStatus: text("raw_status").notNull().default(""),
    note: text("note").notNull().default(""),
    location: text("location").notNull().default(""),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqEvt: uniqueIndex("shipment_events_uniq").on(t.shipmentId, t.providerEventId),
    byShipment: index("shipment_events_shipment_idx").on(t.shipmentId, t.occurredAt),
  }),
);

export type ShipmentEvent = typeof shipmentEventsTable.$inferSelect;

/**
 * Smart-locker reservation. Created at dispatch when the order's
 * fulfillment.optionId is an Epplaa Box. The pickup OTP from the order is
 * the unlock code. `boxId` is the assigned locker within the chosen
 * Box location; `expiresAt` is when auto-return triggers (default 72h).
 */
export const boxReservationsTable = pgTable(
  "box_reservations",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull(),
    shipmentId: text("shipment_id"),
    locationId: text("location_id").notNull(),
    boxId: text("box_id").notNull(),
    /** Lifecycle: reserved → stocked → collected | returned | expired. */
    status: text("status").notNull().default("reserved"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    collectedAt: timestamp("collected_at", { withTimezone: true }),
    returnedAt: timestamp("returned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqOrder: uniqueIndex("box_reservations_order_uniq").on(t.orderId),
    byStatus: index("box_reservations_status_idx").on(t.status, t.expiresAt),
    byLocation: index("box_reservations_location_idx").on(t.locationId),
  }),
);

export type BoxReservation = typeof boxReservationsTable.$inferSelect;

/**
 * PUDO partners — third-party pickup-drop-off operators (Pargo, G4S,
 * Speedaf, Paxi, etc.). Each has a stable `code` we use in
 * fulfillment_locations and the manifest export endpoint.
 *
 * The `*Manifest*` columns govern the daily push delivery (task #16):
 * partners that prefer a 06:00-local push instead of pulling from
 * `GET /pudo/:partnerCode/manifest` set `deliveryMethod` to "email" or
 * "sftp" plus the matching transport columns. `manifestTimezone` is
 * the IANA zone used to decide what "06:00" means and what date the
 * manifest covers. Any partner with `deliveryMethod="none"` (the
 * default) is left to pull on their own schedule — backwards
 * compatible with how existing partners use the route.
 */
export const pudoPartnersTable = pgTable("pudo_partners", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  countryCode: text("country_code").notNull(),
  /** Optional shared secret for the manifest endpoint (overrides INTERNAL_API_KEY). */
  apiKey: text("api_key"),
  /** Optional reply email / address for the daily manifest. */
  contactEmail: text("contact_email").notNull().default(""),
  active: integer("active").notNull().default(1),
  /** IANA timezone, e.g. "Africa/Lagos". Defaults to Africa/Lagos so an
   *  unconfigured partner still gets a sane African-business-hours window. */
  manifestTimezone: text("manifest_timezone").notNull().default("Africa/Lagos"),
  /** "none" | "email" | "sftp". "none" disables the daily push (partner pulls). */
  deliveryMethod: text("delivery_method").notNull().default("none"),
  /** Comma-separated recipient list for `deliveryMethod="email"`. */
  manifestEmail: text("manifest_email").notNull().default(""),
  /** SFTP transport config — only used when `deliveryMethod="sftp"`. */
  sftpHost: text("sftp_host").notNull().default(""),
  sftpPort: integer("sftp_port").notNull().default(22),
  sftpUsername: text("sftp_username").notNull().default(""),
  /** NAME of an env var holding the SFTP password (we never persist secrets). */
  sftpPasswordEnvVar: text("sftp_password_env_var").notNull().default(""),
  /** NAME of an env var holding a private key (PEM). Wins over password. */
  sftpKeyEnvVar: text("sftp_key_env_var").notNull().default(""),
  /** Remote directory the CSV is dropped into. Filename is `<code>-<date>.csv`. */
  sftpRemoteDir: text("sftp_remote_dir").notNull().default("/"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PudoPartner = typeof pudoPartnersTable.$inferSelect;

/**
 * Audit row for daily manifest CSV exports — one per (partner, day) so we
 * can prove what was handed off and when. CSV is regenerated on demand
 * from current shipments; this table only records that an export
 * happened.
 *
 * For task #16's daily push, the `destination` / `status` / `attempts`
 * / `lastError` / `deliveredAt` columns let on-call see which partners
 * actually received their morning manifest, which silently failed, and
 * how many times we retried before giving up. `contentHash` is the
 * dedupe key — a retry that produces the same CSV as the most recent
 * `sent` run for the same (partner, day) is short-circuited so a
 * transient transport flap can't cause partners to receive the same
 * file twice.
 */
export const pudoManifestRunsTable = pgTable(
  "pudo_manifest_runs",
  {
    id: text("id").primaryKey(),
    partnerCode: text("partner_code").notNull(),
    forDate: text("for_date").notNull(),
    shipmentCount: integer("shipment_count").notNull().default(0),
    /** Hash of the shipment id list, so re-running detects no-op runs. */
    contentHash: text("content_hash").notNull().default(""),
    /** "email:<addr>" or "sftp:<host>:<remoteDir>" or "" (pulled on demand). */
    destination: text("destination").notNull().default(""),
    /** "email" | "sftp" | "" (pulled on demand). */
    deliveryMethod: text("delivery_method").notNull().default(""),
    /**
     * Lifecycle:
     *   queued                — built, awaiting first delivery attempt
     *   sent                  — delivered to the partner
     *   skipped_no_change     — same contentHash already sent today
     *   skipped_pull_only     — partner is configured for pull, no push
     *   failed                — gave up after MAX_DELIVERY_ATTEMPTS
     */
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error").notNull().default(""),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqDay: uniqueIndex("pudo_manifest_runs_uniq").on(t.partnerCode, t.forDate),
  }),
);

export type PudoManifestRun = typeof pudoManifestRunsTable.$inferSelect;
