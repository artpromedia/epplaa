import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import crypto from "node:crypto";
import express, { type Express } from "express";
import request from "supertest";

/**
 * HTTP-level integration test for `POST /api/recently-viewed/:productId`.
 *
 * The For-You recommender (lib/recommender.ts) blends two signals that
 * both depend on this endpoint:
 *   - +15 "viewed-category" boost from the `recently_viewed` table
 *   - up to +5 popularity from `products.view_count`
 *
 * Without an endpoint that writes to both tables, the personalised rails
 * silently degrade to popularity + country only and the +15 category
 * boost is dead. This test pins the contract that:
 *   1. The first call from a user upserts a `recently_viewed` row AND
 *      increments the underlying `products.view_count` by exactly 1.
 *   2. A repeat call from the same user only refreshes `viewed_at` and
 *      does NOT inflate `view_count` (so reload-spam can't game popularity).
 *   3. Unauthenticated requests return 401 without touching either table.
 *
 * Skips when DATABASE_URL is missing so local environments without a
 * Postgres still pass. Cleans up its own rows so it does not pollute
 * shared dev data.
 */

vi.mock("@clerk/express", () => ({
  getAuth: (req: { headers: Record<string, string | string[] | undefined> }) => {
    const raw = req.headers["x-test-user-id"];
    const userId = typeof raw === "string" && raw.length > 0 ? raw : null;
    return { userId };
  },
}));

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const TEST_USER_PREFIX = "test-recently-viewed-";
const TEST_PRODUCT_ID = "test-recently-viewed-product";

d("POST /api/recently-viewed/:productId", () => {
  type Db = typeof import("../lib/db")["db"];
  type Sql = typeof import("drizzle-orm")["sql"];
  type DiscoveryRouter = typeof import("./discovery")["default"];

  let db: Db;
  let sql: Sql;
  let discoveryRouter: DiscoveryRouter;

  function makeUserId(): string {
    return `${TEST_USER_PREFIX}${crypto.randomBytes(8).toString("hex")}`;
  }

  function buildApp(): Express {
    const app = express();
    app.use(express.json());
    app.use("/api", discoveryRouter);
    return app;
  }

  async function readViewCount(productId: string): Promise<number> {
    const rows = await db.execute<{ view_count: number }>(
      sql`SELECT view_count FROM products WHERE id = ${productId}`,
    );
    return Number(rows.rows[0]?.view_count ?? 0);
  }

  async function cleanup(): Promise<void> {
    await db.execute(
      sql`DELETE FROM recently_viewed WHERE user_id LIKE ${TEST_USER_PREFIX + "%"}`,
    );
    await db.execute(sql`DELETE FROM products WHERE id = ${TEST_PRODUCT_ID}`);
  }

  beforeAll(async () => {
    ({ db } = await import("../lib/db"));
    ({ sql } = await import("drizzle-orm"));
    discoveryRouter = (await import("./discovery")).default;
    await cleanup();
    // Seed a dedicated product so the increment target is deterministic and
    // we never disturb the shared `prod-*` seed rows other tests may read.
    await db.execute(sql`
      INSERT INTO products (id, title, price_minor, origin_country, origin_label, seller_name, view_count)
      VALUES (${TEST_PRODUCT_ID}, 'Recently Viewed Test Product', 1000, 'NG', 'Made in Lagos', 'Test Seller', 0)
    `);
  }, 30_000);

  afterAll(async () => {
    await cleanup();
  });

  it("returns 401 and does not touch view_count when unauthenticated", async () => {
    const before = await readViewCount(TEST_PRODUCT_ID);
    const r = await request(buildApp()).post(`/api/recently-viewed/${TEST_PRODUCT_ID}`);
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("unauthorized");
    const after = await readViewCount(TEST_PRODUCT_ID);
    expect(after).toBe(before);
  });

  it("inserts the row and increments products.view_count on first view", async () => {
    const userId = makeUserId();
    const before = await readViewCount(TEST_PRODUCT_ID);
    const r = await request(buildApp())
      .post(`/api/recently-viewed/${TEST_PRODUCT_ID}`)
      .set("x-test-user-id", userId);
    expect(r.status).toBe(200);
    expect(r.body).toContain(TEST_PRODUCT_ID);
    const after = await readViewCount(TEST_PRODUCT_ID);
    expect(after).toBe(before + 1);
  });

  it("does not inflate view_count on repeat views from the same user", async () => {
    const userId = makeUserId();
    // First view: counts.
    await request(buildApp())
      .post(`/api/recently-viewed/${TEST_PRODUCT_ID}`)
      .set("x-test-user-id", userId);
    const afterFirst = await readViewCount(TEST_PRODUCT_ID);
    // Three reload-style follow-up views from the same user must not move
    // the popularity counter — only refresh the recency timestamp.
    for (let i = 0; i < 3; i++) {
      const r = await request(buildApp())
        .post(`/api/recently-viewed/${TEST_PRODUCT_ID}`)
        .set("x-test-user-id", userId);
      expect(r.status).toBe(200);
    }
    const afterRepeats = await readViewCount(TEST_PRODUCT_ID);
    expect(afterRepeats).toBe(afterFirst);
  });

  it("counts each distinct user once, so two users yield +2", async () => {
    const userA = makeUserId();
    const userB = makeUserId();
    const before = await readViewCount(TEST_PRODUCT_ID);
    await request(buildApp())
      .post(`/api/recently-viewed/${TEST_PRODUCT_ID}`)
      .set("x-test-user-id", userA);
    await request(buildApp())
      .post(`/api/recently-viewed/${TEST_PRODUCT_ID}`)
      .set("x-test-user-id", userB);
    const after = await readViewCount(TEST_PRODUCT_ID);
    expect(after).toBe(before + 2);
  });
});
