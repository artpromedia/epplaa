import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import crypto from "node:crypto";
import express, { type Express } from "express";
import request from "supertest";

/**
 * Regression test for #204 — partial bonded-warehouse release.
 *
 * The full happy path is covered by `wholesale.e2e.test.ts`, which only
 * exercises a release that drains the entire on-hand quantity and
 * therefore enqueues the manufacturer payout. The partial-release
 * scenario (release some units, leave others in bonded) has different
 * invariants that this test pins down:
 *
 *   1. The route updates `qty_on_hand` and `qty_released` correctly,
 *      and the wholesale order is NOT yet `delivered`.
 *   2. The manufacturer payout is NOT enqueued — duty was already paid
 *      on the full landed cost upstream, but payout only fires on the
 *      final release that drains on-hand to zero.
 *   3. A second release that drains the remainder DOES flip the order
 *      to `delivered` and enqueue exactly one payout (idempotency
 *      preserved across the two-step release).
 *   4. Releasing more units than `qty_on_hand` is rejected with
 *      `qty_exceeds_on_hand` and does not mutate state.
 *
 * Runs against a real Postgres if `DATABASE_URL` is set; skips
 * otherwise so the suite stays green on local environments.
 */

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
const PREFIX = "test-wo-bonded-partial-";

d("Wholesale — partial bonded-warehouse release", () => {
  type Db = typeof import("../lib/db")["db"];
  type Schema = typeof import("../lib/db")["schema"];
  type Sql = typeof import("drizzle-orm")["sql"];

  let db: Db;
  let schema: Schema;
  let sql: Sql;
  let app: Express;
  let drizzleEq: typeof import("drizzle-orm")["eq"];
  let drizzleAnd: typeof import("drizzle-orm")["and"];

  function uniq(label: string): string {
    return `${PREFIX}${label}-${crypto.randomBytes(4).toString("hex")}`;
  }

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

  beforeAll(async () => {
    if (!hasDb) return;
    const dbModule = await import("../lib/db");
    db = dbModule.db;
    schema = dbModule.schema;
    const drizzle = await import("drizzle-orm");
    sql = drizzle.sql;
    drizzleEq = drizzle.eq;
    drizzleAnd = drizzle.and;
    const audit = await import("../lib/audit");
    const roles = await import("../lib/roles");
    const manufacturers = await import("../lib/manufacturers");
    await audit.initAuditChain();
    await roles.initAdminSchema();
    await manufacturers.initManufacturerSchema();
    const manufacturerAdminRouter = (await import("./manufacturerAdmin")).default;
    app = express();
    app.use(express.json());
    app.use("/api", manufacturerAdminRouter);
  });

  afterAll(async () => {
    if (!hasDb) return;
    await db.execute(
      sql`DELETE FROM customs_events WHERE wholesale_order_id LIKE ${PREFIX + "%"}`,
    );
    await db.execute(
      sql`DELETE FROM bonded_warehouse_inventory WHERE wholesale_order_id LIKE ${PREFIX + "%"}`,
    );
    await db.execute(
      sql`DELETE FROM payouts WHERE order_id LIKE ${PREFIX + "%"} OR reference LIKE ${"WO-" + PREFIX + "%"}`,
    );
    await db.execute(
      sql`DELETE FROM wholesale_orders WHERE id LIKE ${PREFIX + "%"}`,
    );
    await db.execute(
      sql`DELETE FROM manufacturers WHERE id LIKE ${PREFIX + "%"}`,
    );
    await db.execute(
      sql`DELETE FROM sanctions_screenings WHERE id LIKE ${PREFIX + "%"}`,
    );
    await db.execute(
      sql`DELETE FROM user_roles WHERE user_id LIKE ${PREFIX + "%"}`,
    );
    await db.execute(
      sql`DELETE FROM users WHERE clerk_id LIKE ${PREFIX + "%"}`,
    );
  });

  it(
    "releases part of the on-hand stock without flipping delivered or enqueuing payout, and idempotently completes on the second release",
    async () => {
      const adminUser = uniq("admin");
      const manufacturerUser = uniq("mfg-user");
      const manufacturerId = uniq("mfg");
      const orderId = uniq("wo");

      await db
        .insert(schema.usersTable)
        .values([
          {
            clerkId: adminUser,
            email: `${adminUser}@example.com`,
            displayName: "Bonded Admin",
            countryCode: "NG",
          },
          {
            clerkId: manufacturerUser,
            email: `${manufacturerUser}@example.com`,
            displayName: "Bonded Manufacturer",
            countryCode: "CN",
          },
        ])
        .onConflictDoNothing();
      await grantAdmin(adminUser);

      // Seed `clear` sanctions so the eventual payout is `pending`, not `blocked`.
      await db.insert(schema.sanctionsScreeningsTable).values({
        id: uniq("scr"),
        userId: manufacturerUser,
        subjectKind: "manufacturer",
        provider: "stub",
        subjectName: "Bonded Manufacturer",
        subjectCountry: "CN",
        matchScore: 0,
        listHits: [],
        status: "clear",
        nextReviewAt: new Date(Date.now() + 90 * 24 * 3600 * 1000),
      });

      await db.execute(
        sql`INSERT INTO manufacturers (id, user_id, legal_name, registered_country, origin_country, status)
            VALUES (${manufacturerId}, ${manufacturerUser}, 'Bonded Co', 'CN', 'CN', 'approved')
            ON CONFLICT (id) DO NOTHING;`,
      );

      const totalQty = 100;
      const fobMinor = 5_000_000;
      await db.execute(
        sql`INSERT INTO wholesale_orders
              (id, seller_user_id, manufacturer_id, listing_id, qty,
               fob_minor, freight_minor, duty_minor, vat_minor, landed_minor,
               origin_currency_code, status)
            VALUES
              (${orderId}, ${manufacturerUser}, ${manufacturerId}, NULL, ${totalQty},
               ${fobMinor}, 0, 0, 0, ${fobMinor},
               'USD', 'placed')
            ON CONFLICT (id) DO NOTHING;`,
      );

      // Bring stock into bonded warehouse.
      const arrivedRes = await request(app)
        .post(`/api/admin/bonded-inventory/${orderId}/arrived`)
        .set("x-test-user-id", adminUser)
        .send({ warehouseCode: "LOS-BWH-01" });
      expect(arrivedRes.status).toBe(201);
      expect(arrivedRes.body.qtyOnHand).toBe(totalQty);

      // Re-prefix the bonded inventory row id so afterAll can sweep it.
      const prefixedBondedId = uniq("binv");
      await db.execute(
        sql`UPDATE bonded_warehouse_inventory SET id = ${prefixedBondedId} WHERE wholesale_order_id = ${orderId}`,
      );

      // ------- 1. Partial release (40 of 100). Order NOT yet delivered. -------
      const firstQty = 40;
      const partial1 = await request(app)
        .post(`/api/admin/bonded-inventory/${orderId}/released`)
        .set("x-test-user-id", adminUser)
        .send({ qty: firstQty });
      expect(partial1.status).toBe(200);
      expect(partial1.body.delivered).toBe(false);
      expect(partial1.body.payoutEnqueued).toBe(false);
      expect(partial1.body.qtyOnHand).toBe(totalQty - firstQty);
      expect(partial1.body.qtyReleased).toBe(firstQty);

      const [orderAfterPartial] = await db
        .select({ status: schema.wholesaleOrdersTable.status })
        .from(schema.wholesaleOrdersTable)
        .where(drizzleEq(schema.wholesaleOrdersTable.id, orderId))
        .limit(1);
      expect(orderAfterPartial.status).toBe("placed");

      const payoutsAfterPartial = await db
        .select({ id: schema.payoutsTable.id })
        .from(schema.payoutsTable)
        .where(
          drizzleAnd(
            drizzleEq(schema.payoutsTable.orderId, orderId),
            drizzleEq(schema.payoutsTable.kind, "manufacturer_share"),
          ),
        );
      expect(payoutsAfterPartial.length).toBe(0);

      // ------- 2. Over-release rejected with 400 and no state change. ----------
      const overflow = await request(app)
        .post(`/api/admin/bonded-inventory/${orderId}/released`)
        .set("x-test-user-id", adminUser)
        .send({ qty: totalQty }); // would exceed remaining on-hand
      expect(overflow.status).toBe(400);
      expect(overflow.body.error).toBe("qty_exceeds_on_hand");
      expect(overflow.body.qtyOnHand).toBe(totalQty - firstQty);

      // ------- 3. Release the remainder. Now delivered + payout enqueued. ----
      const remainder = totalQty - firstQty;
      const partial2 = await request(app)
        .post(`/api/admin/bonded-inventory/${orderId}/released`)
        .set("x-test-user-id", adminUser)
        .send({ qty: remainder });
      expect(partial2.status).toBe(200);
      expect(partial2.body.delivered).toBe(true);
      expect(partial2.body.payoutEnqueued).toBe(true);
      expect(partial2.body.qtyOnHand).toBe(0);
      expect(partial2.body.qtyReleased).toBe(totalQty);

      const [orderAfterFinal] = await db
        .select({ status: schema.wholesaleOrdersTable.status })
        .from(schema.wholesaleOrdersTable)
        .where(drizzleEq(schema.wholesaleOrdersTable.id, orderId))
        .limit(1);
      expect(orderAfterFinal.status).toBe("delivered");

      const payoutsAfterFinal = await db
        .select()
        .from(schema.payoutsTable)
        .where(
          drizzleAnd(
            drizzleEq(schema.payoutsTable.orderId, orderId),
            drizzleEq(schema.payoutsTable.kind, "manufacturer_share"),
          ),
        );
      expect(payoutsAfterFinal.length).toBe(1);
      expect(payoutsAfterFinal[0].status).toBe("pending");
      expect(payoutsAfterFinal[0].reference).toBe(`WO-${orderId}`);
      // 8% platform fee → manufacturer share = FOB * 0.92, rounded.
      const expectedPayout = fobMinor - Math.round(fobMinor * 0.08);
      expect(payoutsAfterFinal[0].amountMinor).toBe(expectedPayout);

      // ------- 4. Replaying the final release is a no-op. -------------------
      const replay = await request(app)
        .post(`/api/admin/bonded-inventory/${orderId}/released`)
        .set("x-test-user-id", adminUser)
        .send({}); // no qty supplied → release-all on a now-empty bucket.
      expect(replay.status).toBe(200);
      expect(replay.body.delivered).toBe(true);
      expect(replay.body.payoutEnqueued).toBe(false);

      const payoutsAfterReplay = await db
        .select({ id: schema.payoutsTable.id })
        .from(schema.payoutsTable)
        .where(
          drizzleAnd(
            drizzleEq(schema.payoutsTable.orderId, orderId),
            drizzleEq(schema.payoutsTable.kind, "manufacturer_share"),
          ),
        );
      expect(payoutsAfterReplay.length).toBe(1);
    },
    30_000,
  );
});
