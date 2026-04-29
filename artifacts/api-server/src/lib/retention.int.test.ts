import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import crypto from "node:crypto";

/**
 * Integration test for the rate-limit-events arm of `runRetentionSweep`.
 *
 * The forensic table is bootstrapped via raw `CREATE TABLE IF NOT
 * EXISTS` rather than a Drizzle schema, so we exercise it against a
 * real Postgres to make sure the `DELETE ... WHERE ts < $cutoff`
 * actually trims old rows and leaves recent ones alone. Skips when
 * DATABASE_URL is not configured so the suite stays green on local
 * boxes without a Postgres.
 */

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const TEST_IDENT_PREFIX = "test-rl-retention-";

d("rate_limit_events retention sweep", () => {
  type Db = typeof import("./db")["db"];
  type Sql = typeof import("drizzle-orm")["sql"];
  type Retention = typeof import("./retention");
  type Security = typeof import("./security");

  let db: Db;
  let sql: Sql;
  let retention: Retention;

  async function clearHeartbeats(): Promise<void> {
    await db.execute(sql`DELETE FROM retention_heartbeats;`);
  }

  function makeIdent(): string {
    return `${TEST_IDENT_PREFIX}${crypto.randomBytes(8).toString("hex")}`;
  }

  async function cleanup(): Promise<void> {
    await db.execute(
      sql`DELETE FROM rate_limit_events WHERE identity LIKE ${TEST_IDENT_PREFIX + "%"};`,
    );
  }

  async function insertEvent(
    identity: string,
    tsIso: string,
  ): Promise<string> {
    const id = `rle_test_${crypto.randomBytes(6).toString("hex")}`;
    await db.execute(
      sql`INSERT INTO rate_limit_events (id, identity, route, tier, ts) VALUES (${id}, ${identity}, ${"/test"}, ${"anon"}, ${tsIso}::timestamptz);`,
    );
    return id;
  }

  beforeAll(async () => {
    ({ db } = await import("./db"));
    ({ sql } = await import("drizzle-orm"));
    const security: Security = await import("./security");
    await security.initSecuritySchema();
    retention = await import("./retention");
    // Bootstrap the heartbeat table the same way `app.ts` does on
    // boot. Without this, the first sweep would log a `heartbeat
    // write_failed` warning instead of upserting — and the persisted
    // heartbeat assertion below would have nothing to read.
    await retention.initRetentionSchema();
    await cleanup();
    await clearHeartbeats();
  }, 30_000);

  afterEach(async () => {
    await cleanup();
    await clearHeartbeats();
  });

  afterAll(async () => {
    await cleanup();
    await clearHeartbeats();
  });

  it("removes rows older than the configured window and keeps recent ones", async () => {
    const oldIdent = makeIdent();
    const recentIdent = makeIdent();
    // 91 days old — beyond the 90-day default.
    const oldTs = new Date(Date.now() - 91 * 24 * 3600 * 1000).toISOString();
    // 1 hour old — well within the window.
    const recentTs = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const oldId = await insertEvent(oldIdent, oldTs);
    const recentId = await insertEvent(recentIdent, recentTs);

    const result = await retention.runRetentionSweep();
    expect(result.rateLimitEventsTrimmed).toBeGreaterThanOrEqual(1);

    const surviving = await db.execute(
      sql`SELECT id FROM rate_limit_events WHERE id IN (${oldId}, ${recentId});`,
    );
    const rows =
      (surviving as unknown as { rows?: Array<{ id: string }> }).rows ?? [];
    const survivingIds = rows.map((r) => r.id);
    expect(survivingIds).toContain(recentId);
    expect(survivingIds).not.toContain(oldId);
  }, 30_000);

  it("respects RATE_LIMIT_EVENTS_RETENTION_DAYS override", async () => {
    const ident = makeIdent();
    // 2 days old — would survive the 90-day default but not a 1-day window.
    const ts = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
    const id = await insertEvent(ident, ts);

    const prev = process.env.RATE_LIMIT_EVENTS_RETENTION_DAYS;
    process.env.RATE_LIMIT_EVENTS_RETENTION_DAYS = "1";
    try {
      await retention.runRetentionSweep();
    } finally {
      if (prev === undefined) delete process.env.RATE_LIMIT_EVENTS_RETENTION_DAYS;
      else process.env.RATE_LIMIT_EVENTS_RETENTION_DAYS = prev;
    }

    const surviving = await db.execute(
      sql`SELECT id FROM rate_limit_events WHERE id = ${id};`,
    );
    const rows =
      (surviving as unknown as { rows?: Array<{ id: string }> }).rows ?? [];
    expect(rows).toHaveLength(0);
  }, 30_000);

  it("upserts a heartbeat row per arm + an overall sweep heartbeat after each run", async () => {
    // The whole point of the heartbeat table is that an external
    // alert can ask "when did the daily sweep last successfully run"
    // without grepping logs. We assert both the per-arm rows AND the
    // overall `sweep` row land after a normal invocation, since the
    // /healthz staleness probe consumes only the `sweep` row but
    // dashboards consume the per-arm rows.
    const before = Date.now();
    await retention.runRetentionSweep();
    const after = Date.now();

    const result = await db.execute(
      sql`SELECT arm, last_run_at, last_count, last_error FROM retention_heartbeats ORDER BY arm;`,
    );
    const rows =
      (result as unknown as {
        rows?: Array<{
          arm: string;
          last_run_at: string | Date;
          last_count: number | string;
          last_error: string | null;
        }>;
      }).rows ?? [];
    const arms = rows.map((r) => r.arm);
    // Locking in every arm the sweep is responsible for so a future
    // arm being added (or removed) requires updating both the sweep
    // and this assertion — silent drift here would leave a dashboard
    // gauge frozen on its last value.
    expect(arms.sort()).toEqual([
      "erases",
      "notifications",
      "rate_limit_events",
      "search_history",
      "sweep",
      "view_history",
    ]);
    for (const row of rows) {
      const tsMs =
        row.last_run_at instanceof Date
          ? row.last_run_at.getTime()
          : new Date(row.last_run_at).getTime();
      expect(tsMs).toBeGreaterThanOrEqual(before);
      expect(tsMs).toBeLessThanOrEqual(after + 1_000);
    }

    // Running the sweep a second time MUST upsert (not insert) — the
    // PRIMARY KEY on `arm` would otherwise raise unique-violations
    // and the sweep would silently log them. Re-running and re-asserting
    // proves the ON CONFLICT path.
    await retention.runRetentionSweep();
    const second = await db.execute(
      sql`SELECT count(*)::int as n FROM retention_heartbeats;`,
    );
    const secondRows =
      (second as unknown as { rows?: Array<{ n: number | string }> }).rows ??
      [];
    expect(Number(secondRows[0]?.n)).toBe(6);
  }, 30_000);
});
