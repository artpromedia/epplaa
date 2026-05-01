import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";

/**
 * Regression test for #203 — a sanctions-flagged manufacturer must not
 * receive payouts.
 *
 * The wiring already lives in `manufacturerPayouts.ts`: the helper
 * consults `manufacturerSanctionsBlocked()` and lands the payout row in
 * `status: "blocked"` with `errorMessage: "sanctions_review_required"`.
 * This test pins down that the blocked branch is exercised end-to-end
 * against a real DB:
 *
 *   1. Seed a sanctions screening row with `status='blocked'` for the
 *      manufacturer's user.
 *   2. Drive `enqueueManufacturerPayoutForWholesaleOrder` against a
 *      seeded wholesale order.
 *   3. Assert the payout row was inserted with `status='blocked'` (i.e.
 *      it cannot be picked up by the daily-payouts cron) and that the
 *      `errorMessage` matches the sanctions-review marker the
 *      compliance dashboard filters on.
 *
 * Skips itself when DATABASE_URL is not set so the suite stays green
 * on local environments without Postgres.
 */

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const PREFIX = "test-mfg-payout-sanctions-";

function rid(label: string): string {
  return `${PREFIX}${label}-${crypto.randomBytes(4).toString("hex")}`;
}

d("manufacturerPayouts — sanctions-flagged manufacturer is paid into status=blocked", () => {
  type Db = typeof import("./db")["db"];
  type Schema = typeof import("./db")["schema"];
  type Sql = typeof import("drizzle-orm")["sql"];
  type Payouts = typeof import("./manufacturerPayouts");

  let db: Db;
  let schema: Schema;
  let sql: Sql;
  let payouts: Payouts;
  let drizzleEq: typeof import("drizzle-orm")["eq"];
  let drizzleAnd: typeof import("drizzle-orm")["and"];

  beforeAll(async () => {
    if (!hasDb) return;
    const dbModule = await import("./db");
    db = dbModule.db;
    schema = dbModule.schema;
    const drizzle = await import("drizzle-orm");
    sql = drizzle.sql;
    drizzleEq = drizzle.eq;
    drizzleAnd = drizzle.and;
    const audit = await import("./audit");
    const manufacturers = await import("./manufacturers");
    await audit.initAuditChain();
    await manufacturers.initManufacturerSchema();
    payouts = await import("./manufacturerPayouts");
  });

  afterAll(async () => {
    if (!hasDb) return;
    await db.execute(
      sql`DELETE FROM payouts WHERE order_id LIKE ${PREFIX + "%"} OR reference LIKE ${"WO-" + PREFIX + "%"}`,
    );
    await db.execute(
      sql`DELETE FROM wholesale_orders WHERE id LIKE ${PREFIX + "%"}`,
    );
    await db.execute(
      sql`DELETE FROM manufacturer_listings WHERE id LIKE ${PREFIX + "%"}`,
    );
    await db.execute(
      sql`DELETE FROM manufacturers WHERE id LIKE ${PREFIX + "%"}`,
    );
    await db.execute(
      sql`DELETE FROM sanctions_screenings WHERE user_id LIKE ${PREFIX + "%"}`,
    );
    await db.execute(
      sql`DELETE FROM users WHERE clerk_id LIKE ${PREFIX + "%"}`,
    );
  });

  it(
    "writes a payout row in status=blocked when the manufacturer is on a sanctions list",
    async () => {
      const manufacturerUserId = rid("mfg-user");
      const manufacturerId = rid("mfg");
      const orderId = rid("wo");

      await db
        .insert(schema.usersTable)
        .values({
          clerkId: manufacturerUserId,
          email: `${manufacturerUserId}@example.com`,
          displayName: "Sanctioned Manufacturer",
          countryCode: "KP",
        })
        .onConflictDoNothing();

      // Seed the manufacturer + an approved listing so the FK chain is intact.
      await db.execute(
        sql`INSERT INTO manufacturers (id, user_id, legal_name, registered_country, origin_country, status)
            VALUES (${manufacturerId}, ${manufacturerUserId}, 'Blocked Co', 'KP', 'KP', 'approved')
            ON CONFLICT (id) DO NOTHING;`,
      );

      // Pre-seed a *blocked* sanctions screening so
      // `manufacturerSanctionsBlocked()` short-circuits to true without
      // touching the live provider stub.
      await db.insert(schema.sanctionsScreeningsTable).values({
        id: rid("scr"),
        userId: manufacturerUserId,
        subjectKind: "manufacturer",
        provider: "stub",
        subjectName: "Blocked Co",
        subjectCountry: "KP",
        matchScore: 100,
        listHits: [
          { listName: "OFAC-SDN-STUB", entryName: "Blocked Co", score: 100 },
        ],
        status: "blocked",
        nextReviewAt: new Date(Date.now() + 90 * 24 * 3600 * 1000),
      });

      // Minimal wholesale_orders row — only the columns the payout
      // helper reads. Use raw SQL to sidestep ORM nullability defaults
      // we do not exercise here.
      await db.execute(
        sql`INSERT INTO wholesale_orders
              (id, seller_user_id, manufacturer_id, listing_id, qty,
               fob_minor, freight_minor, duty_minor, vat_minor, landed_minor,
               origin_currency_code, status)
            VALUES
              (${orderId}, ${manufacturerUserId}, ${manufacturerId}, NULL, 100,
               1000000, 0, 0, 0, 1000000,
               'USD', 'placed')
            ON CONFLICT (id) DO NOTHING;`,
      );

      const enqueued =
        await payouts.enqueueManufacturerPayoutForWholesaleOrder(orderId);
      expect(enqueued).toBe(true);

      const rows = await db
        .select()
        .from(schema.payoutsTable)
        .where(
          drizzleAnd(
            drizzleEq(schema.payoutsTable.orderId, orderId),
            drizzleEq(schema.payoutsTable.kind, "manufacturer_share"),
          ),
        );
      expect(rows.length).toBe(1);
      const payout = rows[0];
      expect(payout.status).toBe("blocked");
      expect(payout.errorMessage).toBe("sanctions_review_required");
      expect(payout.userId).toBe(manufacturerUserId);
      // The platform commission is still computed; the row is held in
      // `blocked` so the cron skips it. Lifting the sanctions flag is
      // an explicit admin action — do NOT auto-release.
      expect(payout.amountMinor).toBeGreaterThan(0);
      expect(payout.currencyCode).toBe("USD");
    },
  );

  it(
    "does NOT auto-release a previously-blocked payout when the sanctions row is later lifted",
    async () => {
      const manufacturerUserId = rid("mfg-user-relift");
      const manufacturerId = rid("mfg-relift");
      const orderId = rid("wo-relift");

      await db
        .insert(schema.usersTable)
        .values({
          clerkId: manufacturerUserId,
          email: `${manufacturerUserId}@example.com`,
          displayName: "Re-Lift Manufacturer",
          countryCode: "CN",
        })
        .onConflictDoNothing();

      await db.execute(
        sql`INSERT INTO manufacturers (id, user_id, legal_name, registered_country, origin_country, status)
            VALUES (${manufacturerId}, ${manufacturerUserId}, 'Re-Lift Co', 'CN', 'CN', 'approved')
            ON CONFLICT (id) DO NOTHING;`,
      );

      await db.insert(schema.sanctionsScreeningsTable).values({
        id: rid("scr-blocked"),
        userId: manufacturerUserId,
        subjectKind: "manufacturer",
        provider: "stub",
        subjectName: "Re-Lift Co",
        subjectCountry: "CN",
        matchScore: 100,
        listHits: [{ listName: "STUB", entryName: "Re-Lift Co", score: 100 }],
        status: "blocked",
        nextReviewAt: new Date(Date.now() + 90 * 24 * 3600 * 1000),
      });

      await db.execute(
        sql`INSERT INTO wholesale_orders
              (id, seller_user_id, manufacturer_id, listing_id, qty,
               fob_minor, freight_minor, duty_minor, vat_minor, landed_minor,
               origin_currency_code, status)
            VALUES
              (${orderId}, ${manufacturerUserId}, ${manufacturerId}, NULL, 100,
               2000000, 0, 0, 0, 2000000,
               'USD', 'placed')
            ON CONFLICT (id) DO NOTHING;`,
      );

      const enqueued =
        await payouts.enqueueManufacturerPayoutForWholesaleOrder(orderId);
      expect(enqueued).toBe(true);

      // Simulate compliance lifting the sanctions flag AFTER the payout
      // landed in `blocked`. This is the audit-trail-critical case: the
      // existing payout row must NOT silently flip to `pending` just
      // because a screening was re-cleared.
      await db
        .update(schema.sanctionsScreeningsTable)
        .set({ status: "clear" })
        .where(drizzleEq(schema.sanctionsScreeningsTable.userId, manufacturerUserId));

      const rows = await db
        .select()
        .from(schema.payoutsTable)
        .where(
          drizzleAnd(
            drizzleEq(schema.payoutsTable.orderId, orderId),
            drizzleEq(schema.payoutsTable.kind, "manufacturer_share"),
          ),
        );
      expect(rows.length).toBe(1);
      expect(rows[0].status).toBe("blocked");
      expect(rows[0].errorMessage).toBe("sanctions_review_required");

      // Re-running the enqueue helper is also a no-op (idempotency by
      // reference). It must not "fix" the blocked row.
      const second =
        await payouts.enqueueManufacturerPayoutForWholesaleOrder(orderId);
      expect(second).toBe(false);

      const rowsAfter = await db
        .select({ id: schema.payoutsTable.id, status: schema.payoutsTable.status })
        .from(schema.payoutsTable)
        .where(
          drizzleAnd(
            drizzleEq(schema.payoutsTable.orderId, orderId),
            drizzleEq(schema.payoutsTable.kind, "manufacturer_share"),
          ),
        );
      expect(rowsAfter.length).toBe(1);
      expect(rowsAfter[0].status).toBe("blocked");
    },
  );
});
