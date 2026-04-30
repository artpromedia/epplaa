import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import express, { type Express } from "express";
import request from "supertest";

/**
 * End-to-end HTTP test for the fulfillment pipeline. Walks the full
 * happy path the seller / buyer / carrier integrations exercise in
 * production:
 *
 *   1. POST /fulfillment/verify-address
 *   2. POST /fulfillment/rates                  (Shipbubble + GIG stub
 *                                               aggregation, plus a
 *                                               box-only branch)
 *   3. dispatchShipmentForOrder()               (called by the orders
 *                                               route after payment;
 *                                               we invoke it directly
 *                                               rather than going
 *                                               through the giant
 *                                               POST /orders payment
 *                                               flow, which is out of
 *                                               scope here)
 *   4. POST /api/fulfillment/webhooks/shipbubble + .../gig — simulated
 *      carrier callbacks ingest tracking events, mark the shipment
 *      delivered, and project that onto the order
 *   5. POST /returns/:id/pickup-label           (idempotent reverse
 *                                               label issuance)
 *   6. POST /box/unlock                         (OTP-gated locker
 *                                               collection — wrong-
 *                                               then-right OTP path,
 *                                               followed by the
 *                                               already_collected
 *                                               409)
 *   7. PUDO partner authorization regression: a partner can only mark
 *      shipments collected when the order's pickup location belongs to
 *      that partner. This is the cross-partner authorization check
 *      the manifest endpoint depends on.
 *
 * Skips itself when DATABASE_URL is not set so the suite stays green
 * on local environments without Postgres. Cleans up its own rows so
 * it does not pollute shared dev data.
 */

// Hoisted Clerk mock — `getAuth` reads the calling user from the
// `x-test-user-id` header so the requireUserId-protected returns
// routes can be exercised without standing up a real Clerk session.
vi.mock("@clerk/express", () => ({
  getAuth: (req: { headers: Record<string, string | string[] | undefined> }) => {
    const raw = req.headers["x-test-user-id"];
    const userId = typeof raw === "string" && raw.length > 0 ? raw : null;
    return { userId };
  },
}));

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const PREFIX = "test-fpipe-";

d("Fulfillment pipeline e2e (HTTP)", () => {
  type Db = typeof import("../lib/db")["db"];
  type Schema = typeof import("../lib/db")["schema"];
  type Sql = typeof import("drizzle-orm")["sql"];
  type Dispatch = typeof import("../lib/fulfillment/dispatch");
  type FulfillmentRouter = typeof import("./fulfillment")["default"];
  type BoxRouter = typeof import("./box")["default"];
  type ReturnsRouter = typeof import("./returns")["default"];
  type PudoRouter = typeof import("./pudo")["default"];
  type WebhooksRouter = typeof import("./fulfillmentWebhooks")["default"];

  let db: Db;
  let schema: Schema;
  let sql: Sql;
  let dispatchModule: Dispatch;
  let fulfillmentRouter: FulfillmentRouter;
  let boxRouter: BoxRouter;
  let returnsRouter: ReturnsRouter;
  let pudoRouter: PudoRouter;
  let webhooksRouter: WebhooksRouter;

  /**
   * App for everything except the carrier webhooks. Uses express.json()
   * so the routes can read parsed bodies as the production app does.
   */
  function buildApiApp(): Express {
    const app = express();
    app.use(express.json());
    app.use("/api", fulfillmentRouter);
    app.use("/api", boxRouter);
    app.use("/api", returnsRouter);
    app.use("/api", pudoRouter);
    return app;
  }

  /**
   * Webhooks are mounted with express.raw() in production so the
   * HMAC verifier sees the exact bytes the carrier signed. Mirror
   * that here so a regression in the raw-body wiring is caught by
   * the same shape of request the carrier actually sends.
   */
  function buildWebhookApp(): Express {
    const app = express();
    app.use(
      "/api/fulfillment/webhooks",
      express.raw({ type: "*/*", limit: "1mb" }),
      webhooksRouter,
    );
    return app;
  }

  function uniq(label: string): string {
    return `${PREFIX}${label}-${crypto.randomBytes(4).toString("hex")}`;
  }

  async function insertUser(id: string): Promise<void> {
    await db
      .insert(schema.usersTable)
      .values({
        clerkId: id,
        email: `${id}@example.com`,
        displayName: "Test Buyer",
        countryCode: "NG",
        phone: "+2348000000000",
      })
      .onConflictDoNothing();
  }

  async function insertProduct(id: string, priceMinor = 500_000): Promise<void> {
    await db
      .insert(schema.productsTable)
      .values({
        id,
        title: `Product ${id}`,
        priceMinor,
        originCountry: "NG",
        originLabel: "Lagos, Nigeria",
        sellerName: "Test Seller",
        countryCode: "NG",
        category: "Other",
      })
      .onConflictDoNothing();
  }

  /**
   * Insert a `placed` order row directly. Bypasses POST /orders (which
   * runs verification-token + payment-intent + VAT logic that has its
   * own coverage) so this suite stays focused on what happens AFTER
   * payment lands.
   */
  async function insertOrder(input: {
    id: string;
    userId: string;
    optionId: string;
    productId: string;
    qty: number;
    priceMinor: number;
    locationId?: string;
    pickupOtp?: string;
  }): Promise<typeof schema.ordersTable.$inferSelect> {
    const fulfillment: Record<string, unknown> = {
      optionId: input.optionId,
      carrier: input.optionId.startsWith("epplaa-box") || input.optionId.includes("pudo") || input.optionId.includes("paxi") || input.optionId.includes("pargo") ? "box" : "shipbubble",
      service: input.optionId.startsWith("epplaa-box") || input.optionId.includes("pudo") || input.optionId.includes("paxi") || input.optionId.includes("pargo") ? "box:locker" : "shipbubble:standard",
      rateMinor: 80000,
      serviceLabel: "Standard delivery",
      deliveryAddress: {
        street: "14 Awolowo Rd",
        area: "Ikoyi",
        city: "Lagos",
        lat: 6.45,
        lng: 3.42,
      },
      ...(input.locationId ? { locationId: input.locationId } : {}),
    };
    const [row] = await db
      .insert(schema.ordersTable)
      .values({
        id: input.id,
        userId: input.userId,
        status: "placed",
        countryCode: "NG",
        currencyCode: "NGN",
        items: [{ productId: input.productId, qty: input.qty, priceMinor: input.priceMinor }],
        fulfillment,
        payment: { recipientName: "Test Buyer" },
        notificationPrefs: {},
        totalsMinor: { total: input.priceMinor * input.qty + 80000 },
        etaLabel: "3-5 business days",
        gateway: "devmock",
        ...(input.pickupOtp ? { pickupOtp: input.pickupOtp } : {}),
      })
      .returning();
    return row;
  }

  async function insertBoxLocation(id: string): Promise<void> {
    await db
      .insert(schema.fulfillmentLocationsTable)
      .values({
        id,
        optionId: "epplaa-box",
        countryCode: "NG",
        city: "Lagos",
        name: `Box ${id}`,
        addressLine: "Test Box Location",
        kind: "box",
      })
      .onConflictDoNothing();
  }

  async function insertPudoPartner(code: string, apiKey: string): Promise<void> {
    await db
      .insert(schema.pudoPartnersTable)
      .values({
        code,
        name: `Partner ${code}`,
        countryCode: "NG",
        apiKey,
      })
      .onConflictDoNothing();
  }

  async function insertPudoLocation(id: string, partnerCode: string): Promise<void> {
    await db
      .insert(schema.fulfillmentLocationsTable)
      .values({
        id,
        optionId: "pudo",
        countryCode: "NG",
        city: "Lagos",
        name: `Pudo ${id}`,
        addressLine: `${partnerCode} drop-off`,
        kind: "pudo",
        partnerCode,
      })
      .onConflictDoNothing();
  }

  async function insertReturn(id: string, userId: string, orderId: string): Promise<void> {
    await db.insert(schema.returnsTable).values({
      id,
      userId,
      orderId,
      productTitle: "Refund test",
      refundAmountMinor: 500_000,
      currencyCode: "NGN",
      reason: "damaged",
      reasonLabel: "Damaged",
      status: "approved",
      timeline: [{ status: "requested", atIso: new Date().toISOString() }],
      dispute: [],
    });
  }

  async function cleanup(): Promise<void> {
    // Order matters — child rows first.
    await db.execute(sql`DELETE FROM shipment_events WHERE shipment_id IN (
      SELECT id FROM shipments WHERE order_id LIKE ${PREFIX + "%"}
    );`);
    await db.execute(sql`DELETE FROM box_reservations WHERE order_id LIKE ${PREFIX + "%"};`);
    await db.execute(sql`DELETE FROM shipments WHERE order_id LIKE ${PREFIX + "%"};`);
    await db.execute(sql`DELETE FROM returns WHERE order_id LIKE ${PREFIX + "%"} OR id LIKE ${PREFIX + "%"};`);
    await db.execute(sql`DELETE FROM orders WHERE id LIKE ${PREFIX + "%"};`);
    await db.execute(sql`DELETE FROM products WHERE id LIKE ${PREFIX + "%"};`);
    await db.execute(sql`DELETE FROM users WHERE clerk_id LIKE ${PREFIX + "%"};`);
    await db.execute(sql`DELETE FROM fulfillment_locations WHERE id LIKE ${PREFIX + "%"};`);
    await db.execute(sql`DELETE FROM pudo_manifest_runs WHERE partner_code LIKE ${PREFIX + "%"};`);
    await db.execute(sql`DELETE FROM pudo_partners WHERE code LIKE ${PREFIX + "%"};`);
    await db.execute(sql`DELETE FROM notifications_outbox WHERE user_id LIKE ${PREFIX + "%"};`);
    await db.execute(sql`DELETE FROM wallet_txns WHERE user_id LIKE ${PREFIX + "%"};`);
  }

  // Snapshot env vars we mutate so afterAll can restore them. Keeps
  // this test file from coupling state into sibling suites that may
  // be relying on real carrier configuration in the same process.
  const ENV_KEYS = [
    "SESSION_SECRET",
    "SHIPBUBBLE_WEBHOOK_SECRET",
    "GIG_WEBHOOK_SECRET",
    "SHIPBUBBLE_API_KEY",
    "GIG_API_KEY",
    "GIG_USERNAME",
    "OKHI_API_KEY",
    "OKHI_BRANCH_ID",
  ] as const;
  const envSnapshot = new Map<string, string | undefined>();

  beforeAll(async () => {
    for (const k of ENV_KEYS) envSnapshot.set(k, process.env[k]);

    // SESSION_SECRET signs the verify-address + quote tokens. The
    // tokens are generated and never validated in this suite, but
    // /fulfillment/verify-address still requires the env var to be
    // set (>=16 chars) before issuing one.
    if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 16) {
      process.env.SESSION_SECRET = crypto.randomBytes(32).toString("hex");
    }
    // Carrier webhook signature checks short-circuit when the
    // corresponding *_WEBHOOK_SECRET is unset (handler logs and
    // accepts in dev). We exercise that codepath, so leave them
    // unset; production behavior diverges and is covered by the
    // boot-time assertions.
    delete process.env.SHIPBUBBLE_WEBHOOK_SECRET;
    delete process.env.GIG_WEBHOOK_SECRET;
    // Make sure no stray production signal is set — the carrier
    // stubs would refuse to dispatch synthetic shipments otherwise.
    delete process.env.SHIPBUBBLE_API_KEY;
    delete process.env.GIG_API_KEY;
    delete process.env.GIG_USERNAME;
    delete process.env.OKHI_API_KEY;
    delete process.env.OKHI_BRANCH_ID;

    ({ db, schema } = await import("../lib/db"));
    ({ sql } = await import("drizzle-orm"));
    dispatchModule = await import("../lib/fulfillment/dispatch");
    fulfillmentRouter = (await import("./fulfillment")).default;
    boxRouter = (await import("./box")).default;
    returnsRouter = (await import("./returns")).default;
    pudoRouter = (await import("./pudo")).default;
    webhooksRouter = (await import("./fulfillmentWebhooks")).default;

    await cleanup();
  }, 30_000);

  afterEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    // Restore env to whatever the host process had before this file ran.
    for (const [k, v] of envSnapshot.entries()) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe("POST /fulfillment/verify-address", () => {
    it("returns a verified place id, confidence and signed token", async () => {
      const r = await request(buildApiApp()).post("/api/fulfillment/verify-address").send({
        countryCode: "NG",
        line: "14 Awolowo Rd",
        area: "Ikoyi",
        city: "Lagos",
        lat: 6.45,
        lng: 3.42,
      });
      expect(r.status).toBe(200);
      expect(typeof r.body.placeId).toBe("string");
      expect(r.body.placeId.length).toBeGreaterThan(0);
      // Stub OkHi caps at 98 — anything in 70-98 keeps the buyer on
      // the home-delivery branch in the SPA's confidence gate.
      expect(r.body.confidencePct).toBeGreaterThanOrEqual(70);
      expect(r.body.confidencePct).toBeLessThanOrEqual(98);
      expect(typeof r.body.verificationToken).toBe("string");
      expect(r.body.verificationToken.split(".")).toHaveLength(2);
    });

    it("rejects requests missing countryCode + line with 400", async () => {
      const r = await request(buildApiApp()).post("/api/fulfillment/verify-address").send({
        area: "Ikoyi",
        city: "Lagos",
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("bad_request");
    });
  });

  describe("POST /fulfillment/rates", () => {
    it("aggregates Shipbubble + GIG quotes for a home-delivery cart", async () => {
      const productId = uniq("prod");
      await insertProduct(productId);

      const r = await request(buildApiApp())
        .post("/api/fulfillment/rates")
        .send({
          currencyCode: "NGN",
          destination: {
            line: "14 Awolowo Rd",
            area: "Ikoyi",
            city: "Lagos",
            countryCode: "NG",
          },
          items: [{ productId, qty: 1 }],
        });
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body.quotes)).toBe(true);
      // 3 Shipbubble tiers (standard/express/sameday) + 2 GIG tiers
      // (economy/standard) = 5 quotes from the stub aggregator. Sort
      // is cheapest-first; assert at minimum we got both carriers.
      const carriers = new Set<string>(r.body.quotes.map((q: { carrier: string }) => q.carrier));
      expect(carriers.has("shipbubble")).toBe(true);
      expect(carriers.has("gig")).toBe(true);
      // Sorted ascending by price.
      const prices = r.body.quotes.map((q: { priceMinor: number }) => q.priceMinor);
      const sorted = [...prices].sort((a, b) => a - b);
      expect(prices).toEqual(sorted);
    });

    it("returns box-only quote when optionId hints at a locker pickup", async () => {
      const productId = uniq("prod");
      await insertProduct(productId);
      const r = await request(buildApiApp())
        .post("/api/fulfillment/rates")
        .send({
          currencyCode: "NGN",
          optionId: "epplaa-box",
          destination: { line: "—", area: "Ikoyi", city: "Lagos", countryCode: "NG" },
          items: [{ productId, qty: 1 }],
        });
      expect(r.status).toBe(200);
      expect(r.body.quotes).toHaveLength(1);
      expect(r.body.quotes[0].carrier).toBe("box");
    });

    it("rejects an empty cart with 400 bad_request", async () => {
      const r = await request(buildApiApp())
        .post("/api/fulfillment/rates")
        .send({
          currencyCode: "NGN",
          destination: { line: "x", area: "y", city: "Lagos", countryCode: "NG" },
          items: [],
        });
      expect(r.status).toBe(400);
    });
  });

  describe("dispatch + Shipbubble webhook → delivered", () => {
    it("dispatches a shipment, ingests the shipbubble webhook, and marks the order delivered", async () => {
      const userId = uniq("u");
      const productId = uniq("prod");
      const orderId = uniq("ord");
      await insertUser(userId);
      await insertProduct(productId);
      await insertOrder({
        id: orderId,
        userId,
        optionId: "shipbubble-standard",
        productId,
        qty: 1,
        priceMinor: 500_000,
      });

      await dispatchModule.dispatchShipmentForOrder(orderId);

      const [shipment] = await db
        .select()
        .from(schema.shipmentsTable)
        .where(sql`${schema.shipmentsTable.orderId} = ${orderId}`);
      expect(shipment).toBeDefined();
      expect(shipment.carrier).toBe("shipbubble");
      // Stub carrierRef format: SB-<orderId-suffix-8>
      expect(shipment.carrierRef).toMatch(/^SB-/);
      expect(shipment.status).toBe("label_created");

      // Initial event row seeded by dispatch.
      const initial = await db
        .select()
        .from(schema.shipmentEventsTable)
        .where(sql`${schema.shipmentEventsTable.shipmentId} = ${shipment.id}`);
      expect(initial.length).toBe(1);

      // Idempotency: a second call must NOT create a second shipment.
      await dispatchModule.dispatchShipmentForOrder(orderId);
      const after = await db
        .select()
        .from(schema.shipmentsTable)
        .where(sql`${schema.shipmentsTable.orderId} = ${orderId}`);
      expect(after).toHaveLength(1);

      // First webhook: in_transit. Posted as raw JSON via raw-body
      // mounted route — the webhook router must handle Buffer bodies.
      const inTransit = await request(buildWebhookApp())
        .post("/api/fulfillment/webhooks/shipbubble")
        .set("content-type", "application/json")
        .send({
          data: {
            tracking_id: shipment.carrierRef,
            status: "in_transit",
            event_id: "evt-1",
            description: "Picked up by courier",
            location: "Ikoyi",
            date: new Date().toISOString(),
          },
        });
      expect(inTransit.status).toBe(200);
      expect(inTransit.body.ok).toBe(true);
      expect(inTransit.body.inserted).toBe(1);

      // Replay (same providerEventId) is deduped at the unique index.
      const replay = await request(buildWebhookApp())
        .post("/api/fulfillment/webhooks/shipbubble")
        .set("content-type", "application/json")
        .send({
          data: {
            tracking_id: shipment.carrierRef,
            status: "in_transit",
            event_id: "evt-1",
            description: "Picked up by courier",
            date: new Date().toISOString(),
          },
        });
      expect(replay.status).toBe(200);
      expect(replay.body.inserted).toBe(0);

      // Delivered webhook: shipment + order both flip to delivered.
      const delivered = await request(buildWebhookApp())
        .post("/api/fulfillment/webhooks/shipbubble")
        .set("content-type", "application/json")
        .send({
          data: {
            tracking_id: shipment.carrierRef,
            status: "delivered",
            event_id: "evt-2",
            description: "Handed to recipient",
            location: "Ikoyi",
            date: new Date().toISOString(),
          },
        });
      expect(delivered.status).toBe(200);
      expect(delivered.body.inserted).toBe(1);

      const [shipAfter] = await db
        .select()
        .from(schema.shipmentsTable)
        .where(sql`${schema.shipmentsTable.id} = ${shipment.id}`);
      expect(shipAfter.status).toBe("delivered");
      expect(shipAfter.deliveredAt).not.toBeNull();

      const [orderAfter] = await db
        .select()
        .from(schema.ordersTable)
        .where(sql`${schema.ordersTable.id} = ${orderId}`);
      expect(orderAfter.status).toBe("delivered");
    });

    it("drops webhooks for unknown carrier refs without 5xx-ing", async () => {
      const r = await request(buildWebhookApp())
        .post("/api/fulfillment/webhooks/shipbubble")
        .set("content-type", "application/json")
        .send({
          data: {
            tracking_id: "SB-DOES-NOT-EXIST",
            status: "in_transit",
            event_id: "evt-x",
            date: new Date().toISOString(),
          },
        });
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.inserted).toBe(0);
    });
  });

  describe("dispatch + GIG webhook → delivered", () => {
    it("ingests a GIG payload (Waybill / Status / EventId) and projects to the order", async () => {
      const userId = uniq("u");
      const productId = uniq("prod");
      const orderId = uniq("ord");
      await insertUser(userId);
      await insertProduct(productId);
      // Use a GIG service explicitly so the dispatcher picks GIG.
      const order = await insertOrder({
        id: orderId,
        userId,
        optionId: "gig-economy",
        productId,
        qty: 1,
        priceMinor: 500_000,
      });
      // Override fulfillment.carrier to "gig" — `insertOrder` defaults
      // to shipbubble for non-box options.
      await db
        .update(schema.ordersTable)
        .set({
          fulfillment: { ...(order.fulfillment as Record<string, unknown>), carrier: "gig", service: "gig:economy" },
        })
        .where(sql`${schema.ordersTable.id} = ${orderId}`);

      await dispatchModule.dispatchShipmentForOrder(orderId);

      const [shipment] = await db
        .select()
        .from(schema.shipmentsTable)
        .where(sql`${schema.shipmentsTable.orderId} = ${orderId}`);
      expect(shipment).toBeDefined();
      expect(shipment.carrier).toBe("gig");
      expect(shipment.carrierRef).toMatch(/^GIG-/);

      const r = await request(buildWebhookApp())
        .post("/api/fulfillment/webhooks/gig")
        .set("content-type", "application/json")
        .send({
          Object: {
            Waybill: shipment.carrierRef,
            Status: "Delivered to recipient",
            Description: "Signed for at the door",
            ScanLocation: "Ikoyi",
            ScanDate: new Date().toISOString(),
            EventId: "gig-evt-1",
          },
        });
      expect(r.status).toBe(200);
      expect(r.body.inserted).toBe(1);

      const [orderAfter] = await db
        .select()
        .from(schema.ordersTable)
        .where(sql`${schema.ordersTable.id} = ${orderId}`);
      expect(orderAfter.status).toBe("delivered");
    });
  });

  describe("POST /returns/:returnId/pickup-label", () => {
    it("issues a reverse pickup label and returns the same one on retry (idempotent)", async () => {
      const userId = uniq("u");
      const productId = uniq("prod");
      const orderId = uniq("ord");
      const returnId = uniq("ret");
      await insertUser(userId);
      await insertProduct(productId);
      await insertOrder({
        id: orderId,
        userId,
        optionId: "shipbubble-standard",
        productId,
        qty: 1,
        priceMinor: 500_000,
      });
      await dispatchModule.dispatchShipmentForOrder(orderId);
      await insertReturn(returnId, userId, orderId);

      const first = await request(buildApiApp())
        .post(`/api/returns/${returnId}/pickup-label`)
        .set("x-test-user-id", userId)
        .send({});
      expect(first.status).toBe(200);
      expect(typeof first.body.labelUrl).toBe("string");
      expect(first.body.carrier).toBe("shipbubble");
      expect(typeof first.body.carrierRef).toBe("string");
      expect(first.body.carrierRef.length).toBeGreaterThan(0);
      expect(first.body.reused).toBe(false);

      // Persisted onto the return row.
      const [retAfter] = await db
        .select()
        .from(schema.returnsTable)
        .where(sql`${schema.returnsTable.id} = ${returnId}`);
      expect(retAfter.pickupCarrierRef).toBe(first.body.carrierRef);
      expect(retAfter.pickupLabelUrl).toBe(first.body.labelUrl);

      // Mirrored onto the original shipment row so the seller dashboard
      // can show the inbound waybill alongside the outbound one.
      const [shipAfter] = await db
        .select()
        .from(schema.shipmentsTable)
        .where(sql`${schema.shipmentsTable.orderId} = ${orderId}`);
      expect(shipAfter.reverseCarrierRef).toBe(first.body.carrierRef);

      // Second call returns the same waybill rather than minting a new one.
      const second = await request(buildApiApp())
        .post(`/api/returns/${returnId}/pickup-label`)
        .set("x-test-user-id", userId)
        .send({});
      expect(second.status).toBe(200);
      expect(second.body.reused).toBe(true);
      expect(second.body.carrierRef).toBe(first.body.carrierRef);
    });

    it("requires authentication and refuses to leak another user's return", async () => {
      const ownerId = uniq("u");
      const intruderId = uniq("u");
      const productId = uniq("prod");
      const orderId = uniq("ord");
      const returnId = uniq("ret");
      await insertUser(ownerId);
      await insertUser(intruderId);
      await insertProduct(productId);
      await insertOrder({
        id: orderId,
        userId: ownerId,
        optionId: "shipbubble-standard",
        productId,
        qty: 1,
        priceMinor: 500_000,
      });
      await dispatchModule.dispatchShipmentForOrder(orderId);
      await insertReturn(returnId, ownerId, orderId);

      const anon = await request(buildApiApp())
        .post(`/api/returns/${returnId}/pickup-label`)
        .send({});
      expect(anon.status).toBe(401);

      const intruder = await request(buildApiApp())
        .post(`/api/returns/${returnId}/pickup-label`)
        .set("x-test-user-id", intruderId)
        .send({});
      expect(intruder.status).toBe(404);
    });
  });

  describe("POST /box/unlock — OTP-gated locker collection", () => {
    it("rejects the wrong OTP, accepts the right one, and 409s on a second redeem", async () => {
      const userId = uniq("u");
      const productId = uniq("prod");
      const orderId = uniq("ord");
      const locationId = uniq("loc");
      const otp = "4321";
      await insertUser(userId);
      await insertProduct(productId);
      await insertBoxLocation(locationId);
      await insertOrder({
        id: orderId,
        userId,
        optionId: "epplaa-box",
        productId,
        qty: 1,
        priceMinor: 500_000,
        locationId,
        pickupOtp: otp,
      });
      await dispatchModule.dispatchShipmentForOrder(orderId);

      const [reservation] = await db
        .select()
        .from(schema.boxReservationsTable)
        .where(sql`${schema.boxReservationsTable.orderId} = ${orderId}`);
      expect(reservation).toBeDefined();
      expect(reservation.status).toBe("reserved");

      const wrong = await request(buildApiApp())
        .post("/api/box/unlock")
        .send({ reservationId: reservation.id, otp: "0000" });
      expect(wrong.status).toBe(403);
      expect(wrong.body.error).toBe("wrong_otp");

      // Reservation state untouched after the wrong attempt.
      const [stillReserved] = await db
        .select()
        .from(schema.boxReservationsTable)
        .where(sql`${schema.boxReservationsTable.id} = ${reservation.id}`);
      expect(stillReserved.status).toBe("reserved");

      const right = await request(buildApiApp())
        .post("/api/box/unlock")
        .send({ reservationId: reservation.id, otp });
      expect(right.status).toBe(200);
      expect(right.body.ok).toBe(true);
      expect(typeof right.body.collectedAtIso).toBe("string");

      const [collected] = await db
        .select()
        .from(schema.boxReservationsTable)
        .where(sql`${schema.boxReservationsTable.id} = ${reservation.id}`);
      expect(collected.status).toBe("collected");
      expect(collected.collectedAt).not.toBeNull();

      // Order projected to delivered; shipment too.
      const [orderAfter] = await db
        .select()
        .from(schema.ordersTable)
        .where(sql`${schema.ordersTable.id} = ${orderId}`);
      expect(orderAfter.status).toBe("delivered");
      const [shipAfter] = await db
        .select()
        .from(schema.shipmentsTable)
        .where(sql`${schema.shipmentsTable.orderId} = ${orderId}`);
      expect(shipAfter.status).toBe("delivered");

      // Second unlock attempt is rejected as already collected.
      const replay = await request(buildApiApp())
        .post("/api/box/unlock")
        .send({ reservationId: reservation.id, otp });
      expect(replay.status).toBe(409);
      expect(replay.body.error).toBe("already_collected");
    });

    it("validates the body and returns 400 / 404 for missing inputs", async () => {
      const missing = await request(buildApiApp()).post("/api/box/unlock").send({});
      expect(missing.status).toBe(400);
      const notFound = await request(buildApiApp())
        .post("/api/box/unlock")
        .send({ reservationId: uniq("missing"), otp: "1234" });
      expect(notFound.status).toBe(404);
    });
  });

  describe("PUDO partner endpoints — manifest + cross-partner authorization", () => {
    it("authenticates partners and rejects shipments belonging to a different partner", async () => {
      const partnerA = uniq("partner");
      const partnerB = uniq("partner");
      const keyA = crypto.randomBytes(16).toString("hex");
      const keyB = crypto.randomBytes(16).toString("hex");
      const locA = uniq("loc");
      const locB = uniq("loc");
      const userId = uniq("u");
      const productId = uniq("prod");
      const orderA = uniq("ord");
      const orderB = uniq("ord");

      await insertPudoPartner(partnerA, keyA);
      await insertPudoPartner(partnerB, keyB);
      await insertPudoLocation(locA, partnerA);
      await insertPudoLocation(locB, partnerB);
      await insertUser(userId);
      await insertProduct(productId);
      await insertOrder({
        id: orderA,
        userId,
        optionId: "pudo",
        productId,
        qty: 1,
        priceMinor: 500_000,
        locationId: locA,
        pickupOtp: "1111",
      });
      await insertOrder({
        id: orderB,
        userId,
        optionId: "pudo",
        productId,
        qty: 1,
        priceMinor: 500_000,
        locationId: locB,
        pickupOtp: "2222",
      });
      await dispatchModule.dispatchShipmentForOrder(orderA);
      await dispatchModule.dispatchShipmentForOrder(orderB);

      // --- Auth contract ---
      const noKey = await request(buildApiApp()).get(`/api/pudo/${partnerA}/manifest`);
      expect(noKey.status).toBe(401);

      const wrongKey = await request(buildApiApp())
        .get(`/api/pudo/${partnerA}/manifest`)
        .set("x-internal-key", "nope");
      expect(wrongKey.status).toBe(403);

      // --- Manifest scope ---
      const manifest = await request(buildApiApp())
        .get(`/api/pudo/${partnerA}/manifest`)
        .set("x-internal-key", keyA);
      expect(manifest.status).toBe(200);
      // CSV header + 1 row for orderA, no row for orderB. Partner B's
      // order is filtered by the locationId IN (...) clause.
      const csv = manifest.text;
      expect(csv).toContain(orderA);
      expect(csv).not.toContain(orderB);
      // Audit row was written.
      const runs = await db
        .select()
        .from(schema.pudoManifestRunsTable)
        .where(sql`${schema.pudoManifestRunsTable.partnerCode} = ${partnerA}`);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.shipmentCount).toBe(1);

      // --- Collected: cross-partner shipment id is filtered out ---
      const [shipB] = await db
        .select()
        .from(schema.shipmentsTable)
        .where(sql`${schema.shipmentsTable.orderId} = ${orderB}`);
      const [shipA] = await db
        .select()
        .from(schema.shipmentsTable)
        .where(sql`${schema.shipmentsTable.orderId} = ${orderA}`);

      // Partner A submits B's shipment id with A's key. The candidate
      // row is found in the shipments table, but the per-partner
      // location filter must drop it — processed=0, rejected counts
      // the candidate that did not pass authorization.
      const crossPartner = await request(buildApiApp())
        .post(`/api/pudo/${partnerA}/collected`)
        .set("x-internal-key", keyA)
        .send({ shipmentIds: [shipB!.id] });
      expect(crossPartner.status).toBe(200);
      expect(crossPartner.body.processed).toBe(0);
      expect(crossPartner.body.rejected).toBe(1);
      // Order B remains untouched.
      const [orderBAfter] = await db
        .select()
        .from(schema.ordersTable)
        .where(sql`${schema.ordersTable.id} = ${orderB}`);
      expect(orderBAfter.status).toBe("placed");

      // --- Collected: own shipment id is processed ---
      const own = await request(buildApiApp())
        .post(`/api/pudo/${partnerA}/collected`)
        .set("x-internal-key", keyA)
        .send({ shipmentIds: [shipA!.id] });
      expect(own.status).toBe(200);
      expect(own.body.processed).toBe(1);
      expect(own.body.rejected).toBe(0);

      // The shipment got a delivered tracking event ingested via the
      // dispatch helper, projected onto the order.
      const events = await db
        .select()
        .from(schema.shipmentEventsTable)
        .where(sql`${schema.shipmentEventsTable.shipmentId} = ${shipA!.id}`);
      const statuses = events.map((e) => e.status);
      expect(statuses).toContain("delivered");
      const [orderAAfter] = await db
        .select()
        .from(schema.ordersTable)
        .where(sql`${schema.ordersTable.id} = ${orderA}`);
      expect(orderAAfter.status).toBe("delivered");

      // --- Collected: rejects empty shipmentIds with 400 ---
      const empty = await request(buildApiApp())
        .post(`/api/pudo/${partnerA}/collected`)
        .set("x-internal-key", keyA)
        .send({ shipmentIds: [] });
      expect(empty.status).toBe(400);
    });

    it("returns 404 no_locations_for_partner when the partner has no fulfillment locations", async () => {
      const partner = uniq("partner");
      const key = crypto.randomBytes(16).toString("hex");
      await insertPudoPartner(partner, key);

      const r = await request(buildApiApp())
        .get(`/api/pudo/${partner}/manifest`)
        .set("x-internal-key", key);
      expect(r.status).toBe(404);
      expect(r.body.error).toBe("no_locations_for_partner");
    });
  });
});
