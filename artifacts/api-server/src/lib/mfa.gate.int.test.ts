import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import express, { type Express } from "express";
import request from "supertest";

/**
 * Integration tests for the high-value MFA gate.
 *
 * Two surfaces are exercised end-to-end against a real Postgres:
 *
 * 1. `thirtyDayVelocityNgnMinor` — the rolling 30d NGN payout velocity
 *    used as the trigger for `requireMfa()`. The query has historically
 *    been the single point where a regression silently weakens the gate
 *    (wrong column, missing status filter, currency typo). We seed
 *    payouts that span every relevant axis (status, currency, kind, age,
 *    user_id vs seller_id) and assert the sum exactly equals the rows
 *    that legitimately count.
 *
 * 2. `requireMfa()` middleware — the actual gate that blocks payout
 *    mutations when a seller crosses the velocity threshold. We mount
 *    it on a one-handler Express app, mock Clerk's `getAuth` so the
 *    test can pick the calling user via a header, and walk through the
 *    full decision tree (low velocity, high velocity unenrolled, high
 *    velocity enrolled but stale, high velocity enrolled + recent
 *    assertion, admin override, anonymous). If any branch starts
 *    leaking through silently this test will catch it before a real
 *    seller does.
 *
 * Skips itself when DATABASE_URL is not set so it does not break local
 * environments without a Postgres. Cleans up its own rows so it does
 * not pollute shared dev data.
 */

// Hoisted Clerk mock — the factory runs before any module that imports
// `@clerk/express` is evaluated, so `lib/auth.ts` (and through it the
// `requireMfa` middleware) sees this stub instead of the real Clerk SDK.
// `getAuth` reads the calling user from the `x-test-user-id` header,
// which lets each test pick the identity for the request without
// rebuilding the app or fiddling with module-level state.
vi.mock("@clerk/express", () => ({
  getAuth: (req: { headers: Record<string, string | string[] | undefined> }) => {
    const raw = req.headers["x-test-user-id"];
    const userId = typeof raw === "string" && raw.length > 0 ? raw : null;
    return { userId };
  },
}));

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const TEST_USER_PREFIX = "test-mfa-gate-";
const HIGH_THRESHOLD_NGN_MINOR = 1_000_000_00; // 1,000,000 NGN in kobo

d("mfa high-value gate", () => {
  type Db = typeof import("./db")["db"];
  type Sql = typeof import("drizzle-orm")["sql"];
  type Authenticator = typeof import("otplib")["authenticator"];
  type Mfa = typeof import("./mfa");
  type Security = typeof import("./security");
  type MfaRoutes = typeof import("../routes/mfa");

  let db: Db;
  let sql: Sql;
  let authenticator: Authenticator;
  let mfa: Mfa;
  let requireMfa: MfaRoutes["requireMfa"];

  function makeUserId(): string {
    return `${TEST_USER_PREFIX}${crypto.randomBytes(8).toString("hex")}`;
  }

  /**
   * Insert a payout row directly. We bypass the application insert path
   * because we deliberately want to fabricate cross-axis combinations
   * (failed/cancelled rows, foreign currency, stale dates) that the
   * happy-path code would never produce.
   */
  interface SeedPayout {
    userId: string;
    sellerId?: string | null;
    amountMinor: number;
    status?: string;
    currencyCode?: string;
    kind?: string;
    requestedAtSqlExpr?: string; // raw SQL expression for requested_at
    orderId?: string | null;
  }
  async function seedPayout(p: SeedPayout): Promise<void> {
    const id = `pay_${crypto.randomBytes(8).toString("hex")}`;
    const status = p.status ?? "paid";
    const currency = p.currencyCode ?? "NGN";
    const kind = p.kind ?? "seller_share";
    const requestedAt = p.requestedAtSqlExpr ?? "now()";
    const sellerId = p.sellerId === undefined ? p.userId : p.sellerId;
    // Use raw SQL so we can drop in arbitrary date arithmetic for `requested_at`.
    await db.execute(sql.raw(`
      INSERT INTO payouts (id, user_id, seller_id, order_id, amount_minor,
                           currency_code, status, kind, requested_at)
      VALUES ('${id}', '${p.userId}', ${sellerId === null ? "NULL" : `'${sellerId}'`},
              ${p.orderId === undefined || p.orderId === null ? "NULL" : `'${p.orderId}'`},
              ${p.amountMinor}, '${currency}', '${status}', '${kind}', ${requestedAt});
    `));
  }

  async function cleanup(): Promise<void> {
    await db.execute(
      sql`DELETE FROM payouts WHERE user_id LIKE ${TEST_USER_PREFIX + "%"} OR seller_id LIKE ${TEST_USER_PREFIX + "%"};`,
    );
    await db.execute(
      sql`DELETE FROM mfa_enrollments WHERE user_id LIKE ${TEST_USER_PREFIX + "%"};`,
    );
    await db.execute(
      sql`DELETE FROM mfa_challenges WHERE user_id LIKE ${TEST_USER_PREFIX + "%"};`,
    );
    await db.execute(
      sql`DELETE FROM user_roles WHERE user_id LIKE ${TEST_USER_PREFIX + "%"};`,
    );
  }

  beforeAll(async () => {
    if (!process.env.MFA_ENCRYPTION_KEY) {
      process.env.MFA_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
    }
    if (!process.env.MFA_BACKUP_PEPPER) {
      process.env.MFA_BACKUP_PEPPER = crypto.randomBytes(32).toString("hex");
    }
    ({ db } = await import("./db"));
    ({ sql } = await import("drizzle-orm"));
    ({ authenticator } = await import("otplib"));
    mfa = await import("./mfa");
    const security: Security = await import("./security");
    await security.initSecuritySchema();
    // The admin override test reads from `roles` / `user_roles`. Boot
    // normally seeds those via `initAdminSchema()` from app.ts, which
    // does not run inside vitest, so call it here so the suite is
    // self-contained on a clean / ephemeral DB.
    const roles = await import("./roles");
    await roles.initAdminSchema();
    ({ requireMfa } = await import("../routes/mfa"));
    await cleanup();
  }, 30_000);

  afterEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
  });

  describe("thirtyDayVelocityNgnMinor", () => {
    it("returns 0 when the seller has no payouts", async () => {
      const userId = makeUserId();
      const total = await mfa.thirtyDayVelocityNgnMinor(userId);
      expect(total).toBe(0);
    });

    it("sums only paid+processing NGN payouts within the last 30 days", async () => {
      const userId = makeUserId();

      // Counted: 600k NGN paid + 250k NGN processing seller_share +
      // 150k NGN paid manufacturer_share = 1_000_000 NGN minor units.
      await seedPayout({ userId, amountMinor: 600_000_00, status: "paid" });
      await seedPayout({ userId, amountMinor: 250_000_00, status: "processing" });
      await seedPayout({
        userId,
        amountMinor: 150_000_00,
        status: "paid",
        kind: "manufacturer_share",
      });

      // Excluded: pending / scheduled / failed / cancelled / blocked
      // statuses do not represent money already moving to the seller.
      for (const status of ["pending", "scheduled", "failed", "cancelled", "blocked"]) {
        await seedPayout({ userId, amountMinor: 999_999_00, status });
      }

      // Excluded: foreign-currency payouts (the gate is NGN-denominated;
      // a USD payout's `amount_minor` is cents, not kobo, and would
      // otherwise massively over-count).
      await seedPayout({
        userId,
        amountMinor: 5_000_00,
        status: "paid",
        currencyCode: "USD",
      });
      await seedPayout({
        userId,
        amountMinor: 5_000_00,
        status: "paid",
        currencyCode: "EUR",
      });

      // Excluded: payouts older than 30 days fall outside the rolling window.
      await seedPayout({
        userId,
        amountMinor: 999_999_00,
        status: "paid",
        requestedAtSqlExpr: "now() - interval '31 days'",
      });
      await seedPayout({
        userId,
        amountMinor: 999_999_00,
        status: "paid",
        requestedAtSqlExpr: "now() - interval '90 days'",
      });

      // Excluded: a payout belonging to a totally different seller must
      // not bleed into this user's velocity even if both are NGN+paid.
      await seedPayout({ userId: makeUserId(), amountMinor: 999_999_00 });

      const total = await mfa.thirtyDayVelocityNgnMinor(userId);
      expect(total).toBe(1_000_000_00);
    });

    it("counts payouts where the user appears as seller_id even if user_id differs", async () => {
      // Wallet/manufacturer payouts can be booked under a system user_id
      // while seller_id points at the real seller. The gate must follow
      // either column or sellers could split rows to dodge the threshold.
      const sellerId = makeUserId();
      const bookkeepingUserId = makeUserId();
      await seedPayout({
        userId: bookkeepingUserId,
        sellerId,
        amountMinor: 750_000_00,
        status: "paid",
      });
      const total = await mfa.thirtyDayVelocityNgnMinor(sellerId);
      expect(total).toBe(750_000_00);
    });

    it("includes a payout right at the 30-day boundary (rolling, not calendar)", async () => {
      const userId = makeUserId();
      await seedPayout({
        userId,
        amountMinor: 400_000_00,
        status: "paid",
        // 29 days, 23 hours ago — inside the window.
        requestedAtSqlExpr: "now() - interval '29 days 23 hours'",
      });
      const total = await mfa.thirtyDayVelocityNgnMinor(userId);
      expect(total).toBe(400_000_00);
    });
  });

  describe("requireMfa() middleware", () => {
    function buildApp(): Express {
      const app = express();
      app.use(express.json());
      app.post("/api/protected", requireMfa(), (_req, res) => {
        res.json({ ok: true });
      });
      return app;
    }

    /**
     * Enrol the user in TOTP and (optionally) record a recent assertion.
     * Returns the plaintext secret so the test can mint a code if needed.
     */
    async function enrollUser(
      userId: string,
      opts: { recentlyAsserted: boolean },
    ): Promise<{ secret: string }> {
      const setup = await mfa.setupTotp(userId, `${userId}@example.com`);
      // verifyTotpAndActivate flips status to active. It also records
      // a challenge as a side effect, which we strip when we want the
      // "enrolled but stale" case.
      authenticator.options = { window: 1, step: 30 };
      const code = authenticator.generate(setup.secret);
      const ok = await mfa.verifyTotpAndActivate(userId, code);
      expect(ok).toBe(true);
      if (!opts.recentlyAsserted) {
        await db.execute(sql`DELETE FROM mfa_challenges WHERE user_id = ${userId};`);
      }
      return { secret: setup.secret };
    }

    it("returns 401 when the request has no authenticated user", async () => {
      const r = await request(buildApp()).post("/api/protected").send({});
      expect(r.status).toBe(401);
      expect(r.body.error).toBe("unauthorized");
    });

    it("passes through low-velocity sellers without an MFA enrolment", async () => {
      const userId = makeUserId();
      // Half the threshold — well below the gate.
      await seedPayout({ userId, amountMinor: 500_000_00, status: "paid" });

      const r = await request(buildApp())
        .post("/api/protected")
        .set("x-test-user-id", userId)
        .send({});
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true });
    });

    it("returns 403 mfa_required when a high-velocity seller has no MFA enrolment", async () => {
      const userId = makeUserId();
      // Two payouts that sum to exactly the threshold — boundary is
      // inclusive (`>= 1_000_000_00`).
      await seedPayout({ userId, amountMinor: 600_000_00, status: "paid" });
      await seedPayout({ userId, amountMinor: 400_000_00, status: "processing" });

      const r = await request(buildApp())
        .post("/api/protected")
        .set("x-test-user-id", userId)
        .send({});
      expect(r.status).toBe(403);
      expect(r.body.error).toBe("mfa_required");
    });

    it("returns 403 mfa_challenge_required when enrolled but no recent assertion", async () => {
      const userId = makeUserId();
      await seedPayout({ userId, amountMinor: 1_500_000_00, status: "paid" });
      await enrollUser(userId, { recentlyAsserted: false });

      const r = await request(buildApp())
        .post("/api/protected")
        .set("x-test-user-id", userId)
        .send({});
      expect(r.status).toBe(403);
      expect(r.body.error).toBe("mfa_challenge_required");
    });

    it("passes a high-velocity seller with an active enrolment + recent assertion", async () => {
      const userId = makeUserId();
      await seedPayout({ userId, amountMinor: 2_000_000_00, status: "paid" });
      await enrollUser(userId, { recentlyAsserted: true });

      const r = await request(buildApp())
        .post("/api/protected")
        .set("x-test-user-id", userId)
        .send({});
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true });
    });

    it("ignores an expired challenge — only unexpired rows count as recent", async () => {
      const userId = makeUserId();
      await seedPayout({ userId, amountMinor: 1_500_000_00, status: "paid" });
      await enrollUser(userId, { recentlyAsserted: false });
      // Insert an *expired* challenge directly (asserted 30 min ago, expired 15 min ago).
      // The TTL is 15 minutes so this row must not satisfy the gate.
      await db.execute(sql`
        INSERT INTO mfa_challenges (id, user_id, kind, asserted_at, expires_at)
        VALUES (${`mfc_${crypto.randomBytes(6).toString("hex")}`}, ${userId}, 'totp',
                now() - interval '30 minutes', now() - interval '15 minutes');
      `);

      const r = await request(buildApp())
        .post("/api/protected")
        .set("x-test-user-id", userId)
        .send({});
      expect(r.status).toBe(403);
      expect(r.body.error).toBe("mfa_challenge_required");
    });

    it("requires MFA for an admin even when their velocity is zero", async () => {
      // Admins always get gated regardless of payout history. We grant
      // the role through the real role table so `userHasAnyRole` resolves
      // it the same way the production middleware would.
      const userId = makeUserId();
      const role = await db.execute<{ id: string }>(
        sql`SELECT id FROM roles WHERE name = 'admin' LIMIT 1;`,
      );
      const roleId = role.rows[0]?.id;
      expect(roleId).toBeTruthy();
      await db.execute(sql`
        INSERT INTO user_roles (user_id, role_id, granted_by)
        VALUES (${userId}, ${roleId!}, 'test')
        ON CONFLICT DO NOTHING;
      `);

      const r = await request(buildApp())
        .post("/api/protected")
        .set("x-test-user-id", userId)
        .send({});
      expect(r.status).toBe(403);
      expect(r.body.error).toBe("mfa_required");
    });
  });
});
