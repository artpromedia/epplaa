import { describe, it, expect, beforeAll, afterEach } from "vitest";
import crypto from "node:crypto";

/**
 * Integration tests for the user-linked tables FK + RLS bootstrap (#226).
 *
 * Three things this needs to prove:
 *
 *   1. After `initUserLinkedTablesFkAndRls` runs, every table in
 *      USER_LINKED_TABLES has a real DB-level `user_id → users.clerk_id`
 *      FK — i.e. an INSERT with a bogus user_id is rejected with
 *      Postgres' standard 23503 (`foreign_key_violation`). Picks one
 *      table (`wishlist`) as the canonical proof so the test runtime
 *      doesn't balloon to N tables; the bootstrap is structurally
 *      identical for the rest.
 *
 *   2. RLS is enabled and the user-isolation policy is created for
 *      every table the bootstrap touches. The policy is permissive
 *      today (current_setting('app.current_user_id', true) IS NULL OR
 *      empty branch matches every row) so app code keeps working
 *      unchanged — we assert the policy exists, not that it filters.
 *
 *   3. The bootstrap is idempotent: a second call after the constraints
 *      and policies already exist reports zero work done and does NOT
 *      throw on the `pg_constraint` / `pg_policies` collision.
 *
 * Skips itself if DATABASE_URL is not configured. Cleans up its own
 * rows so it does not pollute shared dev data.
 */

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const TEST_PREFIX = "test-ult-";

function rid(): string {
  return TEST_PREFIX + crypto.randomBytes(6).toString("hex");
}

d("user-linked tables FK + RLS bootstrap", () => {
  type Db = typeof import("./db")["db"];
  type Sql = typeof import("drizzle-orm")["sql"];
  type UserLinked = typeof import("./userLinkedTablesFk");

  let db: Db;
  let sql: Sql;
  let userLinked: UserLinked;

  async function cleanup(): Promise<void> {
    await db.execute(
      sql`DELETE FROM wishlist WHERE user_id LIKE ${TEST_PREFIX + "%"};`,
    );
    await db.execute(
      sql`DELETE FROM users WHERE clerk_id LIKE ${TEST_PREFIX + "%"};`,
    );
  }

  beforeAll(async () => {
    db = (await import("./db")).db;
    sql = (await import("drizzle-orm")).sql;
    userLinked = await import("./userLinkedTablesFk");
    // Run the bootstrap so the FK + RLS are present even if no other
    // suite has triggered it yet.
    await userLinked.initUserLinkedTablesFkAndRls();
    await cleanup();
  }, 30_000);

  afterEach(async () => {
    await cleanup();
  });

  it("rejects an INSERT with an unknown user_id (FK enforced)", async () => {
    const orphanUserId = rid();
    let threw: Error | null = null;
    try {
      await db.execute(
        sql`INSERT INTO wishlist (user_id, product_id) VALUES (${orphanUserId}, 'test-product-doesnt-need-to-exist');`,
      );
    } catch (err) {
      threw = err as Error;
    }
    expect(threw).not.toBeNull();
    // Postgres FK violation surfaces as code 23503 in the error message
    // (drizzle wraps the underlying pg error). We assert the message
    // contains the constraint name we installed so the failure is
    // unambiguously the FK and not e.g. a missing column.
    const expectedConstraint = userLinked.fkConstraintName("wishlist", "user_id");
    expect(threw!.message).toContain(expectedConstraint);
  });

  it("accepts an INSERT when the user_id resolves to an existing users row", async () => {
    const userId = rid();
    await db.execute(
      sql`INSERT INTO users (clerk_id, email, display_name) VALUES (${userId}, ${userId + "@example.test"}, 'test wishlist user');`,
    );
    // No throw expected.
    await db.execute(
      sql`INSERT INTO wishlist (user_id, product_id) VALUES (${userId}, 'test-product-1');`,
    );
    const rows = await db.execute(
      sql`SELECT 1 FROM wishlist WHERE user_id = ${userId};`,
    );
    expect(((rows as { rows?: unknown[] }).rows ?? []).length).toBeGreaterThan(0);
  });

  it("enables RLS and installs the user-isolation policy on every table", async () => {
    // Pull the rls + policy state from the catalog and assert each
    // managed table has both. We let the test be authoritative about
    // the table list by reading USER_LINKED_TABLES from the module —
    // a future addition to that array is automatically covered.
    const tableNames = userLinked.USER_LINKED_TABLES.map((e) => e.table);

    // 1. Tables that don't exist at this commit (e.g. an addition
    //    that's been declared but not pushed yet) are skipped by the
    //    bootstrap; we filter them out here too so the assertion
    //    isn't tripped by a schema migration mid-flight.
    const existingRows = await db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY(${tableNames});
    `);
    const existing = new Set(
      ((existingRows as unknown as { rows?: Array<{ table_name: string }> }).rows ?? []).map(
        (r) => r.table_name,
      ),
    );
    const present = tableNames.filter((t) => existing.has(t));
    expect(present.length).toBeGreaterThan(0);

    // 2. RLS-enabled check via pg_class.relrowsecurity.
    const rlsRows = await db.execute(sql`
      SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relrowsecurity = true AND c.relname = ANY(${present});
    `);
    const rlsEnabled = new Set(
      ((rlsRows as unknown as { rows?: Array<{ table_name: string }> }).rows ?? []).map(
        (r) => r.table_name,
      ),
    );
    for (const t of present) {
      expect(rlsEnabled.has(t), `RLS not enabled on ${t}`).toBe(true);
    }

    // 3. Policy exists per table.
    const policyRows = await db.execute(sql`
      SELECT tablename, policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = ANY(${present});
    `);
    const policiesByTable = new Map<string, Set<string>>();
    for (const row of (policyRows as unknown as { rows?: Array<{ tablename: string; policyname: string }> })
      .rows ?? []) {
      if (!policiesByTable.has(row.tablename)) policiesByTable.set(row.tablename, new Set());
      policiesByTable.get(row.tablename)!.add(row.policyname);
    }
    for (const t of present) {
      const expected = userLinked.rlsPolicyName(t);
      expect(
        policiesByTable.get(t)?.has(expected),
        `policy ${expected} missing on ${t}`,
      ).toBe(true);
    }
  });

  it("is idempotent — re-running reports zero new work and does not throw", async () => {
    const second = await userLinked.initUserLinkedTablesFkAndRls();
    expect(second.placeholderUsersInserted).toBe(0);
    expect(second.fkConstraintsAdded).toEqual([]);
    expect(second.policiesCreated).toEqual([]);
    // rlsEnabled is reported on every table the bootstrap touches even
    // when ALTER TABLE … ENABLE ROW LEVEL SECURITY is a no-op (Postgres
    // has no IF NOT ENABLED variant), so we don't assert it shrinks.
    // The point of this test is "no exception thrown" + "FK / policy
    // adds report empty".
  });
});
