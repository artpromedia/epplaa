import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import express, { type Express } from "express";
import request from "supertest";
import {
  ConsumeMfaBackupCodeResponse,
  DisableMfaTotpResponse,
  GetMfaStatusResponse,
  RegenerateMfaBackupCodesResponse,
  SetupMfaTotpResponse,
  VerifyMfaTotpResponse,
} from "@workspace/api-zod";

/**
 * Runtime contract tests for the MFA HTTP endpoints.
 *
 * The field-by-field assertions in `mfa.int.test.ts` only cover the keys
 * the test author thought to check: a future field rename, removal, or
 * type change would still pass that suite while quietly breaking the
 * manufacturer/seller SPAs that read the payload through the OpenAPI-
 * generated `MfaStatus` / `MfaSetupResult` types.
 *
 * This suite closes that gap by re-parsing every successful response
 * with the generated Zod schemas from `@workspace/api-zod` (the same
 * source of truth the SPAs are typed against). If the route adds an
 * unexpected field or drops a required one the schema parse throws and
 * the test fails before the broken shape can land in production.
 *
 * The route handlers themselves also call `sendValidated` with the same
 * schemas, so a contract regression would actually surface as a 500
 * `response_contract_violation` here — both layers (server-side guard +
 * test-side parse) are exercised.
 *
 * Skips itself when DATABASE_URL is not set so it does not break local
 * environments without a Postgres. Cleans up its own rows so it does
 * not pollute shared dev data.
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
const TEST_USER_PREFIX = "test-mfa-contract-";

d("MFA HTTP contract (response shapes match @workspace/api-zod)", () => {
  type Db = typeof import("../lib/db")["db"];
  type Sql = typeof import("drizzle-orm")["sql"];
  type Authenticator = typeof import("otplib")["authenticator"];
  type Mfa = typeof import("../lib/mfa");
  type Security = typeof import("../lib/security");
  type Roles = typeof import("../lib/roles");
  type MfaRouter = typeof import("./mfa")["default"];

  let db: Db;
  let sql: Sql;
  let authenticator: Authenticator;
  let mfa: Mfa;
  let mfaRouter: MfaRouter;

  function makeUserId(): string {
    return `${TEST_USER_PREFIX}${crypto.randomBytes(8).toString("hex")}`;
  }

  function buildApp(): Express {
    const app = express();
    app.use(express.json());
    app.use("/api", mfaRouter);
    return app;
  }

  /**
   * Direct-insert a fresh `mfa_challenges` row so the route's
   * `hasRecentChallenge` gate passes without round-tripping a real
   * authenticator code. 14 minutes keeps the row inside the 15-min
   * assertion TTL even on slow machines.
   */
  async function recordRecentAssertion(userId: string): Promise<void> {
    const id = `mfc_${crypto.randomBytes(6).toString("hex")}`;
    await db.execute(sql`
      INSERT INTO mfa_challenges (id, user_id, kind, asserted_at, expires_at)
      VALUES (${id}, ${userId}, 'totp', now(), now() + interval '14 minutes');
    `);
  }

  async function cleanup(): Promise<void> {
    await db.execute(
      sql`DELETE FROM mfa_enrollments WHERE user_id LIKE ${TEST_USER_PREFIX + "%"};`,
    );
    await db.execute(
      sql`DELETE FROM mfa_challenges WHERE user_id LIKE ${TEST_USER_PREFIX + "%"};`,
    );
    await db.execute(
      sql`DELETE FROM payouts WHERE user_id LIKE ${TEST_USER_PREFIX + "%"} OR seller_id LIKE ${TEST_USER_PREFIX + "%"};`,
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
    ({ db } = await import("../lib/db"));
    ({ sql } = await import("drizzle-orm"));
    ({ authenticator } = await import("otplib"));
    mfa = await import("../lib/mfa");
    const security: Security = await import("../lib/security");
    await security.initSecuritySchema();
    const roles: Roles = await import("../lib/roles");
    await roles.initAdminSchema();
    mfaRouter = (await import("./mfa")).default;
    await cleanup();
  }, 30_000);

  afterEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
  });

  describe("GET /api/mfa/status", () => {
    it("matches the generated MfaStatus contract for a brand-new user", async () => {
      // Default state: not enrolled, low velocity, no admin role. This
      // is the most common shape the SPA reads on first load and the
      // one most likely to drift if the route grows new fields.
      const userId = makeUserId();
      const r = await request(buildApp())
        .get("/api/mfa/status")
        .set("x-test-user-id", userId);
      expect(r.status).toBe(200);

      const parsed = GetMfaStatusResponse.safeParse(r.body);
      if (!parsed.success) {
        throw new Error(
          "GetMfaStatusResponse contract violation: " +
            JSON.stringify(parsed.error.issues, null, 2),
        );
      }

      // Belt-and-suspenders: the parse only fails on missing/wrong-type
      // fields. Re-parse with .strict() so we also catch *extra* fields
      // the route added without updating the OpenAPI spec — those are
      // the silent drifts the SPA's hand-typed code used to inherit.
      const strictParsed = GetMfaStatusResponse.strict().safeParse(r.body);
      if (!strictParsed.success) {
        throw new Error(
          "GetMfaStatusResponse has unspecified extra fields (drift): " +
            JSON.stringify(strictParsed.error.issues, null, 2),
        );
      }
    });

    it("matches the generated MfaStatus contract after enrolment lifecycle", async () => {
      // After setup → verify the response shape changes a lot:
      //  - enrolled flips to true
      //  - kind goes from null to "totp"
      //  - enrolledAt + lastUsedAt become ISO strings (not Date objects)
      //  - backupCodesRemaining = 10
      //  - recentlyAsserted = true
      // All of these are what the SPA renders in the "MFA active" panel.
      const userId = makeUserId();
      const setup = await mfa.setupTotp(userId, `${userId}@example.com`);
      authenticator.options = { window: 1, step: 30 };
      await mfa.verifyTotpAndActivate(
        userId,
        authenticator.generate(setup.secret),
      );

      const r = await request(buildApp())
        .get("/api/mfa/status")
        .set("x-test-user-id", userId);
      expect(r.status).toBe(200);

      const parsed = GetMfaStatusResponse.strict().safeParse(r.body);
      if (!parsed.success) {
        throw new Error(
          "Enrolled MfaStatus contract violation: " +
            JSON.stringify(parsed.error.issues, null, 2),
        );
      }
      // The schema lets `enrolledAt` be string|null but a real enrolled
      // user must surface a parseable ISO string — guard against the
      // common regression of forgetting the `.toISOString()` call and
      // accidentally serialising a Date object.
      expect(typeof parsed.data.enrolledAt).toBe("string");
      expect(Number.isNaN(Date.parse(parsed.data.enrolledAt as string))).toBe(
        false,
      );
      expect(parsed.data.kind).toBe("totp");
      expect(parsed.data.enrolled).toBe(true);
    });
  });

  describe("POST /api/mfa/totp/setup", () => {
    it("matches the generated MfaSetupResult contract", async () => {
      const userId = makeUserId();
      const r = await request(buildApp())
        .post("/api/mfa/totp/setup")
        .set("x-test-user-id", userId)
        .send({ accountLabel: `${userId}@example.com` });
      expect(r.status).toBe(200);

      const parsed = SetupMfaTotpResponse.strict().safeParse(r.body);
      if (!parsed.success) {
        throw new Error(
          "SetupMfaTotpResponse contract violation: " +
            JSON.stringify(parsed.error.issues, null, 2),
        );
      }
      // The SPA renders these directly — keep tight invariants on top
      // of the generic shape so the contract test catches sentinel
      // regressions (empty arrays, wrong protocol, etc.).
      expect(parsed.data.backupCodes.length).toBeGreaterThan(0);
      expect(parsed.data.otpauthUrl.startsWith("otpauth://totp/")).toBe(true);
      expect(parsed.data.qrCodeDataUrl.startsWith("data:image/png;base64,")).toBe(
        true,
      );
    });
  });

  describe("POST /api/mfa/totp/verify", () => {
    it("matches the generated VerifyMfaTotpResponse contract on success", async () => {
      const userId = makeUserId();
      const setup = await mfa.setupTotp(userId, `${userId}@example.com`);
      authenticator.options = { window: 1, step: 30 };

      const r = await request(buildApp())
        .post("/api/mfa/totp/verify")
        .set("x-test-user-id", userId)
        .send({ code: authenticator.generate(setup.secret) });
      expect(r.status).toBe(200);

      const parsed = VerifyMfaTotpResponse.strict().safeParse(r.body);
      if (!parsed.success) {
        throw new Error(
          "VerifyMfaTotpResponse contract violation: " +
            JSON.stringify(parsed.error.issues, null, 2),
        );
      }
      expect(parsed.data.ok).toBe(true);
    });
  });

  describe("POST /api/mfa/backup-code", () => {
    it("matches the generated ConsumeMfaBackupCodeResponse contract on success", async () => {
      const userId = makeUserId();
      const setup = await mfa.setupTotp(userId, `${userId}@example.com`);
      authenticator.options = { window: 1, step: 30 };
      await mfa.verifyTotpAndActivate(
        userId,
        authenticator.generate(setup.secret),
      );

      const r = await request(buildApp())
        .post("/api/mfa/backup-code")
        .set("x-test-user-id", userId)
        .send({ code: setup.backupCodes[0] });
      expect(r.status).toBe(200);

      const parsed = ConsumeMfaBackupCodeResponse.strict().safeParse(r.body);
      if (!parsed.success) {
        throw new Error(
          "ConsumeMfaBackupCodeResponse contract violation: " +
            JSON.stringify(parsed.error.issues, null, 2),
        );
      }
      expect(parsed.data.ok).toBe(true);
    });
  });

  describe("POST /api/mfa/totp/disable", () => {
    it("matches the generated DisableMfaTotpResponse contract on success", async () => {
      const userId = makeUserId();
      const setup = await mfa.setupTotp(userId, `${userId}@example.com`);
      authenticator.options = { window: 1, step: 30 };
      await mfa.verifyTotpAndActivate(
        userId,
        authenticator.generate(setup.secret),
      );
      // Direct-insert a fresh assertion so the recent-challenge gate
      // passes without round-tripping a code.
      await recordRecentAssertion(userId);

      const r = await request(buildApp())
        .post("/api/mfa/totp/disable")
        .set("x-test-user-id", userId);
      expect(r.status).toBe(200);

      const parsed = DisableMfaTotpResponse.strict().safeParse(r.body);
      if (!parsed.success) {
        throw new Error(
          "DisableMfaTotpResponse contract violation: " +
            JSON.stringify(parsed.error.issues, null, 2),
        );
      }
      expect(parsed.data.ok).toBe(true);
    });
  });

  describe("POST /api/mfa/totp/regenerate-backup-codes", () => {
    it("matches the generated RegenerateMfaBackupCodesResponse contract on success", async () => {
      const userId = makeUserId();
      const setup = await mfa.setupTotp(userId, `${userId}@example.com`);
      authenticator.options = { window: 1, step: 30 };
      await mfa.verifyTotpAndActivate(
        userId,
        authenticator.generate(setup.secret),
      );
      await recordRecentAssertion(userId);

      const r = await request(buildApp())
        .post("/api/mfa/totp/regenerate-backup-codes")
        .set("x-test-user-id", userId);
      expect(r.status).toBe(200);

      const parsed = RegenerateMfaBackupCodesResponse.strict().safeParse(
        r.body,
      );
      if (!parsed.success) {
        throw new Error(
          "RegenerateMfaBackupCodesResponse contract violation: " +
            JSON.stringify(parsed.error.issues, null, 2),
        );
      }
      expect(parsed.data.backupCodes.length).toBeGreaterThan(0);
    });
  });
});
