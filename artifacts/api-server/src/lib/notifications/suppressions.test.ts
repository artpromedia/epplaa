import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";

/**
 * Suppression-list contract for transactional email (task #141).
 *
 * The suppression list is the durable guard that protects sender
 * reputation and NDPR-deleted users from continued mailing. The
 * invariants we need to keep working as the email pipeline evolves:
 *
 *   1. `isEmailSuppressed` is case- and whitespace-insensitive — a
 *      bounce on `Foo@Example.com` must suppress later sends to
 *      `foo@example.com`.
 *
 *   2. `suppressEmail` is idempotent. Re-running an erase or a bounce
 *      never throws and never overwrites the originally-recorded
 *      reason (the unique index on `email` enforces this).
 *
 *   3. `classifyEmailErrorForSuppression` recognises Postmark code
 *      `406` as `inactive_recipient` and SendGrid HTTP `5xx` as
 *      `hard_bounce`, while leaving transient errors (network
 *      `exception`, unknown codes, generic 4xx) un-classified so the
 *      outbox keeps retrying.
 *
 *   4. `suppressUserEmail` records the user's CURRENT email and
 *      refuses to record the `<id>@erased.invalid` placeholder NDPR
 *      writes during anonymisation (otherwise a re-run of erase would
 *      pollute the table with non-deliverable placeholders).
 *
 * Skips when DATABASE_URL is unset so local boxes without Postgres
 * can still run the rest of the suite.
 */
const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

const TEST_PREFIX = "test_supp_";

d("notification suppressions library", () => {
  type Db = typeof import("../db")["db"];
  type Schema = typeof import("../db")["schema"];
  type Sql = typeof import("drizzle-orm")["sql"];
  type Eq = typeof import("drizzle-orm")["eq"];
  type Suppressions = typeof import("./suppressions");

  let db: Db;
  let schema: Schema;
  let sql: Sql;
  let eq: Eq;
  let supp: Suppressions;

  function makeEmail(): string {
    return `${TEST_PREFIX}${crypto.randomBytes(6).toString("hex")}@example.com`;
  }

  function makeUserId(): string {
    return `${TEST_PREFIX}user_${crypto.randomBytes(6).toString("hex")}`;
  }

  async function cleanup(): Promise<void> {
    await db.execute(
      sql`DELETE FROM notification_suppressions WHERE email LIKE ${TEST_PREFIX + "%"};`,
    );
    await db.execute(
      sql`DELETE FROM users WHERE clerk_id LIKE ${TEST_PREFIX + "%"};`,
    );
  }

  beforeAll(async () => {
    ({ db, schema } = await import("../db"));
    ({ sql, eq } = await import("drizzle-orm"));
    supp = await import("./suppressions");
    await cleanup();
  }, 30_000);

  afterEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("normaliseEmail lowercases and trims", () => {
    expect(supp.normaliseEmail("  Foo@Example.COM  ")).toBe("foo@example.com");
    expect(supp.normaliseEmail("")).toBe("");
  });

  it("isEmailSuppressed is false for a fresh address and true after suppressEmail (case-insensitive)", async () => {
    const email = makeEmail();
    expect(await supp.isEmailSuppressed(email)).toBe(false);
    await supp.suppressEmail({ email, reason: "hard_bounce", source: "postmark" });
    // Lookup with mixed case + whitespace must still hit.
    expect(await supp.isEmailSuppressed(`  ${email.toUpperCase()}  `)).toBe(true);
  });

  it("suppressEmail is idempotent — second call does not throw and keeps the first reason", async () => {
    const email = makeEmail();
    await supp.suppressEmail({ email, reason: "account_deleted", source: "ndpr" });
    // Re-suppressing with a different reason must not overwrite — the
    // unique index on `email` short-circuits the second insert.
    await expect(
      supp.suppressEmail({ email, reason: "hard_bounce", source: "postmark" }),
    ).resolves.toBeUndefined();
    const rows = await db
      .select()
      .from(schema.notificationSuppressionsTable)
      .where(eq(schema.notificationSuppressionsTable.email, email.toLowerCase()));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe("account_deleted");
    expect(rows[0]?.source).toBe("ndpr");
  });

  it("classifyEmailErrorForSuppression maps Postmark 406 → inactive_recipient", () => {
    expect(supp.classifyEmailErrorForSuppression("postmark", "406")).toBe("inactive_recipient");
    // Transient/unknown Postmark errors do NOT suppress.
    expect(supp.classifyEmailErrorForSuppression("postmark", "500")).toBeNull();
    expect(supp.classifyEmailErrorForSuppression("postmark", "exception")).toBeNull();
    expect(supp.classifyEmailErrorForSuppression("postmark", undefined)).toBeNull();
  });

  it("classifyEmailErrorForSuppression maps SendGrid 5xx → hard_bounce, ignores 4xx and exceptions", () => {
    expect(supp.classifyEmailErrorForSuppression("sendgrid", "500")).toBe("hard_bounce");
    expect(supp.classifyEmailErrorForSuppression("sendgrid", "503")).toBe("hard_bounce");
    // 4xx are validation errors / auth issues, not bounce signal.
    expect(supp.classifyEmailErrorForSuppression("sendgrid", "400")).toBeNull();
    expect(supp.classifyEmailErrorForSuppression("sendgrid", "401")).toBeNull();
    expect(supp.classifyEmailErrorForSuppression("sendgrid", "exception")).toBeNull();
  });

  it("classifyEmailErrorForSuppression returns null for unknown providers (defensive default)", () => {
    expect(supp.classifyEmailErrorForSuppression("mystery", "406")).toBeNull();
    expect(supp.classifyEmailErrorForSuppression(undefined, "406")).toBeNull();
  });

  it("suppressUserEmail records the user's current email and refuses placeholders", async () => {
    const userId = makeUserId();
    const email = makeEmail();
    await db.insert(schema.usersTable).values({ clerkId: userId, email });
    const recorded = await supp.suppressUserEmail(userId, "account_deleted", "ndpr");
    expect(recorded).toBe(email.toLowerCase());
    expect(await supp.isEmailSuppressed(email)).toBe(true);

    // Anonymise as applyErase would (placeholder address) and re-run.
    // The placeholder must NOT be added — we don't want a long tail of
    // `<id>@erased.invalid` rows that can never bounce or matter.
    await db
      .update(schema.usersTable)
      .set({ email: `erased_${userId.slice(-6)}@erased.invalid` })
      .where(eq(schema.usersTable.clerkId, userId));
    const recordedAfter = await supp.suppressUserEmail(userId, "account_deleted", "ndpr");
    expect(recordedAfter).toBeNull();
    const rows = await db
      .select()
      .from(schema.notificationSuppressionsTable)
      .where(eq(schema.notificationSuppressionsTable.email, email.toLowerCase()));
    // Still one — the placeholder did not insert a second row.
    expect(rows).toHaveLength(1);
  });

  it("suppressUserEmail returns null when the user has no email or does not exist", async () => {
    expect(await supp.suppressUserEmail(`${TEST_PREFIX}ghost`, "account_deleted", "ndpr")).toBeNull();
    const userId = makeUserId();
    await db.insert(schema.usersTable).values({ clerkId: userId, email: "" });
    expect(await supp.suppressUserEmail(userId, "account_deleted", "ndpr")).toBeNull();
  });
});
