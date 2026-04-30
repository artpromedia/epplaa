import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import crypto from "node:crypto";

/**
 * Integration test for the trending-streams recommender against a real
 * Postgres. This locks down the contract that Task #26 wired up:
 *
 *   1. The live presence service bumps the `current_viewers` /
 *      `peak_viewers` integer columns (peak is monotonic).
 *   2. `trendingStreams()` reads those integer columns and ranks live
 *      streams by a viewer-weighted score.
 *   3. The cache TTL behaves predictably: subsequent calls within
 *      TRENDING_TTL_MS return cached results; `invalidateTrendingCache()`
 *      forces an immediate recompute.
 *
 * Skips itself when DATABASE_URL is not configured so the suite stays
 * green on local boxes without Postgres. Clean up its own rows so it
 * does not pollute shared dev data.
 */

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const TEST_STREAM_PREFIX = "test-rec-int-";

d("trending-streams + presence integration", () => {
  type Db = typeof import("./db")["db"];
  type Sql = typeof import("drizzle-orm")["sql"];
  type Recommender = typeof import("./recommender");
  type Socket = typeof import("./socket");

  let db: Db;
  let sql: Sql;
  let recommender: Recommender;
  let socketLib: Socket;

  function makeStreamId(): string {
    return `${TEST_STREAM_PREFIX}${crypto.randomBytes(8).toString("hex")}`;
  }

  async function cleanup(): Promise<void> {
    await db.execute(
      sql`DELETE FROM streams WHERE id LIKE ${TEST_STREAM_PREFIX + "%"};`,
    );
  }

  async function insertLiveStream(opts: {
    id: string;
    currentViewers?: number;
    peakViewers?: number;
    startedMinutesAgo?: number;
    title?: string;
  }): Promise<void> {
    const startedAtIso = new Date(
      Date.now() - (opts.startedMinutesAgo ?? 5) * 60_000,
    ).toISOString();
    await db.execute(sql`
      INSERT INTO streams (
        id, host_name, title, status, is_live,
        current_viewers, peak_viewers, started_at
      ) VALUES (
        ${opts.id},
        ${"host-" + opts.id.slice(-6)},
        ${opts.title ?? "test stream"},
        ${"live"},
        ${true},
        ${opts.currentViewers ?? 0},
        ${opts.peakViewers ?? 0},
        ${startedAtIso}::timestamptz
      );
    `);
  }

  beforeAll(async () => {
    ({ db } = await import("./db"));
    ({ sql } = await import("drizzle-orm"));
    recommender = await import("./recommender");
    socketLib = await import("./socket");
    await cleanup();
  }, 30_000);

  afterEach(async () => {
    recommender.invalidateTrendingCache();
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("ranks live streams by current_viewers (viewer-weighted score, not flat)", async () => {
    const hot = makeStreamId();
    const warm = makeStreamId();
    const cold = makeStreamId();
    await insertLiveStream({ id: hot, currentViewers: 500, peakViewers: 500, startedMinutesAgo: 5 });
    await insertLiveStream({ id: warm, currentViewers: 50, peakViewers: 80, startedMinutesAgo: 5 });
    await insertLiveStream({ id: cold, currentViewers: 0, peakViewers: 0, startedMinutesAgo: 5 });

    recommender.invalidateTrendingCache();
    const ranked = await recommender.trendingStreams(50);

    const ids = ranked.map((r) => r.id);
    const hotIdx = ids.indexOf(hot);
    const warmIdx = ids.indexOf(warm);
    const coldIdx = ids.indexOf(cold);

    expect(hotIdx).toBeGreaterThanOrEqual(0);
    expect(warmIdx).toBeGreaterThanOrEqual(0);
    expect(coldIdx).toBeGreaterThanOrEqual(0);
    expect(hotIdx).toBeLessThan(warmIdx);
    expect(warmIdx).toBeLessThan(coldIdx);

    const hotScore = ranked[hotIdx]!.score;
    const warmScore = ranked[warmIdx]!.score;
    const coldScore = ranked[coldIdx]!.score;
    // Three live streams must not tie at the same score — that was the
    // pre-Task-#26 bug where every live stream scored identically because
    // current_viewers was always 0.
    expect(hotScore).toBeGreaterThan(warmScore);
    expect(warmScore).toBeGreaterThan(coldScore);
  });

  it("decays score with age: a younger live stream beats an older one at the same viewer count", async () => {
    const fresh = makeStreamId();
    const stale = makeStreamId();
    await insertLiveStream({ id: fresh, currentViewers: 100, peakViewers: 100, startedMinutesAgo: 1 });
    await insertLiveStream({ id: stale, currentViewers: 100, peakViewers: 100, startedMinutesAgo: 120 });

    recommender.invalidateTrendingCache();
    const ranked = await recommender.trendingStreams(50);
    const freshRow = ranked.find((r) => r.id === fresh);
    const staleRow = ranked.find((r) => r.id === stale);
    expect(freshRow).toBeDefined();
    expect(staleRow).toBeDefined();
    expect(freshRow!.score).toBeGreaterThan(staleRow!.score);
  });

  it("caches results within TRENDING_TTL_MS and refreshes after invalidate", async () => {
    const id = makeStreamId();
    await insertLiveStream({ id, currentViewers: 10, peakViewers: 10 });
    recommender.invalidateTrendingCache();

    const first = await recommender.trendingStreams(50);
    const firstRow = first.find((r) => r.id === id);
    expect(firstRow).toBeDefined();
    expect(firstRow!.currentViewers).toBe(10);

    // Mutate the row directly: a cached read must still see the old value.
    await db.execute(
      sql`UPDATE streams SET current_viewers = 999 WHERE id = ${id};`,
    );
    const cached = await recommender.trendingStreams(50);
    const cachedRow = cached.find((r) => r.id === id);
    expect(cachedRow!.currentViewers).toBe(10);

    // After invalidate, the next call must reflect the new viewer count.
    recommender.invalidateTrendingCache();
    const fresh = await recommender.trendingStreams(50);
    const freshRow = fresh.find((r) => r.id === id);
    expect(freshRow!.currentViewers).toBe(999);
  });

  it("applyPresenceUpdate('join') writes current_viewers and bumps peak_viewers monotonically", async () => {
    const id = makeStreamId();
    await insertLiveStream({ id, currentViewers: 0, peakViewers: 0 });

    await socketLib.applyPresenceUpdate(id, 7, "join");
    let row = await db.execute<{ current_viewers: number; peak_viewers: number }>(
      sql`SELECT current_viewers, peak_viewers FROM streams WHERE id = ${id};`,
    );
    expect(Number(row.rows[0]!.current_viewers)).toBe(7);
    expect(Number(row.rows[0]!.peak_viewers)).toBe(7);

    // current goes UP, peak follows.
    await socketLib.applyPresenceUpdate(id, 12, "join");
    row = await db.execute<{ current_viewers: number; peak_viewers: number }>(
      sql`SELECT current_viewers, peak_viewers FROM streams WHERE id = ${id};`,
    );
    expect(Number(row.rows[0]!.current_viewers)).toBe(12);
    expect(Number(row.rows[0]!.peak_viewers)).toBe(12);

    // current goes DOWN (e.g. a viewer left and another joined immediately
    // after, recomputing room.size), peak must NOT decrease.
    await socketLib.applyPresenceUpdate(id, 4, "join");
    row = await db.execute<{ current_viewers: number; peak_viewers: number }>(
      sql`SELECT current_viewers, peak_viewers FROM streams WHERE id = ${id};`,
    );
    expect(Number(row.rows[0]!.current_viewers)).toBe(4);
    expect(Number(row.rows[0]!.peak_viewers)).toBe(12);
  });

  it("applyPresenceUpdate('leave') writes current_viewers without touching peak_viewers", async () => {
    const id = makeStreamId();
    await insertLiveStream({ id, currentViewers: 20, peakViewers: 50 });

    await socketLib.applyPresenceUpdate(id, 19, "leave");
    let row = await db.execute<{ current_viewers: number; peak_viewers: number }>(
      sql`SELECT current_viewers, peak_viewers FROM streams WHERE id = ${id};`,
    );
    expect(Number(row.rows[0]!.current_viewers)).toBe(19);
    expect(Number(row.rows[0]!.peak_viewers)).toBe(50);

    await socketLib.applyPresenceUpdate(id, 0, "leave");
    row = await db.execute<{ current_viewers: number; peak_viewers: number }>(
      sql`SELECT current_viewers, peak_viewers FROM streams WHERE id = ${id};`,
    );
    expect(Number(row.rows[0]!.current_viewers)).toBe(0);
    expect(Number(row.rows[0]!.peak_viewers)).toBe(50);
  });

  it("trending feeds back the integer columns set by applyPresenceUpdate", async () => {
    const a = makeStreamId();
    const b = makeStreamId();
    await insertLiveStream({ id: a, currentViewers: 0, peakViewers: 0, startedMinutesAgo: 2 });
    await insertLiveStream({ id: b, currentViewers: 0, peakViewers: 0, startedMinutesAgo: 2 });

    // Drive presence: A gets a viewer surge, B stays empty.
    await socketLib.applyPresenceUpdate(a, 200, "join");
    await socketLib.applyPresenceUpdate(b, 1, "join");

    recommender.invalidateTrendingCache();
    const ranked = await recommender.trendingStreams(50);
    const aIdx = ranked.findIndex((r) => r.id === a);
    const bIdx = ranked.findIndex((r) => r.id === b);
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeGreaterThanOrEqual(0);
    expect(aIdx).toBeLessThan(bIdx);
    expect(ranked[aIdx]!.currentViewers).toBe(200);
    expect(ranked[aIdx]!.peakViewers).toBe(200);
  });
});
