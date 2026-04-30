import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import express, { type Express } from "express";
import request from "supertest";

/**
 * Integration tests for the cash-on-collection (COD) branch of POST
 * `/api/orders` and GET `/api/orders/:id`.
 *
 * Pay-on-collection orders skip the payment-provider callback, so all of
 * the side-effects that prepaid orders inherit from `markIntentSucceeded
 * → finalizeOrderAfterPayment → dispatchShipmentForOrder` have to be
 * triggered inline by POST `/orders` instead. Without these tests, a
 * regression that drops the `dispatchShipmentForOrder(id)` call (or
 * silently fails it) would leave COD buyers without a shipment row, no
 * tracking link, and no Box reservation tied to their pickup OTP — and
 * none of the existing unit suites would catch it.
 *
 * What this suite locks in:
 *   1. POST /orders with `payment.methodId = "cod"` + a pickup option
 *      moves the order to `ready_for_pickup` and returns it with the
 *      shipment row + initial timeline event in the response body, so
 *      the order-detail screen renders the tracking pane immediately
 *      without a second round-trip.
 *   2. A `box_reservations` row is created for an Epplaa Box pickup,
 *      using the order's `pickupOtp` as the unlock code.
 *   3. GET /orders/:id surfaces the same shipment + timeline.
 *   4. Re-invoking dispatchShipmentForOrder() after a successful COD
 *      placement (e.g. a duplicate carrier webhook racing the inline
 *      call) is idempotent — no second shipment row, no second box
 *      reservation.
 *
 * Skips itself when DATABASE_URL is not set so it does not break local
 * environments without a Postgres. Cleans up its own rows so it does
 * not pollute shared dev data.
 */

// Hoisted Clerk mock — `getAuth` reads the calling user from the
// `x-test-user-id` header. Same pattern used by the MFA route tests.
vi.mock("@clerk/express", () => ({
  getAuth: (req: { headers: Record<string, string | string[] | undefined> }) => {
    const raw = req.headers["x-test-user-id"];
    const userId = typeof raw === "string" && raw.length > 0 ? raw : null;
    return { userId };
  },
}));

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const TEST_USER_PREFIX = "test-orders-cod-";
const TEST_PRODUCT_PREFIX = "test-orders-cod-prod-";

d("POST /api/orders — cash-on-delivery pickup dispatches shipment", () => {
  type Db = typeof import("../lib/db")["db"];
  type Schema = typeof import("../lib/db")["schema"];
  type Sql = typeof import("drizzle-orm")["sql"];
  type Eq = typeof import("drizzle-orm")["eq"];
  type OrdersRouter = typeof import("./orders")["default"];

  let db: Db;
  let schema: Schema;
  let sql: Sql;
  let eq: Eq;
  let ordersRouter: OrdersRouter;

  function makeUserId(): string {
    return `${TEST_USER_PREFIX}${crypto.randomBytes(8).toString("hex")}`;
  }

  function makeProductId(): string {
    return `${TEST_PRODUCT_PREFIX}${crypto.randomBytes(8).toString("hex")}`;
  }

  function buildApp(): Express {
    const app = express();
    app.use(express.json());
    app.use("/api", ordersRouter);
    return app;
  }

  /**
   * Insert a minimal product so the order's items snapshot resolves to a
   * real `products.id` (otherwise `resolveOrderTotals` drops the line and
   * POST /orders 400s with `no_valid_items`). We don't attribute a seller
   * because COD orders skip the seller-payout codepath; an unattributed
   * line is fine for the dispatch assertions.
   */
  async function insertProduct(productId: string): Promise<void> {
    await db.insert(schema.productsTable).values({
      id: productId,
      title: "Test product (COD)",
      priceMinor: 250000,
      originCountry: "NG",
      originLabel: "Made in Nigeria",
      sellerName: "Test Seller",
      countryCode: "NG",
    });
  }

  /**
   * Seed a `users` row for the buyer. The DB-level FK
   * orders.user_id -> users.clerk_id (added by initMoneyFlowFkConstraints)
   * rejects POST /orders when the caller's Clerk id has no matching
   * user row, which previously slipped through in test because the
   * column was unconstrained. Real production requests can't hit this
   * path either — they pass through the Clerk webhook that upserts the
   * user row before the first order — but the unit tests bypass that
   * flow by stubbing getAuth, so we have to seed the row manually.
   */
  async function seedUser(userId: string): Promise<void> {
    await db.insert(schema.usersTable).values({
      clerkId: userId,
      email: `${userId}@example.test`,
      displayName: "COD test buyer",
    });
  }

  async function cleanup(): Promise<void> {
    // Box reservations FK-style on order id — wipe first.
    await db.execute(
      sql`DELETE FROM box_reservations WHERE order_id IN (SELECT id FROM orders WHERE user_id LIKE ${TEST_USER_PREFIX + "%"});`,
    );
    await db.execute(
      sql`DELETE FROM shipment_events WHERE shipment_id IN (SELECT id FROM shipments WHERE user_id LIKE ${TEST_USER_PREFIX + "%"});`,
    );
    await db.execute(
      sql`DELETE FROM shipments WHERE user_id LIKE ${TEST_USER_PREFIX + "%"};`,
    );
    await db.execute(
      sql`DELETE FROM payment_intents WHERE user_id LIKE ${TEST_USER_PREFIX + "%"};`,
    );
    await db.execute(
      sql`DELETE FROM cart_items WHERE user_id LIKE ${TEST_USER_PREFIX + "%"};`,
    );
    await db.execute(
      sql`DELETE FROM checkout_drafts WHERE user_id LIKE ${TEST_USER_PREFIX + "%"};`,
    );
    await db.execute(
      sql`DELETE FROM notifications_outbox WHERE user_id LIKE ${TEST_USER_PREFIX + "%"};`,
    );
    await db.execute(
      sql`DELETE FROM orders WHERE user_id LIKE ${TEST_USER_PREFIX + "%"};`,
    );
    await db.execute(
      sql`DELETE FROM products WHERE id LIKE ${TEST_PRODUCT_PREFIX + "%"};`,
    );
    // Users last — orders FK into users.clerk_id, so the user row must
    // outlive every row that references it. Cascade-style delete order.
    await db.execute(
      sql`DELETE FROM users WHERE clerk_id LIKE ${TEST_USER_PREFIX + "%"};`,
    );
  }

  beforeAll(async () => {
    ({ db, schema } = await import("../lib/db"));
    ({ sql, eq } = await import("drizzle-orm"));
    ordersRouter = (await import("./orders")).default;
    await cleanup();
  }, 30_000);

  afterEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("creates a shipment + box reservation + timeline event for a COD Box pickup", async () => {
    const userId = makeUserId();
    const productId = makeProductId();
    await seedUser(userId);
    await insertProduct(productId);

    const r = await request(buildApp())
      .post("/api/orders")
      .set("x-test-user-id", userId)
      .send({
        countryCode: "NG",
        currencyCode: "NGN",
        items: [{ productId, qty: 2 }],
        fulfillment: {
          optionId: "epplaa-box",
          locationId: "loc-lagos-ikoyi",
          locationAddress: "Epplaa Box, Ikoyi",
          city: "Lagos",
        },
        payment: { methodId: "cod", methodLabel: "Pay on Collection" },
        totalsMinor: { shipping: 20000 },
        etaLabel: "Ready in 1-2 days",
        notificationPrefs: {},
      });

    // Order accepted and finalized to ready_for_pickup.
    expect(r.status).toBe(201);
    expect(r.body.status).toBe("ready_for_pickup");
    expect(r.body.userId).toBe(userId);
    expect(r.body.paidAtIso).toBeTruthy();
    // Pickup OTP allocated for the buyer to scan at the locker.
    expect(r.body.pickupOtp).toMatch(/^\d{4}$/);

    // Shipment row created — surfaced inline in the POST response so the
    // client renders the tracking pane without a follow-up GET.
    expect(r.body.shipmentId).toBeTruthy();
    expect(r.body.trackingUrl).toBeTruthy();
    expect(r.body.shipment).toBeTruthy();
    expect(r.body.shipment.carrier).toBe("box");
    expect(r.body.shipment.carrierRef).toMatch(/^BOX-/);
    expect(r.body.shipment.status).toBe("label_created");
    expect(Array.isArray(r.body.shipment.events)).toBe(true);
    expect(r.body.shipment.events.length).toBeGreaterThanOrEqual(1);
    expect(r.body.shipment.events[0].status).toBe("label_created");

    // COD intent is auto-succeeded — no authorization URL to redirect to.
    expect(r.body.paymentIntent.status).toBe("succeeded");
    expect(r.body.paymentIntent.gateway).toBe("cod");
    expect(r.body.paymentIntent.authorizationUrl).toBeNull();

    // DB-level cross-checks: shipment row, box reservation, single event.
    const orderId = r.body.id as string;
    const shipmentRows = await db
      .select()
      .from(schema.shipmentsTable)
      .where(eq(schema.shipmentsTable.orderId, orderId));
    expect(shipmentRows).toHaveLength(1);
    expect(shipmentRows[0].carrier).toBe("box");
    expect(shipmentRows[0].userId).toBe(userId);
    expect(shipmentRows[0].dispatchedAt).toBeTruthy();

    const reservationRows = await db
      .select()
      .from(schema.boxReservationsTable)
      .where(eq(schema.boxReservationsTable.orderId, orderId));
    expect(reservationRows).toHaveLength(1);
    expect(reservationRows[0].locationId).toBe("loc-lagos-ikoyi");
    expect(reservationRows[0].status).toBe("reserved");
    expect(reservationRows[0].boxId).toMatch(/^BX-/);

    const eventRows = await db
      .select()
      .from(schema.shipmentEventsTable)
      .where(eq(schema.shipmentEventsTable.shipmentId, shipmentRows[0].id));
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0].status).toBe("label_created");
  });

  it("GET /orders/:id returns the same shipment timeline for a COD pickup", async () => {
    const userId = makeUserId();
    const productId = makeProductId();
    await seedUser(userId);
    await insertProduct(productId);

    const post = await request(buildApp())
      .post("/api/orders")
      .set("x-test-user-id", userId)
      .send({
        countryCode: "NG",
        currencyCode: "NGN",
        items: [{ productId, qty: 1 }],
        fulfillment: {
          optionId: "epplaa-box-accra",
          locationId: "loc-accra-osu",
          locationAddress: "Epplaa Box, Osu",
          city: "Accra",
        },
        payment: { methodId: "cod-gh", methodLabel: "Pay on Collection" },
        totalsMinor: { shipping: 20000 },
        etaLabel: "Ready in 1-2 days",
        notificationPrefs: {},
      });
    expect(post.status).toBe(201);
    const orderId = post.body.id as string;

    const get = await request(buildApp())
      .get(`/api/orders/${orderId}`)
      .set("x-test-user-id", userId);
    expect(get.status).toBe(200);
    expect(get.body.id).toBe(orderId);
    expect(get.body.status).toBe("ready_for_pickup");
    expect(get.body.shipment).toBeTruthy();
    expect(get.body.shipment.carrier).toBe("box");
    expect(get.body.shipment.events.length).toBeGreaterThanOrEqual(1);
    // The order detail page reads the timeline from `shipment.events` —
    // confirm the initial label_created event is present so the buyer
    // sees a non-empty pane the moment they land on the screen.
    expect(get.body.shipment.events[0].status).toBe("label_created");
  });

  it("does not create a duplicate shipment when dispatchShipmentForOrder runs twice", async () => {
    // After a successful COD POST has already triggered inline dispatch,
    // a duplicate carrier webhook (or an admin-initiated retry) can call
    // dispatchShipmentForOrder again for the same orderId. The unique
    // index on shipments.order_id, plus the early-return inside
    // dispatchShipmentForOrder when an existing shipment row is found,
    // guarantees that second invocation is a no-op. Without this guard
    // it would attempt to insert a second shipment row and 500.
    //
    // Note: the POST /orders route generates a fresh order id per
    // request and does not key on a client-supplied idempotency token,
    // so retries at the HTTP layer would create a brand new order
    // rather than re-dispatching the same one. The dispatcher itself
    // is the idempotency boundary tested here.
    const userId = makeUserId();
    const productId = makeProductId();
    await seedUser(userId);
    await insertProduct(productId);
    const orderId = `EP-COD-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;

    const body = {
      id: orderId,
      countryCode: "NG",
      currencyCode: "NGN",
      items: [{ productId, qty: 1 }],
      fulfillment: {
        optionId: "epplaa-box",
        locationId: "loc-lagos-ikoyi",
        locationAddress: "Epplaa Box, Ikoyi",
        city: "Lagos",
      },
      payment: { methodId: "cod", methodLabel: "Pay on Collection" },
      totalsMinor: { shipping: 20000 },
      etaLabel: "Ready in 1-2 days",
      notificationPrefs: {},
    };

    const first = await request(buildApp())
      .post("/api/orders")
      .set("x-test-user-id", userId)
      .send(body);
    expect(first.status).toBe(201);

    // Re-invoke the dispatcher directly (simulating a webhook racing the
    // inline call). It must short-circuit on the existing shipment row.
    const { dispatchShipmentForOrder } = await import(
      "../lib/fulfillment/dispatch"
    );
    await expect(dispatchShipmentForOrder(orderId)).resolves.toBeUndefined();

    const shipmentRows = await db
      .select()
      .from(schema.shipmentsTable)
      .where(eq(schema.shipmentsTable.orderId, orderId));
    expect(shipmentRows).toHaveLength(1);

    const reservationRows = await db
      .select()
      .from(schema.boxReservationsTable)
      .where(eq(schema.boxReservationsTable.orderId, orderId));
    expect(reservationRows).toHaveLength(1);
  });

  it("rejects COD when the chosen option is home delivery (cod_not_allowed)", async () => {
    // Sanity check that the COD-only-at-pickup gate hasn't drifted —
    // because the dispatch path would create a Box reservation for an
    // address that doesn't have one if this gate ever loosened.
    const userId = makeUserId();
    const productId = makeProductId();
    await insertProduct(productId);

    const r = await request(buildApp())
      .post("/api/orders")
      .set("x-test-user-id", userId)
      .send({
        countryCode: "NG",
        currencyCode: "NGN",
        items: [{ productId, qty: 1 }],
        fulfillment: {
          optionId: "home-delivery",
          deliveryAddress: { street: "1 Test Rd", area: "VI", city: "Lagos" },
        },
        payment: { methodId: "cod" },
        totalsMinor: { shipping: 50000 },
        etaLabel: "1-3 days",
        notificationPrefs: {},
      });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("cod_not_allowed");
  });
});
