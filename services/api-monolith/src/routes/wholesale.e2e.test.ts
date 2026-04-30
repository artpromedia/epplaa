import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import crypto from "node:crypto";
import express, { type Express } from "express";
import request from "supertest";

/**
 * End-to-end HTTP regression for the cross-border wholesale order happy path.
 *
 * Walks the full lifecycle the manufacturer portal, seller console, and
 * back-office customs queue exercise in production:
 *
 *   1. POST /manufacturer/apply                — manufacturer onboards
 *   2. POST /admin/manufacturers/:id/decide    — admin approves (KYC ok)
 *   3. POST /manufacturer/listings             — manufacturer lists a SKU
 *   4. POST /wholesale/quote                   — seller previews landed cost
 *   5. POST /wholesale/orders                  — seller places the order
 *      (asserts the placed order's frozen cost matches the preview's
 *       FOB / freight / duty / VAT / landed-total exactly)
 *   6. POST /manufacturer/orders/:id/ship      — manufacturer ships
 *   7. POST /admin/customs/:id/events          — admin posts arrived_port,
 *                                                duty_paid, released
 *   8. POST /admin/bonded-inventory/:id/arrived  — bonded warehouse arrival
 *   9. POST /admin/bonded-inventory/:id/released — full release →
 *                                                  delivered + payout enqueue
 *  10. GET  /wholesale/orders/:id              — asserts the customs timeline
 *                                                comes back in ascending order
 *  11. enqueueManufacturerPayoutForWholesaleOrder() called a second time
 *      directly to assert idempotency: still exactly one payout row in
 *      the `payouts` table for the order.
 *
 * Skips itself when DATABASE_URL is not set so the suite stays green
 * on local environments without Postgres. Cleans up its own rows so
 * it does not pollute shared dev data. The audit_events append-only
 * trigger blocks DELETE on that table by design, so audit rows
 * written by this test stay (the prefixed entityIds make them easy to
 * spot but cannot be removed — that is the point of an immutable
 * compliance log).
 */

// Hoisted Clerk mock — `getAuth` reads the calling user from the
// `x-test-user-id` header so the requireUserId / requireRole
// middlewares can be exercised without standing up a real Clerk
// session. Identical pattern to fulfillment.e2e.test.ts.
//
// `factorVerificationAge: [0, 0]` simulates an MFA-verified session
// (firstFactorAge=0, secondFactorAge=0 minutes — both factors
// verified just now). `requireRole` calls `hasMfaVerifiedSession`
// AFTER the role check and 403s with `mfa_required` when the second
// factor is missing, which would block every admin call this e2e
// makes. The test's intent is to model a signed-in, MFA-verified
// admin walking the cross-border wholesale flow, so the mock has to
// supply both halves of the auth contract — userId AND fva. Without
// this the test only passes when run as part of a larger suite (where
// some preceding file's vi.mock state happens to leak into shared
// vitest module state); in isolation the admin-decide call 403s.
vi.mock("@clerk/express", () => ({
  getAuth: (req: { headers: Record<string, string | string[] | undefined> }) => {
    const raw = req.headers["x-test-user-id"];
    const userId = typeof raw === "string" && raw.length > 0 ? raw : null;
    const fva: [number, number] = [0, 0];
    return {
      userId,
      factorVerificationAge: fva,
      sessionClaims: { fva },
    };
  },
}));

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const PREFIX = "test-wo-";

// Pin the freight provider to the deterministic in-memory DevMock
// forwarder so the booking returns "booked" instantly without
// touching any real partner. Set before any module that captures
// the provider in a singleton is imported.
process.env.FREIGHT_PROVIDER = "devmock";

d("Cross-border wholesale happy path e2e (HTTP)", () => {
  type Db = typeof import("../lib/db")["db"];
  type Schema = typeof import("../lib/db")["schema"];
  type Sql = typeof import("drizzle-orm")["sql"];
  type ManufacturerRouter = typeof import("./manufacturer")["default"];
  type WholesaleRouter = typeof import("./wholesale")["default"];
  type ManufacturerAdminRouter = typeof import("./manufacturerAdmin")["default"];
  type Payouts = typeof import("../lib/manufacturerPayouts");

  let db: Db;
  let schema: Schema;
  let sql: Sql;
  let manufacturerRouter: ManufacturerRouter;
  let wholesaleRouter: WholesaleRouter;
  let manufacturerAdminRouter: ManufacturerAdminRouter;
  let payouts: Payouts;
  let drizzleEq: typeof import("drizzle-orm")["eq"];
  let drizzleAnd: typeof import("drizzle-orm")["and"];

  /** Single express app mounting all routers under `/api`. */
  function buildApp(): Express {
    const app = express();
    app.use(express.json());
    app.use("/api", manufacturerRouter);
    app.use("/api", wholesaleRouter);
    app.use("/api", manufacturerAdminRouter);
    return app;
  }

  function uniq(label: string): string {
    return `${PREFIX}${label}-${crypto.randomBytes(4).toString("hex")}`;
  }

  async function insertUser(id: string, name: string, country = "NG"): Promise<void> {
    await db
      .insert(schema.usersTable)
      .values({
        clerkId: id,
        email: `${id}@example.com`,
        displayName: name,
        countryCode: country,
      })
      .onConflictDoNothing();
  }

  /**
   * Grant the canonical `admin` role to a user. The roles table is
   * seeded by `bootstrapRoles()` (or in the local DB by a previous
   * test/app boot); we look it up by name rather than hard-coding
   * a role id because the IDs are random per-environment.
   */
  async function grantAdmin(userId: string): Promise<void> {
    const [row] = await db
      .select({ id: schema.rolesTable.id })
      .from(schema.rolesTable)
      .where(drizzleEq(schema.rolesTable.name, "admin"))
      .limit(1);
    if (!row) throw new Error("admin_role_not_seeded");
    await db
      .insert(schema.userRolesTable)
      .values({ userId, roleId: row.id })
      .onConflictDoNothing();
  }

  /**
   * Seed a `clear` sanctions screening for the manufacturer's user so
   * the payout enqueue path exercises the unblocked branch (otherwise
   * the stub provider would still return clear for NG, but pinning
   * the row removes any ordering dependency on screen-on-demand).
   */
  async function clearSanctions(userId: string, name: string): Promise<void> {
    await db.insert(schema.sanctionsScreeningsTable).values({
      id: uniq("scr"),
      userId,
      subjectKind: "manufacturer",
      provider: "stub",
      subjectName: name,
      subjectCountry: "CN",
      matchScore: 0,
      listHits: [],
      status: "clear",
      nextReviewAt: new Date(Date.now() + 90 * 24 * 3600 * 1000),
    });
  }

  beforeAll(async () => {
    if (!hasDb) return;
    const dbModule = await import("../lib/db");
    db = dbModule.db;
    schema = dbModule.schema;
    const drizzle = await import("drizzle-orm");
    sql = drizzle.sql;
    drizzleEq = drizzle.eq;
    drizzleAnd = drizzle.and;
    // Boot-time schema initialisers — vitest does not run app.ts so we
    // must call these explicitly. All four are idempotent CREATE IF
    // NOT EXISTS / ALTER TABLE ADD COLUMN IF NOT EXISTS scripts.
    const audit = await import("../lib/audit");
    const roles = await import("../lib/roles");
    const manufacturers = await import("../lib/manufacturers");
    const fx = await import("../lib/fx");
    await audit.initAuditChain();
    await roles.initAdminSchema();
    await manufacturers.initManufacturerSchema();
    await fx.seedFxRatesIfEmpty();
    manufacturerRouter = (await import("./manufacturer")).default;
    wholesaleRouter = (await import("./wholesale")).default;
    manufacturerAdminRouter = (await import("./manufacturerAdmin")).default;
    payouts = await import("../lib/manufacturerPayouts");
  });

  afterAll(async () => {
    if (!hasDb) return;
    // Tear down every row this suite created. Order matters because
    // bonded_warehouse_inventory and freight_bookings reference
    // wholesale_orders, and payouts reference order_id. Audit events
    // are intentionally left in place — the table's append-only
    // trigger blocks DELETE.
    await db.execute(sql`DELETE FROM customs_events WHERE wholesale_order_id LIKE ${PREFIX + "%"}`);
    await db.execute(sql`DELETE FROM bonded_warehouse_inventory WHERE wholesale_order_id LIKE ${PREFIX + "%"}`);
    await db.execute(sql`DELETE FROM freight_bookings WHERE wholesale_order_id LIKE ${PREFIX + "%"}`);
    await db.execute(sql`DELETE FROM payouts WHERE order_id LIKE ${PREFIX + "%"} OR reference LIKE ${"WO-" + PREFIX + "%"}`);
    await db.execute(sql`DELETE FROM wholesale_orders WHERE id LIKE ${PREFIX + "%"}`);
    await db.execute(sql`DELETE FROM manufacturer_listings WHERE id LIKE ${PREFIX + "%"}`);
    await db.execute(sql`DELETE FROM manufacturer_kyc WHERE manufacturer_id LIKE ${PREFIX + "%"}`);
    await db.execute(sql`DELETE FROM manufacturers WHERE id LIKE ${PREFIX + "%"}`);
    await db.execute(sql`DELETE FROM sanctions_screenings WHERE id LIKE ${PREFIX + "%"}`);
    await db.execute(sql`DELETE FROM user_roles WHERE user_id LIKE ${PREFIX + "%"}`);
    await db.execute(sql`DELETE FROM users WHERE clerk_id LIKE ${PREFIX + "%"}`);
  });

  it("walks apply → approve → list → quote → place → ship → customs → bonded → delivered → payout (idempotent)", async () => {
    const app = buildApp();

    // --- Actors ------------------------------------------------------------
    const manufacturerUser = uniq("mfr-user");
    const sellerUser = uniq("seller");
    const adminUser = uniq("admin");
    await insertUser(manufacturerUser, "Test Manufacturer", "CN");
    await insertUser(sellerUser, "Test Seller", "NG");
    await insertUser(adminUser, "Test Admin", "NG");
    await grantAdmin(adminUser);
    await clearSanctions(manufacturerUser, "Test Manufacturer");

    // --- 1. Apply as a manufacturer ---------------------------------------
    const applyRes = await request(app)
      .post("/api/manufacturer/apply")
      .set("x-test-user-id", manufacturerUser)
      .send({
        originCountry: "CN",
        legalName: "Test Manufacturer Co Ltd",
        contactEmail: "ops@test-mfr.example",
        contactPhone: "+8613800000000",
        exportLicenceNumber: "EXP-TEST-0001",
      });
    expect(applyRes.status).toBe(201);
    expect(applyRes.body.status).toBe("pending");
    const manufacturerId: string = applyRes.body.manufacturer.id;
    expect(manufacturerId).toBeTruthy();

    // Re-prefix the manufacturer row id with our test prefix so afterAll
    // can sweep it. The route uses `newManufacturerId()` which does NOT
    // honour our prefix, so we patch via SQL.
    const prefixedManufacturerId = uniq("mfr");
    await db.execute(
      sql`UPDATE manufacturers SET id = ${prefixedManufacturerId} WHERE id = ${manufacturerId}`,
    );

    // --- 2. Real KYC moderation subflow ----------------------------------
    // Manufacturer uploads the three required KYC documents. The third
    // admin approval auto-approves the manufacturer profile by way of
    // the all-required-docs check in /admin/manufacturer-kyc/:id/decide,
    // so we don't need to call /admin/manufacturers/:id/decide directly —
    // this exercises the production approval path (KYC, not the
    // moderator's manual override).
    const requiredKycKinds = ["export_licence", "business_registration", "tax_id"] as const;
    const kycIds: string[] = [];
    for (const kind of requiredKycKinds) {
      const uploadRes = await request(app)
        .post("/api/manufacturer/kyc")
        .set("x-test-user-id", manufacturerUser)
        .send({ kind, documentUrl: `https://example.com/test-${kind}.pdf` });
      expect(uploadRes.status).toBe(201);
      // Re-prefix the KYC row id so afterAll can sweep it cleanly even
      // though we already cascade by manufacturer_id.
      const realKycId: string = uploadRes.body.id;
      const prefixedKycId = uniq(`kyc-${kind}`);
      await db.execute(
        sql`UPDATE manufacturer_kyc SET id = ${prefixedKycId} WHERE id = ${realKycId}`,
      );
      kycIds.push(prefixedKycId);
    }
    for (const kycId of kycIds) {
      const decideRes = await request(app)
        .post(`/api/admin/manufacturer-kyc/${kycId}/decide`)
        .set("x-test-user-id", adminUser)
        .send({ decision: "approve" });
      expect(decideRes.status).toBe(200);
      expect(decideRes.body.status).toBe("approved");
    }
    // Confirm the auto-approve fired: GET /manufacturer/me must report
    // status=approved before listings are allowed.
    const meRes = await request(app)
      .get("/api/manufacturer/me")
      .set("x-test-user-id", manufacturerUser);
    expect(meRes.status).toBe(200);
    expect(meRes.body.status).toBe("approved");

    // --- 3. List a SKU ----------------------------------------------------
    const listingRes = await request(app)
      .post("/api/manufacturer/listings")
      .set("x-test-user-id", manufacturerUser)
      .send({
        sku: "TEST-SKU-001",
        title: "Test Wholesale Widget",
        description: "Widgets for end-to-end coverage",
        hsCode: "851713",
        originCurrencyCode: "USD",
        wholesalePriceMinor: 5_00, // $5.00 per unit
        moq: 10,
        leadDays: 7,
        weightGrams: 250,
        category: "Electronics",
      });
    expect(listingRes.status).toBe(201);
    const listingId: string = listingRes.body.id;
    expect(listingId).toBeTruthy();
    // Re-prefix the listing id so afterAll can sweep it.
    const prefixedListingId = uniq("lst");
    await db.execute(
      sql`UPDATE manufacturer_listings SET id = ${prefixedListingId} WHERE id = ${listingId}`,
    );

    // --- 4. Landed-cost preview -------------------------------------------
    const qty = 50;
    const quoteRes = await request(app)
      .post("/api/wholesale/quote")
      .send({
        listingId: prefixedListingId,
        qty,
        destinationCountryCode: "NG",
        shipMode: "air",
      });
    expect(quoteRes.status).toBe(200);
    const quote = quoteRes.body.breakdown;
    expect(quote).toBeTruthy();
    expect(quote.fobMinor).toBeGreaterThan(0);
    expect(quote.landedTotalMinor).toBeGreaterThan(quote.fobMinor);

    // --- 5. Place the wholesale order -------------------------------------
    const placeRes = await request(app)
      .post("/api/wholesale/orders")
      .set("x-test-user-id", sellerUser)
      .send({
        listingId: prefixedListingId,
        qty,
        destinationCountryCode: "NG",
        shipMode: "air",
      });
    expect(placeRes.status).toBe(201);
    const placedOrderId: string = placeRes.body.id;
    expect(placedOrderId).toBeTruthy();
    // Re-prefix the wholesale order id, freight booking id, customs event ids,
    // so the afterAll sweep can clean every child row by LIKE prefix. We do
    // this in dependency order: child rows first (FK columns), then parent.
    const prefixedOrderId = uniq("wo");
    await db.execute(
      sql`UPDATE customs_events SET wholesale_order_id = ${prefixedOrderId} WHERE wholesale_order_id = ${placedOrderId}`,
    );
    await db.execute(
      sql`UPDATE freight_bookings SET wholesale_order_id = ${prefixedOrderId} WHERE wholesale_order_id = ${placedOrderId}`,
    );
    await db.execute(
      sql`UPDATE wholesale_orders SET id = ${prefixedOrderId} WHERE id = ${placedOrderId}`,
    );
    const orderId = prefixedOrderId;

    // ASSERTION: landed-cost preview equals placed-order frozen cost.
    // The placed order must surface FOB, freight, duty, VAT and landed
    // total identical to what the preview promised — anything else is
    // a price-quote drift bug.
    expect(placeRes.body.fobMinor).toBe(quote.fobMinor);
    expect(placeRes.body.freightMinor).toBe(quote.freightMinor);
    expect(placeRes.body.dutyMinor).toBe(quote.dutyMinor);
    expect(placeRes.body.vatMinor).toBe(quote.vatMinor);
    expect(placeRes.body.landedTotalMinor).toBe(quote.landedTotalMinor);
    expect(placeRes.body.status).toBe("booked");

    // --- 6. Manufacturer marks shipped ------------------------------------
    const shipRes = await request(app)
      .post(`/api/manufacturer/orders/${orderId}/ship`)
      .set("x-test-user-id", manufacturerUser)
      .send({});
    expect(shipRes.status).toBe(200);
    expect(shipRes.body.status).toBe("in_transit");

    // --- 7. Admin posts customs events ------------------------------------
    const arrivedRes = await request(app)
      .post(`/api/admin/customs/${orderId}/events`)
      .set("x-test-user-id", adminUser)
      .send({ kind: "arrived_port", note: "Vessel docked at Lagos" });
    expect(arrivedRes.status).toBe(201);
    expect(arrivedRes.body.statusTransition).toBe("at_customs");

    const dutyPaidRes = await request(app)
      .post(`/api/admin/customs/${orderId}/events`)
      .set("x-test-user-id", adminUser)
      .send({ kind: "duty_paid", note: "Duty cleared by broker" });
    expect(dutyPaidRes.status).toBe(201);

    const releasedRes = await request(app)
      .post(`/api/admin/customs/${orderId}/events`)
      .set("x-test-user-id", adminUser)
      .send({ kind: "released", note: "Released by customs" });
    expect(releasedRes.status).toBe(201);
    expect(releasedRes.body.statusTransition).toBe("cleared");

    // --- 8. Bonded warehouse arrival --------------------------------------
    const bondedArrivedRes = await request(app)
      .post(`/api/admin/bonded-inventory/${orderId}/arrived`)
      .set("x-test-user-id", adminUser)
      .send({ warehouseCode: "LOS-BWH-01" });
    expect(bondedArrivedRes.status).toBe(201);
    expect(bondedArrivedRes.body.qtyOnHand).toBe(qty);

    // Re-prefix the bonded inventory row id so afterAll can sweep it.
    const prefixedBondedId = uniq("binv");
    await db.execute(
      sql`UPDATE bonded_warehouse_inventory SET id = ${prefixedBondedId} WHERE wholesale_order_id = ${orderId}`,
    );

    // --- 9. Bonded warehouse full release → delivered + payout enqueue ----
    const bondedReleasedRes = await request(app)
      .post(`/api/admin/bonded-inventory/${orderId}/released`)
      .set("x-test-user-id", adminUser)
      .send({}); // omit qty → release the full on-hand balance
    expect(bondedReleasedRes.status).toBe(200);
    expect(bondedReleasedRes.body.delivered).toBe(true);
    expect(bondedReleasedRes.body.payoutEnqueued).toBe(true);

    // --- 10. Customs timeline returns ascending --------------------------
    const detailRes = await request(app)
      .get(`/api/wholesale/orders/${orderId}`)
      .set("x-test-user-id", sellerUser);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.order.status).toBe("delivered");
    const events: Array<{ kind: string; createdAtIso: string }> = detailRes.body.events;
    expect(events.length).toBeGreaterThanOrEqual(7); // docs_submitted, carrier_pickup, arrived_port, duty_paid, released, warehouse_arrived, warehouse_released
    const timestamps = events.map((e) => Date.parse(e.createdAtIso));
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]);
    }
    // Spot-check the canonical sequence of state-bumping events appears
    // in the timeline in the right relative order.
    const kinds = events.map((e) => e.kind);
    expect(kinds.indexOf("carrier_pickup")).toBeLessThan(kinds.indexOf("arrived_port"));
    expect(kinds.indexOf("arrived_port")).toBeLessThan(kinds.indexOf("released"));
    expect(kinds.indexOf("released")).toBeLessThan(kinds.indexOf("warehouse_arrived"));
    expect(kinds.indexOf("warehouse_arrived")).toBeLessThan(kinds.indexOf("warehouse_released"));

    // --- 11. Manufacturer payout enqueued exactly once -------------------
    const payoutRowsAfterFirst = await db
      .select()
      .from(schema.payoutsTable)
      .where(
        drizzleAnd(
          drizzleEq(schema.payoutsTable.orderId, orderId),
          drizzleEq(schema.payoutsTable.kind, "manufacturer_share"),
        ),
      );
    expect(payoutRowsAfterFirst.length).toBe(1);
    const payoutRow = payoutRowsAfterFirst[0];
    expect(payoutRow.reference).toBe(`WO-${orderId}`);
    expect(payoutRow.status).toBe("pending"); // sanctions row is "clear"
    expect(payoutRow.userId).toBe(manufacturerUser);
    expect(payoutRow.currencyCode).toBe("USD"); // origin currency
    // 8% platform fee → manufacturer share = FOB * 0.92, rounded.
    const expectedPayoutMinor = placeRes.body.fobMinor - Math.round(placeRes.body.fobMinor * 0.08);
    expect(payoutRow.amountMinor).toBe(expectedPayoutMinor);

    // Idempotency at the helper level: invoking the enqueue helper
    // directly a second time must NOT insert a second payout row, and
    // the function must report `false` (already enqueued).
    const second = await payouts.enqueueManufacturerPayoutForWholesaleOrder(orderId);
    expect(second).toBe(false);

    // Idempotency at the route boundary: if the bonded-warehouse
    // released webhook is replayed by the back office (or the partner
    // posts the same release event twice), the route must report
    // payoutEnqueued=false and not insert a second payouts row.
    const replayRes = await request(app)
      .post(`/api/admin/bonded-inventory/${orderId}/released`)
      .set("x-test-user-id", adminUser)
      .send({}); // omit qty → release-all path falls through to qty=0 since on-hand is 0
    expect(replayRes.status).toBe(200);
    expect(replayRes.body.delivered).toBe(true);
    expect(replayRes.body.payoutEnqueued).toBe(false);

    const payoutRowsAfterSecond = await db
      .select({ id: schema.payoutsTable.id })
      .from(schema.payoutsTable)
      .where(
        drizzleAnd(
          drizzleEq(schema.payoutsTable.orderId, orderId),
          drizzleEq(schema.payoutsTable.kind, "manufacturer_share"),
        ),
      );
    expect(payoutRowsAfterSecond.length).toBe(1);
    expect(payoutRowsAfterSecond[0].id).toBe(payoutRow.id);
  });
});
