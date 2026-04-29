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
    await db.execute(
      sql`DELETE FROM notifications_outbox WHERE user_id LIKE ${TEST_USER_PREFIX + "%"};`,
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

  it("pruneExpiredMfaChallenges deletes only rows past the grace window and keeps still-valid + recently-expired rows", async () => {
    const ancientUser = makeUserId();
    const recentlyExpiredUser = makeUserId();
    const validUser = makeUserId();

    // Insert directly so we can control `expires_at` precisely.
    // 1. Long-expired (2 days ago) — should be pruned with the default
    //    1-day grace.
    await db.execute(sql`
      INSERT INTO mfa_challenges (id, user_id, kind, asserted_at, expires_at)
      VALUES (
        ${"mfc_test_old_" + crypto.randomBytes(4).toString("hex")},
        ${ancientUser},
        'totp',
        now() - interval '2 days' - interval '15 minutes',
        now() - interval '2 days'
      );
    `);
    // 2. Recently expired (1 hour ago) — inside the 1-day grace, kept.
    await db.execute(sql`
      INSERT INTO mfa_challenges (id, user_id, kind, asserted_at, expires_at)
      VALUES (
        ${"mfc_test_recent_" + crypto.randomBytes(4).toString("hex")},
        ${recentlyExpiredUser},
        'totp',
        now() - interval '1 hour' - interval '15 minutes',
        now() - interval '1 hour'
      );
    `);
    // 3. Still valid (expires 10 minutes in the future) — kept.
    await db.execute(sql`
      INSERT INTO mfa_challenges (id, user_id, kind, asserted_at, expires_at)
      VALUES (
        ${"mfc_test_valid_" + crypto.randomBytes(4).toString("hex")},
        ${validUser},
        'totp',
        now() - interval '5 minutes',
        now() + interval '10 minutes'
      );
    `);

    const pruned = await mfa.pruneExpiredMfaChallenges();
    expect(pruned).toBe(1);

    const remaining = await db.execute<{ user_id: string }>(sql`
      SELECT user_id FROM mfa_challenges
       WHERE user_id IN (${ancientUser}, ${recentlyExpiredUser}, ${validUser})
       ORDER BY user_id;
    `);
    const ids = remaining.rows.map((r) => r.user_id);
    expect(ids).not.toContain(ancientUser);
    expect(ids).toContain(recentlyExpiredUser);
    expect(ids).toContain(validUser);

    // Idempotent: a second run with the same grace finds nothing.
    const second = await mfa.pruneExpiredMfaChallenges();
    expect(second).toBe(0);
  });

  it("pruneExpiredMfaChallenges honours an explicit grace argument and the documented default", async () => {
    expect(mfa.DEFAULT_MFA_CHALLENGES_PRUNE_GRACE_MS).toBe(24 * 60 * 60 * 1000);

    const justInsideUser = makeUserId();
    const justOutsideUser = makeUserId();

    // `justInside` expired 30 minutes ago, `justOutside` expired 90
    // minutes ago. With a 1-hour grace, only `justOutside` should go.
    await db.execute(sql`
      INSERT INTO mfa_challenges (id, user_id, kind, asserted_at, expires_at)
      VALUES (
        ${"mfc_test_in_" + crypto.randomBytes(4).toString("hex")},
        ${justInsideUser},
        'totp',
        now() - interval '45 minutes',
        now() - interval '30 minutes'
      );
    `);
    await db.execute(sql`
      INSERT INTO mfa_challenges (id, user_id, kind, asserted_at, expires_at)
      VALUES (
        ${"mfc_test_out_" + crypto.randomBytes(4).toString("hex")},
        ${justOutsideUser},
        'totp',
        now() - interval '105 minutes',
        now() - interval '90 minutes'
      );
    `);

    const pruned = await mfa.pruneExpiredMfaChallenges(60 * 60 * 1000);
    expect(pruned).toBe(1);

    const remaining = await db.execute<{ user_id: string }>(sql`
      SELECT user_id FROM mfa_challenges
       WHERE user_id IN (${justInsideUser}, ${justOutsideUser});
    `);
    const ids = remaining.rows.map((r) => r.user_id);
    expect(ids).toContain(justInsideUser);
    expect(ids).not.toContain(justOutsideUser);
  });

  /*
   * --- Low-backup-codes email nudge ---
   *
   * The job scans active TOTP enrolments and emails users when the
   * remaining backup-code count drops below the warning threshold (3)
   * or hits zero. We assert:
   *   1. A user with plenty of codes is left alone.
   *   2. A user newly under the threshold is emailed exactly once
   *      across multiple ticks (no loop).
   *   3. Crossing into "empty" after a prior "low" nudge sends a fresh
   *      email at the higher severity.
   *   4. Regenerating codes back to 10 clears the marker, so a future
   *      drain triggers the nudge again.
   *
   * The notifications outbox is the side-effect surface — the job
   * enqueues a row per delivery channel via the existing pipeline, and
   * the test inspects the resulting `notifications_outbox` rows
   * directly so we don't need to spin up the drain worker.
   */

  async function setupActiveUser(remaining: number): Promise<string> {
    const userId = makeUserId();
    const result = await mfa.setupTotp(userId, `${userId}@example.com`);
    authenticator.options = { window: 1, step: 30 };
    await mfa.verifyTotpAndActivate(userId, authenticator.generate(result.secret));
    if (remaining < 10) {
      // Truncate the backup-code array directly so we don't have to
      // round-trip through hashBackupCode + consumeBackupCode for each
      // entry. The exact hash values aren't observed by the nudge.
      await db.execute(sql`
        UPDATE mfa_enrollments
           SET backup_codes_hashed = backup_codes_hashed[1:${remaining}],
               last_low_backup_codes_nudge_threshold = NULL,
               updated_at = now()
         WHERE user_id = ${userId};
      `);
    }
    // Drop the activation-confirmation outbox row that
    // `verifyTotpAndActivate` enqueues so the nudge tests below can
    // continue to assert on a clean outbox slate. The activation
    // email itself has dedicated coverage in the "activation email"
    // describe block.
    await db.execute(sql`
      DELETE FROM notifications_outbox
       WHERE user_id = ${userId} AND event_type = 'mfa_activated';
    `);
    return userId;
  }

  async function outboxRowsFor(userId: string): Promise<
    { event_type: string; channel: string; payload: Record<string, unknown> }[]
  > {
    const r = await db.execute<{
      event_type: string;
      channel: string;
      payload: Record<string, unknown>;
    }>(sql`
      SELECT event_type, channel, payload
        FROM notifications_outbox
       WHERE user_id = ${userId}
       ORDER BY created_at ASC;
    `);
    return r.rows;
  }

  it("nudgeLowBackupCodes leaves users with >= threshold codes untouched", async () => {
    const fineUser = await setupActiveUser(7);
    const result = await mfa.nudgeLowBackupCodes();
    expect(result.emailed).toBe(0);
    expect(await outboxRowsFor(fineUser)).toHaveLength(0);
    const row = await db.execute<{ last: string | null }>(sql`
      SELECT last_low_backup_codes_nudge_threshold AS last
        FROM mfa_enrollments WHERE user_id = ${fineUser};
    `);
    expect(row.rows[0]!.last).toBeNull();
  });

  it("nudgeLowBackupCodes emails a low user exactly once across repeated ticks", async () => {
    const lowUser = await setupActiveUser(2);

    const first = await mfa.nudgeLowBackupCodes();
    expect(first.emailed).toBeGreaterThanOrEqual(1);

    const rowsAfterFirst = await outboxRowsFor(lowUser);
    expect(rowsAfterFirst).toHaveLength(1);
    expect(rowsAfterFirst[0]!.event_type).toBe("mfa_backup_codes_low");
    expect(rowsAfterFirst[0]!.channel).toBe("email");
    const payload = rowsAfterFirst[0]!.payload as Record<string, unknown>;
    expect(payload.threshold).toBe("low");
    expect(payload.remaining).toBe(2);
    expect(String(payload.url)).toBe("/account/security");
    expect(String(payload.title)).toMatch(/running low/i);

    const stamped = await db.execute<{ last: string | null }>(sql`
      SELECT last_low_backup_codes_nudge_threshold AS last
        FROM mfa_enrollments WHERE user_id = ${lowUser};
    `);
    expect(stamped.rows[0]!.last).toBe("low");

    // Subsequent ticks while the user is still at "low" must be a no-op.
    await mfa.nudgeLowBackupCodes();
    await mfa.nudgeLowBackupCodes();
    expect(await outboxRowsFor(lowUser)).toHaveLength(1);
  });

  it("nudgeLowBackupCodes escalates to a fresh 'empty' email after a prior 'low' nudge", async () => {
    const u = await setupActiveUser(2);
    await mfa.nudgeLowBackupCodes();
    expect((await outboxRowsFor(u)).filter((r) => (r.payload as { threshold?: string }).threshold === "low"))
      .toHaveLength(1);

    // Drain the rest of the codes — now the user is at zero.
    await db.execute(sql`
      UPDATE mfa_enrollments SET backup_codes_hashed = ARRAY[]::text[]
       WHERE user_id = ${u};
    `);

    const second = await mfa.nudgeLowBackupCodes();
    expect(second.emailed).toBeGreaterThanOrEqual(1);

    const rows = await outboxRowsFor(u);
    expect(rows).toHaveLength(2);
    const last = rows[1]!;
    const lastPayload = last.payload as Record<string, unknown>;
    expect(lastPayload.threshold).toBe("empty");
    expect(lastPayload.remaining).toBe(0);
    expect(String(lastPayload.title)).toMatch(/out of/i);

    const stamped = await db.execute<{ last: string | null }>(sql`
      SELECT last_low_backup_codes_nudge_threshold AS last
        FROM mfa_enrollments WHERE user_id = ${u};
    `);
    expect(stamped.rows[0]!.last).toBe("empty");

    // A third tick at empty must NOT enqueue another row.
    await mfa.nudgeLowBackupCodes();
    expect(await outboxRowsFor(u)).toHaveLength(2);
  });

  it("regenerateBackupCodes clears the nudge marker so a future drain re-emails", async () => {
    const u = await setupActiveUser(1);
    await mfa.nudgeLowBackupCodes();
    const lowRowsAfterFirst = (await outboxRowsFor(u)).filter(
      (r) => r.event_type === "mfa_backup_codes_low",
    );
    expect(lowRowsAfterFirst).toHaveLength(1);

    const regenerated = await mfa.regenerateBackupCodes(u);
    expect(regenerated).not.toBeNull();
    expect(regenerated).toHaveLength(10);

    const cleared = await db.execute<{ last: string | null; remaining: number }>(sql`
      SELECT last_low_backup_codes_nudge_threshold AS last,
             COALESCE(array_length(backup_codes_hashed, 1), 0) AS remaining
        FROM mfa_enrollments WHERE user_id = ${u};
    `);
    expect(cleared.rows[0]!.last).toBeNull();
    expect(Number(cleared.rows[0]!.remaining)).toBe(10);

    // Nothing should fire while the user is back above the threshold —
    // filter to the low-codes event so the regeneration confirmation
    // email (a separate event_type, asserted independently below)
    // doesn't pollute the count.
    await mfa.nudgeLowBackupCodes();
    expect(
      (await outboxRowsFor(u)).filter(
        (r) => r.event_type === "mfa_backup_codes_low",
      ),
    ).toHaveLength(1);

    // Drain again and re-run — a fresh "low" email is expected because
    // the marker was cleared by regeneration.
    await db.execute(sql`
      UPDATE mfa_enrollments SET backup_codes_hashed = backup_codes_hashed[1:1]
       WHERE user_id = ${u};
    `);
    await mfa.nudgeLowBackupCodes();
    const lowRowsFinal = (await outboxRowsFor(u)).filter(
      (r) => r.event_type === "mfa_backup_codes_low",
    );
    expect(lowRowsFinal).toHaveLength(2);
    expect((lowRowsFinal[1]!.payload as { threshold?: string }).threshold).toBe(
      "low",
    );
  });

  /*
   * --- Enrolment + regenerate confirmation emails ---
   *
   * `verifyTotpAndActivate` sends a one-time confirmation email when a
   * seller successfully turns on TOTP, and `regenerateBackupCodes`
   * sends a per-event audit email each time a fresh sheet is minted.
   * The activation email MUST NOT re-send when a user re-runs setup
   * on the same device (a common UX path), but a real disable +
   * fresh enrolment SHOULD send a new confirmation. The regenerate
   * email always fires, by design.
   */

  it("verifyTotpAndActivate enqueues a confirmation email exactly once per active enrolment", async () => {
    const userId = makeUserId();
    const setup = await mfa.setupTotp(userId, `${userId}@example.com`);
    authenticator.options = { window: 1, step: 30 };
    const ok = await mfa.verifyTotpAndActivate(
      userId,
      authenticator.generate(setup.secret),
    );
    expect(ok).toBe(true);

    const rows = await db.execute<{
      event_type: string;
      channel: string;
      payload: Record<string, unknown>;
    }>(sql`
      SELECT event_type, channel, payload
        FROM notifications_outbox
       WHERE user_id = ${userId} AND event_type = 'mfa_activated';
    `);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.channel).toBe("email");
    const payload = rows.rows[0]!.payload as Record<string, unknown>;
    expect(String(payload.url)).toBe("/account/security");
    expect(String(payload.title)).toMatch(/two-factor/i);
    expect(String(payload.body)).toMatch(/backup codes/i);

    // Marker stamped so a re-activation will not re-send.
    const stamped = await db.execute<{ sent_at: Date | null }>(sql`
      SELECT activation_email_sent_at AS sent_at
        FROM mfa_enrollments WHERE user_id = ${userId};
    `);
    expect(stamped.rows[0]!.sent_at).not.toBeNull();
  });

  it("verifyTotpAndActivate does NOT re-send the confirmation when a user re-enrols on the same device", async () => {
    const userId = makeUserId();
    // First enrolment + activate — sends one confirmation email.
    const first = await mfa.setupTotp(userId, `${userId}@example.com`);
    authenticator.options = { window: 1, step: 30 };
    await mfa.verifyTotpAndActivate(
      userId,
      authenticator.generate(first.secret),
    );

    // User re-runs setup on the same device (e.g. lost the QR before
    // saving the backup codes and started the flow again). The UPSERT
    // in `setupTotp` flips status back to `pending` with a fresh
    // secret, but the row's `activation_email_sent_at` marker is
    // preserved so the next activation does not re-send.
    const second = await mfa.setupTotp(userId, `${userId}@example.com`);
    const ok = await mfa.verifyTotpAndActivate(
      userId,
      authenticator.generate(second.secret),
    );
    expect(ok).toBe(true);

    const rows = await db.execute<{ id: string }>(sql`
      SELECT id FROM notifications_outbox
       WHERE user_id = ${userId} AND event_type = 'mfa_activated';
    `);
    expect(rows.rows).toHaveLength(1);
  });

  it("disableMfa + fresh enrolment sends a new activation confirmation email", async () => {
    const userId = makeUserId();
    const first = await mfa.setupTotp(userId, `${userId}@example.com`);
    authenticator.options = { window: 1, step: 30 };
    await mfa.verifyTotpAndActivate(
      userId,
      authenticator.generate(first.secret),
    );
    expect(
      (
        await db.execute<{ id: string }>(sql`
          SELECT id FROM notifications_outbox
           WHERE user_id = ${userId} AND event_type = 'mfa_activated';
        `)
      ).rows,
    ).toHaveLength(1);

    // Tear-down + brand-new enrolment — disableMfa drops the row, so
    // the marker goes with it and a follow-up activation rightly
    // counts as a "first activation" for the new factor.
    await mfa.disableMfa(userId);
    const second = await mfa.setupTotp(userId, `${userId}@example.com`);
    await mfa.verifyTotpAndActivate(
      userId,
      authenticator.generate(second.secret),
    );

    const rows = await db.execute<{ id: string }>(sql`
      SELECT id FROM notifications_outbox
       WHERE user_id = ${userId} AND event_type = 'mfa_activated';
    `);
    expect(rows.rows).toHaveLength(2);
  });

  it("regenerateBackupCodes enqueues a confirmation email each time the sheet is refreshed", async () => {
    const userId = makeUserId();
    const setup = await mfa.setupTotp(userId, `${userId}@example.com`);
    authenticator.options = { window: 1, step: 30 };
    await mfa.verifyTotpAndActivate(
      userId,
      authenticator.generate(setup.secret),
    );

    const codes1 = await mfa.regenerateBackupCodes(userId);
    expect(codes1).not.toBeNull();
    const codes2 = await mfa.regenerateBackupCodes(userId);
    expect(codes2).not.toBeNull();

    const rows = await db.execute<{
      event_type: string;
      channel: string;
      payload: Record<string, unknown>;
    }>(sql`
      SELECT event_type, channel, payload
        FROM notifications_outbox
       WHERE user_id = ${userId}
         AND event_type = 'mfa_backup_codes_regenerated'
       ORDER BY created_at ASC;
    `);
    expect(rows.rows).toHaveLength(2);
    for (const r of rows.rows) {
      expect(r.channel).toBe("email");
      const p = r.payload as Record<string, unknown>;
      expect(String(p.url)).toBe("/account/security");
      expect(String(p.title)).toMatch(/refreshed/i);
    }
  });

  it("regenerateBackupCodes returns null and enqueues nothing when the user has no active enrolment", async () => {
    const userId = makeUserId();
    // No setup at all — regenerate must short-circuit cleanly.
    const result = await mfa.regenerateBackupCodes(userId);
    expect(result).toBeNull();

    const rows = await db.execute<{ id: string }>(sql`
      SELECT id FROM notifications_outbox
       WHERE user_id = ${userId}
         AND event_type = 'mfa_backup_codes_regenerated';
    `);
    expect(rows.rows).toHaveLength(0);
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
