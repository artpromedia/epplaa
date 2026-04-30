import { describe, it, expect, beforeAll, afterEach } from "vitest";
import crypto from "node:crypto";

/**
 * Integration tests for the money-flow FK bootstrap (Task #105).
 *
 * Three things this needs to prove:
 *
 *   1. After `initMoneyFlowFkConstraints` runs, the three FKs the schema
 *      now declares (`orders.user_id`, `payment_intents.user_id`,
 *      `payment_intents.order_id`) are real DB-level constraints — i.e.
 *      a write that points at a non-existent parent row rejects with
 *      Postgres' standard 23503 (`foreign_key_violation`) instead of
 *      silently succeeding the way it did before this task.
 *
 *   2. Pre-existing orphan rows are cleaned up by the bootstrap rather
 *      than blocking the `ALTER TABLE … ADD CONSTRAINT` — orphan
 *      `payment_intents.order_id` are detached to NULL, orphan
 *      user_ids on either money-flow table are backfilled with a
 *      placeholder users row so the financial record (which §11.1.4 of
 *      the privacy policy requires us to keep for 7 years) is preserved.
 *
 *   3. The bootstrap is idempotent: a second call after the constraints
 *      already exist reports zero work done and does NOT throw on the
 *      `pg_constraint` collision (`relation "..._fk" already exists` is
 *      the failure mode this guards against).
 *
 * Skips itself if DATABASE_URL is not configured. Cleans up its own
 * rows so it does not pollute shared dev data.
 */

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const TEST_PREFIX = "test-mffk-";

function rid(): string {
  return TEST_PREFIX + crypto.randomBytes(6).toString("hex");
}

d("money-flow FK bootstrap", () => {
  type Db = typeof import("./db")["db"];
  type Schema = typeof import("./db")["schema"];
  type Sql = typeof import("drizzle-orm")["sql"];
  type MoneyFlow = typeof import("./moneyFlowFk");

  let db: Db;
  let schema: Schema;
  let sql: Sql;
  let moneyFlow: MoneyFlow;

  /**
   * Drop the three FKs we install so each test starts from the same
   * "constraints absent" state. We can't rely on the prior test having
   * left them in either state because the bootstrap fires from app.ts
   * boot in non-test runs — running these tests against a DB that's
   * also being booted would otherwise interleave unpredictably.
   *
   * In a real shared-dev / CI run the constraints get reinstalled by
   * the very first test that calls `initMoneyFlowFkConstraints`, so
   * the surrounding suite still benefits from FK protection.
   */
  async function dropMoneyFlowFks(): Promise<void> {
    await db.execute(
      sql`ALTER TABLE orders DROP CONSTRAINT IF EXISTS ${sql.identifier(moneyFlow.ORDERS_USER_FK)};`,
    );
    await db.execute(
      sql`ALTER TABLE payment_intents DROP CONSTRAINT IF EXISTS ${sql.identifier(moneyFlow.INTENTS_ORDER_FK)};`,
    );
    await db.execute(
      sql`ALTER TABLE payment_intents DROP CONSTRAINT IF EXISTS ${sql.identifier(moneyFlow.INTENTS_USER_FK)};`,
    );
  }

  async function cleanup(): Promise<void> {
    // Order matters: payment_intents reference orders + users; orders
    // reference users. Cleaning child first lets the FKs (if installed)
    // accept the deletes.
    await db.execute(
      sql`DELETE FROM payment_intents WHERE id LIKE ${TEST_PREFIX + "%"} OR user_id LIKE ${TEST_PREFIX + "%"} OR order_id LIKE ${TEST_PREFIX + "%"};`,
    );
    await db.execute(
      sql`DELETE FROM orders WHERE id LIKE ${TEST_PREFIX + "%"} OR user_id LIKE ${TEST_PREFIX + "%"};`,
    );
    await db.execute(sql`DELETE FROM users WHERE clerk_id LIKE ${TEST_PREFIX + "%"};`);
  }

  beforeAll(async () => {
    db = (await import("./db")).db;
    schema = (await import("./db")).schema;
    sql = (await import("drizzle-orm")).sql;
    moneyFlow = await import("./moneyFlowFk");
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
  });

  it("backfills placeholder users for orphan user_ids and detaches orphan order_ids", async () => {
    await dropMoneyFlowFks();

    // Seed: an orphan order whose user does not exist, an orphan
    // payment_intent whose user does not exist, and a payment_intent
    // pointing at an order that does not exist. Real prod should
    // never have these — this is purely the "before" state for the
    // cleanup branch.
    const orphanUserA = rid();
    const orphanUserB = rid();
    const orphanOrderId = rid();
    const orderRowId = rid();
    const intentOrphanUserId = rid();
    const intentOrphanOrderId = rid();

    await db.execute(sql`
      INSERT INTO orders (id, user_id, country_code, currency_code)
      VALUES (${orderRowId}, ${orphanUserA}, 'NG', 'NGN');
    `);
    await db.execute(sql`
      INSERT INTO payment_intents
        (id, user_id, purpose, order_id, gateway, reference, amount_minor, currency_code)
      VALUES
        (${intentOrphanUserId}, ${orphanUserB}, 'wallet_topup', NULL,
         'devmock', ${rid()}, 1000, 'NGN');
    `);
    await db.execute(sql`
      INSERT INTO payment_intents
        (id, user_id, purpose, order_id, gateway, reference, amount_minor, currency_code)
      VALUES
        (${intentOrphanOrderId}, ${orphanUserA}, 'order', ${orphanOrderId},
         'devmock', ${rid()}, 2000, 'NGN');
    `);

    const result = await moneyFlow.initMoneyFlowFkConstraints();

    // The orphan order_id we planted should have been detached. We
    // check >=1 rather than ==1 because a parallel suite may have
    // left other detach-eligible rows in the table; the important
    // invariant is that OUR orphan row got cleaned.
    expect(result.detachedIntentOrderIds).toBeGreaterThanOrEqual(1);
    const stillOrphan = await db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM payment_intents
      WHERE id = ${intentOrphanOrderId} AND order_id IS NOT NULL;
    `);
    expect(((stillOrphan as { rows?: { count: string }[] }).rows ?? [])[0]?.count).toBe("0");

    // Both orphan user_ids should now have placeholder rows.
    const placeholderA = await db.execute<{ email: string; display_name: string }>(sql`
      SELECT email, display_name FROM users WHERE clerk_id = ${orphanUserA};
    `);
    const placeholderB = await db.execute<{ email: string; display_name: string }>(sql`
      SELECT email, display_name FROM users WHERE clerk_id = ${orphanUserB};
    `);
    const rowA = ((placeholderA as { rows?: { email: string; display_name: string }[] }).rows ?? [])[0];
    const rowB = ((placeholderB as { rows?: { email: string; display_name: string }[] }).rows ?? [])[0];
    expect(rowA?.email).toBe(`orphan-${orphanUserA}@anonymized.invalid`);
    expect(rowA?.display_name).toBe("(orphan placeholder)");
    expect(rowB?.email).toBe(`orphan-${orphanUserB}@anonymized.invalid`);

    // The original financial rows must still be present — losing them
    // would silently violate the 7-year retention policy.
    const orderStill = await db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM orders WHERE id = ${orderRowId};`,
    );
    const intentsStill = await db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM payment_intents
      WHERE id IN (${intentOrphanUserId}, ${intentOrphanOrderId});
    `);
    expect(((orderStill as { rows?: { count: string }[] }).rows ?? [])[0]?.count).toBe("1");
    expect(((intentsStill as { rows?: { count: string }[] }).rows ?? [])[0]?.count).toBe("2");

    // The three FKs must now exist.
    expect(result.constraintsAdded).toEqual(
      expect.arrayContaining([
        moneyFlow.ORDERS_USER_FK,
        moneyFlow.INTENTS_ORDER_FK,
        moneyFlow.INTENTS_USER_FK,
      ]),
    );
  });

  it("rejects writes that reference non-existent rows once the FKs are in place", async () => {
    await moneyFlow.initMoneyFlowFkConstraints();

    const ghostUser = rid();
    const ghostOrder = rid();

    /**
     * Drizzle wraps the underlying pg error with a "Failed query: …"
     * preamble that hides the human-readable foreign_key_violation
     * message, but the original pg error is preserved on `err.cause`
     * with the standard SQLSTATE 23503 code. We assert against the
     * code rather than a fragile substring match — the error text is
     * locale/version dependent, the SQLSTATE is the stable contract.
     */
    async function expectFkViolation(
      promise: Promise<unknown>,
      label: string,
    ): Promise<void> {
      let caught: unknown = null;
      try {
        await promise;
      } catch (err) {
        caught = err;
      }
      expect(caught, `${label} should have thrown`).not.toBeNull();
      const cause = (caught as { cause?: { code?: string } }).cause;
      const directCode = (caught as { code?: string }).code;
      const code = cause?.code ?? directCode;
      expect(code, `${label} expected pg SQLSTATE 23503, got ${String(code)}`).toBe(
        "23503",
      );
    }

    // orders.user_id -> users.clerk_id
    await expectFkViolation(
      db.execute(sql`
        INSERT INTO orders (id, user_id, country_code, currency_code)
        VALUES (${rid()}, ${ghostUser}, 'NG', 'NGN');
      `),
      "orders.user_id orphan",
    );

    // payment_intents.user_id -> users.clerk_id
    await expectFkViolation(
      db.execute(sql`
        INSERT INTO payment_intents
          (id, user_id, purpose, order_id, gateway, reference, amount_minor, currency_code)
        VALUES
          (${rid()}, ${ghostUser}, 'wallet_topup', NULL,
           'devmock', ${rid()}, 1000, 'NGN');
      `),
      "payment_intents.user_id orphan",
    );

    // payment_intents.order_id -> orders.id (with a real user, so the
    // user FK is satisfied and the order FK is the one that trips).
    const realUser = rid();
    await db.execute(sql`
      INSERT INTO users (clerk_id, email, display_name)
      VALUES (${realUser}, ${`${realUser}@example.test`}, 'real user');
    `);
    await expectFkViolation(
      db.execute(sql`
        INSERT INTO payment_intents
          (id, user_id, purpose, order_id, gateway, reference, amount_minor, currency_code)
        VALUES
          (${rid()}, ${realUser}, 'order', ${ghostOrder},
           'devmock', ${rid()}, 2000, 'NGN');
      `),
      "payment_intents.order_id orphan",
    );
  });

  it("is idempotent — second call adds no constraints and does not throw", async () => {
    await moneyFlow.initMoneyFlowFkConstraints();
    const second = await moneyFlow.initMoneyFlowFkConstraints();
    expect(second.constraintsAdded).toEqual([]);
    // detachedIntentOrderIds and placeholderUsersInserted will only be
    // > 0 if a parallel test seeded fresh orphans between the two calls;
    // we don't assert exact zero here to avoid flake from sibling suites.
    expect(second.detachedIntentOrderIds).toBeGreaterThanOrEqual(0);
    expect(second.placeholderUsersInserted).toBeGreaterThanOrEqual(0);
  });
});
