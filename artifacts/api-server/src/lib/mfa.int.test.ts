import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import crypto from "node:crypto";

/**
 * Integration tests for the MFA enrolment lifecycle against a real Postgres.
 *
 * Why an integration test (and not just unit tests):
 *   The TOTP enrolment endpoint shipped a 500 in production because the raw
 *   SQL was passing a JS array to a Postgres `text[]` column in a way Drizzle
 *   expanded to a row constructor (`($1, $2, ...)`) instead of an array
 *   literal (`'{...}'::text[]`). The pure-function unit tests in
 *   `mfa.test.ts` (encryption envelope + backup code generation) could not
 *   catch this because they never hit the database. These tests exercise the
 *   real INSERT/UPDATE statements end-to-end so any future array-cast or
 *   parameter-binding regression fails locally and in CI, not in prod.
 *
 * Skips itself if DATABASE_URL is not configured (so this file does not break
 * environments without a Postgres). When it does run it cleans up its own
 * rows so it does not pollute shared dev data.
 */

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const TEST_USER_PREFIX = "test-mfa-int-";

d("mfa db integration", () => {
  type Db = typeof import("./db")["db"];
  type Sql = typeof import("drizzle-orm")["sql"];
  type Authenticator = typeof import("otplib")["authenticator"];
  type Mfa = typeof import("./mfa");
  type Security = typeof import("./security");

  let db: Db;
  let sql: Sql;
  let authenticator: Authenticator;
  let mfa: Mfa;

  function makeUserId(): string {
    return `${TEST_USER_PREFIX}${crypto.randomBytes(8).toString("hex")}`;
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
    ({ db } = await import("./db"));
    ({ sql } = await import("drizzle-orm"));
    ({ authenticator } = await import("otplib"));
    mfa = await import("./mfa");
    const security: Security = await import("./security");
    await security.initSecuritySchema();
    await cleanup();
  }, 30_000);

  afterEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("setupTotp inserts a pending row whose backup_codes_hashed is a real text[] of length 10", async () => {
    const userId = makeUserId();
    const result = await mfa.setupTotp(userId, `${userId}@example.com`);

    expect(result.backupCodes).toHaveLength(10);
    expect(new Set(result.backupCodes).size).toBe(10);

    const row = await db.execute<{
      status: string;
      backup_codes_hashed: string[];
      array_length: number | null;
      secret_encrypted: string;
    }>(sql`
      SELECT status,
             backup_codes_hashed,
             array_length(backup_codes_hashed, 1) AS array_length,
             secret_encrypted
        FROM mfa_enrollments
       WHERE user_id = ${userId} AND kind = 'totp';
    `);
    expect(row.rows).toHaveLength(1);
    const r = row.rows[0]!;
    expect(r.status).toBe("pending");
    // Regression guard for the row-constructor bug: the column must come
    // back as a JS array of exactly 10 sha256 hex hashes.
    expect(Array.isArray(r.backup_codes_hashed)).toBe(true);
    expect(r.backup_codes_hashed).toHaveLength(10);
    expect(r.array_length).toBe(10);
    for (const h of r.backup_codes_hashed) {
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(mfa.decryptSecret(r.secret_encrypted)).toBe(result.secret);
  });

  it("re-enrolment via UPSERT replaces the prior backup-code array atomically", async () => {
    const userId = makeUserId();
    const first = await mfa.setupTotp(userId, `${userId}@example.com`);
    const second = await mfa.setupTotp(userId, `${userId}@example.com`);

    const row = await db.execute<{
      backup_codes_hashed: string[];
      array_length: number | null;
    }>(sql`
      SELECT backup_codes_hashed,
             array_length(backup_codes_hashed, 1) AS array_length
        FROM mfa_enrollments
       WHERE user_id = ${userId} AND kind = 'totp';
    `);
    expect(row.rows).toHaveLength(1);
    const r = row.rows[0]!;
    expect(r.array_length).toBe(10);
    expect(r.backup_codes_hashed).toHaveLength(10);
    // The two enrolments minted independent code sets, so combined we expect
    // 20 distinct plaintext codes (and no overlap leaking from the first).
    expect(new Set([...first.backupCodes, ...second.backupCodes]).size).toBe(20);
  });

  it("verifyTotpAndActivate flips status to active and records a challenge", async () => {
    const userId = makeUserId();
    const result = await mfa.setupTotp(userId, `${userId}@example.com`);
    authenticator.options = { window: 1, step: 30 };
    const code = authenticator.generate(result.secret);

    const ok = await mfa.verifyTotpAndActivate(userId, code);
    expect(ok).toBe(true);

    const row = await db.execute<{ status: string; enrolled_at: Date | null }>(sql`
      SELECT status, enrolled_at FROM mfa_enrollments WHERE user_id = ${userId};
    `);
    expect(row.rows[0]!.status).toBe("active");
    expect(row.rows[0]!.enrolled_at).not.toBeNull();

    const chl = await db.execute<{ id: string }>(sql`
      SELECT id FROM mfa_challenges WHERE user_id = ${userId};
    `);
    expect(chl.rows.length).toBeGreaterThanOrEqual(1);
  });

  it("verifyTotpAndActivate rejects a wrong code and leaves status pending", async () => {
    const userId = makeUserId();
    const result = await mfa.setupTotp(userId, `${userId}@example.com`);

    // Build a code that is guaranteed-invalid right now: enumerate the codes
    // accepted by `window=1` (previous, current, next 30s step) and pick a
    // 6-digit string outside that set. This avoids the 1-in-a-million flake
    // of a hard-coded "000000" coinciding with a legitimate code.
    authenticator.options = { window: 1, step: 30 };
    const accepted = new Set<string>();
    const now = Date.now();
    for (const offsetSeconds of [-30, 0, 30]) {
      authenticator.options = { window: 0, step: 30, epoch: now + offsetSeconds * 1000 };
      accepted.add(authenticator.generate(result.secret));
    }
    authenticator.options = { window: 1, step: 30 };
    let bogus = "000000";
    let n = 0;
    while (accepted.has(bogus) && n < 1_000_000) {
      n += 1;
      bogus = String(n).padStart(6, "0");
    }
    expect(accepted.has(bogus)).toBe(false);

    const ok = await mfa.verifyTotpAndActivate(userId, bogus);
    expect(ok).toBe(false);

    const row = await db.execute<{ status: string }>(sql`
      SELECT status FROM mfa_enrollments WHERE user_id = ${userId};
    `);
    expect(row.rows[0]!.status).toBe("pending");
  });

  it("consumeBackupCode atomically removes the matched hash and rejects re-use", async () => {
    const userId = makeUserId();
    const result = await mfa.setupTotp(userId, `${userId}@example.com`);
    authenticator.options = { window: 1, step: 30 };
    await mfa.verifyTotpAndActivate(userId, authenticator.generate(result.secret));

    const code = result.backupCodes[0]!;
    const first = await mfa.consumeBackupCode(userId, code);
    expect(first).toBe(true);

    const after = await db.execute<{ backup_codes_hashed: string[] }>(sql`
      SELECT backup_codes_hashed FROM mfa_enrollments WHERE user_id = ${userId};
    `);
    expect(after.rows[0]!.backup_codes_hashed).toHaveLength(9);

    // Single-use: the same code cannot be consumed twice.
    const second = await mfa.consumeBackupCode(userId, code);
    expect(second).toBe(false);

    // An unknown code is also rejected.
    const bogus = await mfa.consumeBackupCode(userId, "deadbeef00");
    expect(bogus).toBe(false);
  });

  it("pruneStalePendingMfaEnrollments deletes only stale pending rows and leaves active + fresh pending alone", async () => {
    const stalePendingUser = makeUserId();
    const freshPendingUser = makeUserId();
    const activeUser = makeUserId();

    // 1. Stale pending: enrol then back-date `updated_at` past the cutoff.
    await mfa.setupTotp(stalePendingUser, `${stalePendingUser}@example.com`);
    await db.execute(sql`
      UPDATE mfa_enrollments
         SET updated_at = now() - interval '1 hour'
       WHERE user_id = ${stalePendingUser};
    `);

    // 2. Fresh pending: enrol but don't verify and don't back-date.
    await mfa.setupTotp(freshPendingUser, `${freshPendingUser}@example.com`);

    // 3. Active enrolment: enrol, verify, then back-date `updated_at` to
    //    prove the prune ignores `status = 'active'` regardless of age.
    const activeSetup = await mfa.setupTotp(activeUser, `${activeUser}@example.com`);
    const { authenticator: a } = await import("otplib");
    a.options = { window: 1, step: 30 };
    await mfa.verifyTotpAndActivate(activeUser, a.generate(activeSetup.secret));
    await db.execute(sql`
      UPDATE mfa_enrollments
         SET updated_at = now() - interval '1 hour'
       WHERE user_id = ${activeUser};
    `);

    // Use a 10 minute cutoff so the back-dated pending row is stale and
    // the freshly-inserted pending row is not.
    const pruned = await mfa.pruneStalePendingMfaEnrollments(10 * 60 * 1000);
    expect(pruned).toBe(1);

    const remaining = await db.execute<{ user_id: string; status: string }>(sql`
      SELECT user_id, status FROM mfa_enrollments
       WHERE user_id IN (${stalePendingUser}, ${freshPendingUser}, ${activeUser})
       ORDER BY user_id;
    `);
    const byUser = new Map(remaining.rows.map((r) => [r.user_id, r.status]));
    expect(byUser.has(stalePendingUser)).toBe(false);
    expect(byUser.get(freshPendingUser)).toBe("pending");
    expect(byUser.get(activeUser)).toBe("active");

    // Idempotent: second run finds nothing to prune.
    const second = await mfa.pruneStalePendingMfaEnrollments(10 * 60 * 1000);
    expect(second).toBe(0);
  });

  it("pruneStalePendingMfaEnrollments uses the default ~10 minute window when no arg is supplied", async () => {
    expect(mfa.DEFAULT_MFA_PENDING_PRUNE_MAX_AGE_MS).toBe(10 * 60 * 1000);

    const justInsideUser = makeUserId();
    const justOutsideUser = makeUserId();

    await mfa.setupTotp(justInsideUser, `${justInsideUser}@example.com`);
    await mfa.setupTotp(justOutsideUser, `${justOutsideUser}@example.com`);

    // Back-date one row to 9 minutes ago (still inside the 10 min window)
    // and the other to 11 minutes ago (outside).
    await db.execute(sql`
      UPDATE mfa_enrollments
         SET updated_at = now() - interval '9 minutes'
       WHERE user_id = ${justInsideUser};
    `);
    await db.execute(sql`
      UPDATE mfa_enrollments
         SET updated_at = now() - interval '11 minutes'
       WHERE user_id = ${justOutsideUser};
    `);

    const pruned = await mfa.pruneStalePendingMfaEnrollments();
    expect(pruned).toBe(1);

    const remaining = await db.execute<{ user_id: string }>(sql`
      SELECT user_id FROM mfa_enrollments
       WHERE user_id IN (${justInsideUser}, ${justOutsideUser});
    `);
    const ids = remaining.rows.map((r) => r.user_id);
    expect(ids).toContain(justInsideUser);
    expect(ids).not.toContain(justOutsideUser);
  });

  it("disableMfa removes both enrolment and challenge rows for the user", async () => {
    const userId = makeUserId();
    const result = await mfa.setupTotp(userId, `${userId}@example.com`);
    authenticator.options = { window: 1, step: 30 };
    await mfa.verifyTotpAndActivate(userId, authenticator.generate(result.secret));

    await mfa.disableMfa(userId);

    const enr = await db.execute<{ id: string }>(
      sql`SELECT id FROM mfa_enrollments WHERE user_id = ${userId};`,
    );
    const chl = await db.execute<{ id: string }>(
      sql`SELECT id FROM mfa_challenges WHERE user_id = ${userId};`,
    );
    expect(enr.rows).toHaveLength(0);
    expect(chl.rows).toHaveLength(0);
  });
});
