import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import express, { type Express } from "express";
import request from "supertest";

/**
 * HTTP-level integration tests for the user-facing MFA endpoints:
 *
 *   GET  /api/mfa/status
 *   POST /api/mfa/totp/setup
 *   POST /api/mfa/totp/verify       (modes: activate | assert)
 *   POST /api/mfa/backup-code
 *   POST /api/mfa/totp/disable
 *
 * The pure helpers in `lib/mfa.ts` are covered by `lib/mfa.test.ts`, the
 * DB-level lifecycle by `lib/mfa.int.test.ts`, the high-value gate +
 * `requireMfa()` middleware by `lib/mfa.gate.int.test.ts`, and the
 * recovery valve by `mfa.regenerate.int.test.ts`. None of those exercise
 * the HTTP request/response shape of these five routes, so a regression
 * in (a) the `requireUserId` gate, (b) the response field names the SPA
 * reads, (c) the 6-digit code validation, or (d) the disable
 * "must re-assert" check would slip past CI today and only surface when
 * a real seller hits the QR-code screen.
 *
 * The router is mounted on a throwaway Express app under `/api` and
 * `@clerk/express` is mocked (same pattern as `mfa.gate.int.test.ts`)
 * so each test can pick the calling user via the `x-test-user-id`
 * header without rebuilding the app or touching module state.
 *
 * Skips itself when DATABASE_URL is not set so it does not break local
 * environments without a Postgres. Cleans up its own rows so it does
 * not pollute shared dev data.
 */

// Hoisted Clerk mock — `getAuth` reads the calling user from the
// `x-test-user-id` header. An absent / empty header → unauthenticated.
vi.mock("@clerk/express", () => ({
  getAuth: (req: { headers: Record<string, string | string[] | undefined> }) => {
    const raw = req.headers["x-test-user-id"];
    const userId = typeof raw === "string" && raw.length > 0 ? raw : null;
    return { userId };
  },
}));

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const TEST_USER_PREFIX = "test-mfa-routes-";

d("MFA router HTTP endpoints", () => {
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
   * Drop any existing challenge rows for the user. Used after
   * `setupTotp + verifyTotpAndActivate` (which records its own
   * challenge as a side effect) when a test wants to reproduce the
   * "enrolled but no recent assertion" state.
   */
  async function clearChallenges(userId: string): Promise<void> {
    await db.execute(sql`DELETE FROM mfa_challenges WHERE user_id = ${userId};`);
  }

  /**
   * Direct-insert a fresh `mfa_challenges` row for the user so the
   * route's `hasRecentChallenge` gate passes without round-tripping a
   * real authenticator code. 14 minutes keeps the row inside the 15-min
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
    // `/mfa/status` resolves admin role via `userHasAnyRole`, which
    // reads from `roles` / `user_roles`. Boot normally seeds those via
    // `initAdminSchema()` from app.ts; vitest never runs app.ts so we
    // call it here so the suite is self-contained on a clean DB.
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
    it("returns 401 when the request has no authenticated user", async () => {
      const r = await request(buildApp()).get("/api/mfa/status");
      expect(r.status).toBe(401);
      expect(r.body.error).toBe("unauthorized");
    });

    it("returns enrolled=false + recentlyAsserted=false for a brand-new user", async () => {
      const userId = makeUserId();
      const r = await request(buildApp())
        .get("/api/mfa/status")
        .set("x-test-user-id", userId);
      expect(r.status).toBe(200);
      expect(r.body.enrolled).toBe(false);
      expect(r.body.kind).toBeNull();
      expect(r.body.enrolledAt).toBeNull();
      expect(r.body.lastUsedAt).toBeNull();
      expect(r.body.backupCodesRemaining).toBe(0);
      expect(r.body.recentlyAsserted).toBe(false);
      // Low-velocity non-admin → MFA not required.
      expect(r.body.required).toBe(false);
      expect(r.body.requiredReason).toBeNull();
      expect(r.body.velocityNgnMinor).toBe(0);
      expect(r.body.velocityThresholdNgnMinor).toBe(1_000_000_00);
    });
  });

  describe("POST /api/mfa/totp/setup", () => {
    it("returns 401 when the request has no authenticated user", async () => {
      const r = await request(buildApp())
        .post("/api/mfa/totp/setup")
        .send({});
      expect(r.status).toBe(401);
      expect(r.body.error).toBe("unauthorized");
    });

    it("returns enrollmentId + QR + secret + 10 backup codes and persists a pending row", async () => {
      const userId = makeUserId();
      const r = await request(buildApp())
        .post("/api/mfa/totp/setup")
        .set("x-test-user-id", userId)
        .send({ accountLabel: "[email protected]" });
      expect(r.status).toBe(200);

      // Response shape: each field is what the SPA reads to render the
      // QR screen + recovery sheet. A regression that drops/renames
      // any of these breaks enrolment in the browser.
      expect(typeof r.body.enrollmentId).toBe("string");
      expect(r.body.enrollmentId).toMatch(/^mfa_/);
      expect(typeof r.body.secret).toBe("string");
      expect(r.body.secret.length).toBeGreaterThan(0);
      expect(typeof r.body.otpauthUrl).toBe("string");
      expect(r.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
      expect(r.body.otpauthUrl).toContain("issuer=Epplaa");
      expect(typeof r.body.qrCodeDataUrl).toBe("string");
      expect(r.body.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
      expect(Array.isArray(r.body.backupCodes)).toBe(true);
      expect(r.body.backupCodes).toHaveLength(10);
      expect(new Set(r.body.backupCodes).size).toBe(10);

      // DB side: a `pending` row exists with 10 hashed backup codes.
      const row = await db.execute<{ status: string; array_length: number | null }>(sql`
        SELECT status, array_length(backup_codes_hashed, 1) AS array_length
          FROM mfa_enrollments WHERE user_id = ${userId} AND kind = 'totp';
      `);
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0]!.status).toBe("pending");
      expect(row.rows[0]!.array_length).toBe(10);
    });

    it("falls back to userId as the account label when none is supplied", async () => {
      // The SPA may call setup without a label (e.g. from a user that
      // hasn't picked a display email yet). The route should still
      // return a valid otpauth URL — embedding the userId as the
      // account name — instead of 500ing on a missing field.
      const userId = makeUserId();
      const r = await request(buildApp())
        .post("/api/mfa/totp/setup")
        .set("x-test-user-id", userId)
        .send({});
      expect(r.status).toBe(200);
      expect(r.body.otpauthUrl).toContain(encodeURIComponent(userId));
    });
  });

  describe("POST /api/mfa/totp/verify", () => {
    it("returns 401 when the request has no authenticated user", async () => {
      const r = await request(buildApp())
        .post("/api/mfa/totp/verify")
        .send({ code: "123456" });
      expect(r.status).toBe(401);
      expect(r.body.error).toBe("unauthorized");
    });

    it("returns 400 invalid_code for codes that aren't 6 digits", async () => {
      const userId = makeUserId();
      const setup = await mfa.setupTotp(userId, `${userId}@example.com`);
      void setup;
      // Any of: empty, alphabetic, wrong length must be rejected at
      // the validator without ever hitting the otplib check.
      for (const bad of ["", "abc", "12345", "1234567", "1a2b3c"]) {
        const r = await request(buildApp())
          .post("/api/mfa/totp/verify")
          .set("x-test-user-id", userId)
          .send({ code: bad });
        expect(r.status).toBe(400);
        expect(r.body.error).toBe("invalid_code");
      }
    });

    it("returns 401 code_rejected when the 6-digit code does not match", async () => {
      const userId = makeUserId();
      const setup = await mfa.setupTotp(userId, `${userId}@example.com`);
      // Build a code outside the otplib accept window (current ±30s)
      // so we don't rely on a 1-in-a-million miss for "000000".
      authenticator.options = { window: 1, step: 30 };
      const accepted = new Set<string>();
      const now = Date.now();
      for (const offsetSeconds of [-30, 0, 30]) {
        authenticator.options = { window: 0, step: 30, epoch: now + offsetSeconds * 1000 };
        accepted.add(authenticator.generate(setup.secret));
      }
      authenticator.options = { window: 1, step: 30 };
      let bogus = "000000";
      let n = 0;
      while (accepted.has(bogus) && n < 1_000_000) {
        n += 1;
        bogus = String(n).padStart(6, "0");
      }
      expect(accepted.has(bogus)).toBe(false);

      const r = await request(buildApp())
        .post("/api/mfa/totp/verify")
        .set("x-test-user-id", userId)
        .send({ code: bogus });
      expect(r.status).toBe(401);
      expect(r.body.error).toBe("code_rejected");

      // Row remains pending — a wrong code must NOT activate.
      const row = await db.execute<{ status: string }>(sql`
        SELECT status FROM mfa_enrollments WHERE user_id = ${userId};
      `);
      expect(row.rows[0]!.status).toBe("pending");
    });

    it("activates the enrolment + records a challenge on a valid activate-mode code", async () => {
      const userId = makeUserId();
      const setup = await mfa.setupTotp(userId, `${userId}@example.com`);
      authenticator.options = { window: 1, step: 30 };
      const code = authenticator.generate(setup.secret);

      const r = await request(buildApp())
        .post("/api/mfa/totp/verify")
        .set("x-test-user-id", userId)
        .send({ code });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true });

      // The row flipped from pending → active and the side-effect
      // challenge row was written. /mfa/status now reports both.
      const status = await mfa.getMfaStatus(userId);
      expect(status.enrolled).toBe(true);
      expect(status.kind).toBe("totp");
      expect(status.recentlyAsserted).toBe(true);
    });

    it("strips whitespace inside the code before validating (SPA may paste '123 456')", async () => {
      const userId = makeUserId();
      const setup = await mfa.setupTotp(userId, `${userId}@example.com`);
      authenticator.options = { window: 1, step: 30 };
      const code = authenticator.generate(setup.secret);
      const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;

      const r = await request(buildApp())
        .post("/api/mfa/totp/verify")
        .set("x-test-user-id", userId)
        .send({ code: spaced });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true });
    });

    it("supports mode=assert against an already-active enrolment", async () => {
      const userId = makeUserId();
      const setup = await mfa.setupTotp(userId, `${userId}@example.com`);
      authenticator.options = { window: 1, step: 30 };
      // Activate the row first via the lib so we're testing the assert
      // path in isolation, then clear challenges so we can prove the
      // assert call records a fresh one.
      await mfa.verifyTotpAndActivate(userId, authenticator.generate(setup.secret));
      await clearChallenges(userId);
      expect(await mfa.hasRecentChallenge(userId)).toBe(false);

      const r = await request(buildApp())
        .post("/api/mfa/totp/verify")
        .set("x-test-user-id", userId)
        .send({ code: authenticator.generate(setup.secret), mode: "assert" });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true });
      expect(await mfa.hasRecentChallenge(userId)).toBe(true);
    });

    it("/api/mfa/status reflects the enrolment + remaining backup codes after verify", async () => {
      // End-to-end: setup → verify → status. The SPA polls /status to
      // show the "MFA enabled, 10 codes left" panel. A regression in
      // the response field names would break that screen silently.
      const userId = makeUserId();
      const setup = await request(buildApp())
        .post("/api/mfa/totp/setup")
        .set("x-test-user-id", userId)
        .send({});
      expect(setup.status).toBe(200);

      authenticator.options = { window: 1, step: 30 };
      const ver = await request(buildApp())
        .post("/api/mfa/totp/verify")
        .set("x-test-user-id", userId)
        .send({ code: authenticator.generate(setup.body.secret) });
      expect(ver.status).toBe(200);

      const status = await request(buildApp())
        .get("/api/mfa/status")
        .set("x-test-user-id", userId);
      expect(status.status).toBe(200);
      expect(status.body.enrolled).toBe(true);
      expect(status.body.kind).toBe("totp");
      expect(status.body.backupCodesRemaining).toBe(10);
      expect(status.body.recentlyAsserted).toBe(true);
      expect(typeof status.body.enrolledAt).toBe("string");
      // ISO 8601 — `new Date(...)` must parse it.
      expect(Number.isNaN(Date.parse(status.body.enrolledAt))).toBe(false);
    });
  });

  describe("POST /api/mfa/backup-code", () => {
    it("returns 401 when the request has no authenticated user", async () => {
      const r = await request(buildApp())
        .post("/api/mfa/backup-code")
        .send({ code: "deadbeef00" });
      expect(r.status).toBe(401);
      expect(r.body.error).toBe("unauthorized");
    });

    it("returns 400 invalid_code when the supplied code is empty / too short", async () => {
      const userId = makeUserId();
      for (const bad of ["", "   ", "abc"]) {
        const r = await request(buildApp())
          .post("/api/mfa/backup-code")
          .set("x-test-user-id", userId)
          .send({ code: bad });
        expect(r.status).toBe(400);
        expect(r.body.error).toBe("invalid_code");
      }
    });

    it("returns 401 code_rejected when the code does not match a stored backup hash", async () => {
      const userId = makeUserId();
      const setup = await mfa.setupTotp(userId, `${userId}@example.com`);
      authenticator.options = { window: 1, step: 30 };
      await mfa.verifyTotpAndActivate(userId, authenticator.generate(setup.secret));

      const r = await request(buildApp())
        .post("/api/mfa/backup-code")
        .set("x-test-user-id", userId)
        .send({ code: "zzzzzzzzzz" });
      expect(r.status).toBe(401);
      expect(r.body.error).toBe("code_rejected");
    });

    it("consumes a real backup code exactly once (single-use)", async () => {
      const userId = makeUserId();
      const setup = await mfa.setupTotp(userId, `${userId}@example.com`);
      authenticator.options = { window: 1, step: 30 };
      await mfa.verifyTotpAndActivate(userId, authenticator.generate(setup.secret));

      const code = setup.backupCodes[0]!;
      const first = await request(buildApp())
        .post("/api/mfa/backup-code")
        .set("x-test-user-id", userId)
        .send({ code });
      expect(first.status).toBe(200);
      expect(first.body).toEqual({ ok: true });

      // Stored array shrank to 9.
      const after = await db.execute<{ array_length: number | null }>(sql`
        SELECT array_length(backup_codes_hashed, 1) AS array_length
          FROM mfa_enrollments WHERE user_id = ${userId};
      `);
      expect(after.rows[0]!.array_length).toBe(9);

      // Second use of the same code is rejected — single-use.
      const reuse = await request(buildApp())
        .post("/api/mfa/backup-code")
        .set("x-test-user-id", userId)
        .send({ code });
      expect(reuse.status).toBe(401);
      expect(reuse.body.error).toBe("code_rejected");

      // /status reflects the new remaining count.
      const status = await request(buildApp())
        .get("/api/mfa/status")
        .set("x-test-user-id", userId);
      expect(status.status).toBe(200);
      expect(status.body.backupCodesRemaining).toBe(9);
    });
  });

  describe("POST /api/mfa/totp/disable", () => {
    it("returns 401 when the request has no authenticated user", async () => {
      const r = await request(buildApp())
        .post("/api/mfa/totp/disable")
        .send({});
      expect(r.status).toBe(401);
      expect(r.body.error).toBe("unauthorized");
    });

    it("refuses with 403 mfa_challenge_required when there is no recent assertion", async () => {
      // Critical security check: a stolen primary cookie must not be
      // able to remove the second factor without re-asserting it.
      const userId = makeUserId();
      const setup = await mfa.setupTotp(userId, `${userId}@example.com`);
      authenticator.options = { window: 1, step: 30 };
      await mfa.verifyTotpAndActivate(userId, authenticator.generate(setup.secret));
      await clearChallenges(userId);

      const r = await request(buildApp())
        .post("/api/mfa/totp/disable")
        .set("x-test-user-id", userId)
        .send({});
      expect(r.status).toBe(403);
      expect(r.body.error).toBe("mfa_challenge_required");

      // The enrolment row must be untouched when the gate refuses.
      const row = await db.execute<{ id: string }>(sql`
        SELECT id FROM mfa_enrollments WHERE user_id = ${userId};
      `);
      expect(row.rows).toHaveLength(1);
    });

    it("refuses with 403 mfa_challenge_required when the only challenge is expired", async () => {
      // The recent-assertion check is TTL-bound (15 min). An old row
      // that has already expired must not satisfy the gate.
      const userId = makeUserId();
      const setup = await mfa.setupTotp(userId, `${userId}@example.com`);
      authenticator.options = { window: 1, step: 30 };
      await mfa.verifyTotpAndActivate(userId, authenticator.generate(setup.secret));
      await clearChallenges(userId);
      await db.execute(sql`
        INSERT INTO mfa_challenges (id, user_id, kind, asserted_at, expires_at)
        VALUES (${`mfc_${crypto.randomBytes(6).toString("hex")}`}, ${userId}, 'totp',
                now() - interval '30 minutes', now() - interval '15 minutes');
      `);

      const r = await request(buildApp())
        .post("/api/mfa/totp/disable")
        .set("x-test-user-id", userId)
        .send({});
      expect(r.status).toBe(403);
      expect(r.body.error).toBe("mfa_challenge_required");
    });

    it("removes the enrolment + challenge rows when called with a fresh assertion", async () => {
      const userId = makeUserId();
      const setup = await mfa.setupTotp(userId, `${userId}@example.com`);
      authenticator.options = { window: 1, step: 30 };
      await mfa.verifyTotpAndActivate(userId, authenticator.generate(setup.secret));
      // verifyTotpAndActivate already records its own challenge so the
      // gate passes — no extra insert needed here.
      await recordRecentAssertion(userId);

      const r = await request(buildApp())
        .post("/api/mfa/totp/disable")
        .set("x-test-user-id", userId)
        .send({});
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true });

      const enr = await db.execute<{ id: string }>(sql`
        SELECT id FROM mfa_enrollments WHERE user_id = ${userId};
      `);
      const chl = await db.execute<{ id: string }>(sql`
        SELECT id FROM mfa_challenges WHERE user_id = ${userId};
      `);
      expect(enr.rows).toHaveLength(0);
      expect(chl.rows).toHaveLength(0);

      // /status now reports unenrolled again.
      const status = await request(buildApp())
        .get("/api/mfa/status")
        .set("x-test-user-id", userId);
      expect(status.status).toBe(200);
      expect(status.body.enrolled).toBe(false);
      expect(status.body.backupCodesRemaining).toBe(0);
    });
  });
});
