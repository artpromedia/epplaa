import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import express, { type Express } from "express";
import request from "supertest";

/**
 * Integration tests for POST `/api/mfa/totp/regenerate-backup-codes`.
 *
 * The regenerate endpoint is the recovery valve for users who ran their
 * sheet of single-use backup codes down to the danger zone. The unit
 * tests in `lib/mfa.test.ts` cover the pure helpers (hashing, code
 * generation), and `lib/mfa.int.test.ts` covers the DB-level lifecycle,
 * but neither exercises the route as a whole. This suite walks the full
 * decision tree end-to-end against a real Postgres so a regression in
 * the recent-assertion gate, the not-enrolled 404 branch, or the swap
 * of stored backup-code hashes will fail here long before a user finds
 * themselves locked out.
 *
 * Skips itself when DATABASE_URL is not set so it does not break local
 * environments without a Postgres. Cleans up its own rows so it does
 * not pollute shared dev data.
 */

// Hoisted Clerk mock — `getAuth` reads the calling user from the
// `x-test-user-id` header so each test can pick the identity for the
// request without rebuilding the app or fiddling with module state.
vi.mock("@clerk/express", () => ({
  getAuth: (req: { headers: Record<string, string | string[] | undefined> }) => {
    const raw = req.headers["x-test-user-id"];
    const userId = typeof raw === "string" && raw.length > 0 ? raw : null;
    return { userId };
  },
}));

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const TEST_USER_PREFIX = "test-mfa-regen-";

d("POST /api/mfa/totp/regenerate-backup-codes", () => {
  type Db = typeof import("../lib/db")["db"];
  type Sql = typeof import("drizzle-orm")["sql"];
  type Authenticator = typeof import("otplib")["authenticator"];
  type Mfa = typeof import("../lib/mfa");
  type Security = typeof import("../lib/security");
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
   * Direct-insert a fresh `mfa_challenges` row for the user so the
   * route's `hasRecentChallenge` gate passes without needing a real
   * authenticator code. Using a 14-minute TTL keeps the row inside the
   * 15-minute assertion window even on slow machines.
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
    mfaRouter = (await import("./mfa")).default;
    await cleanup();
  }, 30_000);

  afterEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("returns 401 when the request has no authenticated user", async () => {
    const r = await request(buildApp())
      .post("/api/mfa/totp/regenerate-backup-codes")
      .send({});
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("unauthorized");
  });

  it("returns 403 mfa_challenge_required when there is no recent assertion", async () => {
    const userId = makeUserId();
    // Enrol + activate so the user has a real factor, but immediately
    // strip all challenge rows so the assertion gate fails. Without
    // this we'd be testing 404 (no enrolment) instead of 403.
    const setup = await mfa.setupTotp(userId, `${userId}@example.com`);
    authenticator.options = { window: 1, step: 30 };
    await mfa.verifyTotpAndActivate(userId, authenticator.generate(setup.secret));
    await db.execute(sql`DELETE FROM mfa_challenges WHERE user_id = ${userId};`);

    const r = await request(buildApp())
      .post("/api/mfa/totp/regenerate-backup-codes")
      .set("x-test-user-id", userId)
      .send({});
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("mfa_challenge_required");

    // The stored hashes must be untouched when the gate refuses the
    // request — otherwise an attacker could burn the user's sheet by
    // hammering this endpoint.
    const row = await db.execute<{ backup_codes_hashed: string[] }>(sql`
      SELECT backup_codes_hashed FROM mfa_enrollments WHERE user_id = ${userId};
    `);
    expect(row.rows[0]!.backup_codes_hashed).toHaveLength(10);
  });

  it("returns 404 mfa_not_enrolled when the user has no active TOTP factor", async () => {
    // No enrolment row at all, but a recent challenge so we can prove
    // the 404 branch fires *after* the assertion gate. (The order
    // matters: a missing enrolment must not surface as 403, and a
    // missing assertion must not surface as 404.)
    const userId = makeUserId();
    await recordRecentAssertion(userId);

    const r = await request(buildApp())
      .post("/api/mfa/totp/regenerate-backup-codes")
      .set("x-test-user-id", userId)
      .send({});
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("mfa_not_enrolled");
  });

  it("returns 404 mfa_not_enrolled when the user only has a pending (unverified) enrolment", async () => {
    // Pending enrolments must not be allowed to mint a fresh sheet —
    // the SPA flow would otherwise let an attacker who knows the
    // primary password complete enrolment with no second factor.
    const userId = makeUserId();
    await mfa.setupTotp(userId, `${userId}@example.com`);
    await recordRecentAssertion(userId);

    const r = await request(buildApp())
      .post("/api/mfa/totp/regenerate-backup-codes")
      .set("x-test-user-id", userId)
      .send({});
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("mfa_not_enrolled");
  });

  it("issues 10 fresh single-use backup codes and invalidates the previous sheet", async () => {
    const userId = makeUserId();
    const setup = await mfa.setupTotp(userId, `${userId}@example.com`);
    authenticator.options = { window: 1, step: 30 };
    await mfa.verifyTotpAndActivate(userId, authenticator.generate(setup.secret));
    // verifyTotpAndActivate records its own challenge so the gate
    // passes; no need to insert one manually. Snapshot the original
    // hashes so we can prove they were swapped, not appended.
    const before = await db.execute<{ backup_codes_hashed: string[] }>(sql`
      SELECT backup_codes_hashed FROM mfa_enrollments WHERE user_id = ${userId};
    `);
    const oldHashes = before.rows[0]!.backup_codes_hashed;

    const r = await request(buildApp())
      .post("/api/mfa/totp/regenerate-backup-codes")
      .set("x-test-user-id", userId)
      .send({});
    expect(r.status).toBe(200);

    const fresh: string[] = r.body.backupCodes;
    expect(Array.isArray(fresh)).toBe(true);
    expect(fresh).toHaveLength(10);
    expect(new Set(fresh).size).toBe(10);
    // None of the freshly minted plaintext codes should overlap with
    // the old ones (40-bit codes — collision odds are vanishingly low).
    for (const c of fresh) {
      expect(setup.backupCodes).not.toContain(c);
    }

    // The stored hashes were replaced (not extended) — array length
    // stayed at 10 and every old hash is gone.
    const after = await db.execute<{
      backup_codes_hashed: string[];
      array_length: number | null;
    }>(sql`
      SELECT backup_codes_hashed,
             array_length(backup_codes_hashed, 1) AS array_length
        FROM mfa_enrollments WHERE user_id = ${userId};
    `);
    expect(after.rows[0]!.array_length).toBe(10);
    const newHashes = after.rows[0]!.backup_codes_hashed;
    for (const h of oldHashes) {
      expect(newHashes).not.toContain(h);
    }

    // The old sheet must be useless: every one of the original 10
    // codes is rejected after regeneration.
    for (const old of setup.backupCodes) {
      const ok = await mfa.consumeBackupCode(userId, old);
      expect(ok).toBe(false);
    }

    // Every one of the 10 fresh codes the route returned must consume
    // exactly once. We walk the full set so that a regression which
    // (a) returned duplicates, (b) only persisted a subset, or (c)
    // marked a code as already-consumed at mint time would all fail
    // here — not just on the first or second code.
    expect(fresh).toHaveLength(10);
    for (let i = 0; i < fresh.length; i++) {
      const code = fresh[i]!;
      const firstUse = await mfa.consumeBackupCode(userId, code);
      expect(firstUse, `fresh[${i}] should consume on first use`).toBe(true);
      const reuse = await mfa.consumeBackupCode(userId, code);
      expect(reuse, `fresh[${i}] must NOT consume a second time`).toBe(false);
    }

    // After consuming all 10 the user is out of backup codes — proves
    // the route persisted exactly 10 active codes, no more, no fewer.
    const finalStatus = await mfa.getMfaStatus(userId);
    expect(finalStatus.backupCodesRemaining).toBe(0);
  });
});
