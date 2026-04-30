import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import crypto from "node:crypto";
import express, { type Express } from "express";
import request from "supertest";

/**
 * Integration test for the admin Trust & Safety route gate.
 *
 * Trust & Safety endpoints expose KYC documents (decrypted PII),
 * sanctions hits, the cross-user NDPR queue, and the audit log search
 * across every operator action. They MUST be admin-only — reviewer-tier
 * roles (moderator / support / finance_ops) get 403, even though those
 * roles can act on other operator surfaces. This test exists so a
 * future "let me just add moderator to the gate" PR cannot silently
 * widen access without breaking CI.
 *
 * For each role, every new endpoint is hit and the status code is
 * asserted. Unauthenticated requests must get 401.
 *
 * Skips itself when DATABASE_URL is unset so it does not break local
 * envs without Postgres. Cleans up its own user_role rows.
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
const TEST_USER_PREFIX = "test-ts-gate-";

d("admin Trust & Safety gate", () => {
  type Db = typeof import("../lib/db")["db"];
  type Sql = typeof import("drizzle-orm")["sql"];

  let db: Db;
  let sql: Sql;
  let app: Express;

  function makeUserId(): string {
    return `${TEST_USER_PREFIX}${crypto.randomBytes(8).toString("hex")}`;
  }

  async function grantRole(userId: string, role: string): Promise<void> {
    await db.execute(sql.raw(`
      INSERT INTO user_roles (user_id, role_id, granted_by)
      SELECT '${userId}', id, 'test:gate' FROM roles WHERE name = '${role}'
      ON CONFLICT DO NOTHING;
    `));
  }

  async function cleanup(): Promise<void> {
    await db.execute(
      sql`DELETE FROM user_roles WHERE user_id LIKE ${TEST_USER_PREFIX + "%"};`,
    );
  }

  beforeAll(async () => {
    if (!process.env.SESSION_SECRET) {
      // decryptDocument (reachable from the doc-blob route) derives a
      // key from SESSION_SECRET on import; provide a deterministic
      // value so the module loads cleanly during the test.
      process.env.SESSION_SECRET = crypto.randomBytes(32).toString("hex");
    }
    ({ db } = await import("../lib/db"));
    ({ sql } = await import("drizzle-orm"));
    const roles = await import("../lib/roles");
    await roles.initAdminSchema();
    const adminTrustSafety = (await import("./adminTrustSafety")).default;
    // Mount the legacy admin router alongside, so the same role gate
    // assertions also cover the KYC queue + approve/reject routes that
    // were migrated from `requireAdmin` (env allowlist) to
    // `requireRole(['admin'])` in this task.
    const adminLegacy = (await import("./admin")).default;
    app = express();
    app.use(express.json());
    app.use(adminTrustSafety);
    app.use(adminLegacy);
    await cleanup();
  }, 30_000);

  afterAll(async () => {
    await cleanup();
  });

  // Each tuple is [METHOD, PATH] for an admin-only route. The :id
  // values are intentionally bogus — for the auth gate test we only
  // care about the HTTP status returned by the middleware, which runs
  // before any DB lookup that would 404. Includes the new Trust &
  // Safety endpoints AND the migrated legacy KYC queue endpoints, so
  // that nobody can re-broaden access to either group without breaking
  // this test.
  const ROUTES: Array<[string, string]> = [
    // New Trust & Safety surface
    ["GET", "/admin/kyc/kyc_does_not_exist"],
    ["GET", "/admin/kyc/documents/doc_does_not_exist"],
    ["GET", "/admin/sanctions"],
    ["GET", "/admin/ndpr/requests"],
    ["POST", "/admin/ndpr/requests/ndpr_does_not_exist/cancel"],
    ["GET", "/admin/audit"],
    ["GET", "/admin/rate-limit-events"],
    // Legacy KYC routes migrated from env-allowlist requireAdmin to
    // requireRole(['admin']) in this task. Approve/reject are POSTed
    // with empty body — the role gate runs before body parsing.
    ["GET", "/admin/kyc/pending"],
    ["POST", "/admin/kyc/kyc_does_not_exist/approve"],
    ["POST", "/admin/kyc/kyc_does_not_exist/reject"],
  ];

  function call(method: string, path: string, userId?: string) {
    const r =
      method === "GET" ? request(app).get(path) : request(app).post(path);
    if (userId) r.set("x-test-user-id", userId);
    if (method === "POST") r.send({});
    return r;
  }

  it("returns 401 to unauthenticated callers on every route", async () => {
    for (const [method, path] of ROUTES) {
      const res = await call(method, path);
      expect(
        res.status,
        `${method} ${path} unauthenticated should 401`,
      ).toBe(401);
    }
  });

  for (const role of ["moderator", "support", "finance_ops"] as const) {
    it(`returns 403 to '${role}' role on every route (admin-only)`, async () => {
      const userId = makeUserId();
      await grantRole(userId, role);
      for (const [method, path] of ROUTES) {
        const res = await call(method, path, userId);
        expect(
          res.status,
          `${method} ${path} as '${role}' should 403, got ${res.status}`,
        ).toBe(403);
      }
    });
  }

  it("admin role passes the gate on every route (status is NOT 401/403)", async () => {
    const userId = makeUserId();
    await grantRole(userId, "admin");
    for (const [method, path] of ROUTES) {
      const res = await call(method, path, userId);
      // We don't care whether the underlying handler 200s or 404s — just
      // that the role gate did not reject. 401/403 here would indicate
      // a regression in the ADMIN_ONLY allowlist.
      expect(
        [401, 403].includes(res.status),
        `${method} ${path} as admin should pass gate, got ${res.status}`,
      ).toBe(false);
    }
  });
});
