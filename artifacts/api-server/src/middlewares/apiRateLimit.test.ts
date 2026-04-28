import { describe, it, expect, beforeEach, afterEach } from "vitest";
import RedisMock from "ioredis-mock";
import { __test__ } from "./apiRateLimit";

describe("InMemoryStore bucket exhaustion", () => {
  it("admits up to max within window then 429s", async () => {
    const store = new __test__.InMemoryStore();
    const now = Date.now();
    const out: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      out.push((await store.bump("k", now + i, 1000, 3)).allowed);
    }
    expect(out).toEqual([true, true, true, false, false]);
  });

  it("releases a slot once a hit slides out of the window", async () => {
    const store = new __test__.InMemoryStore();
    const t0 = 1_000_000;
    expect((await store.bump("k", t0, 1000, 1)).allowed).toBe(true);
    expect((await store.bump("k", t0 + 100, 1000, 1)).allowed).toBe(false);
    // Move the clock past the window edge so the prior hit is dropped.
    expect((await store.bump("k", t0 + 1500, 1000, 1)).allowed).toBe(true);
  });

  it("returns a sane Retry-After hint when full", async () => {
    const store = new __test__.InMemoryStore();
    const t0 = 2_000_000;
    await store.bump("k", t0, 1000, 1);
    const r = await store.bump("k", t0 + 200, 1000, 1);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBeGreaterThanOrEqual(800);
    expect(r.retryAfterMs).toBeLessThanOrEqual(1000);
  });
});

/**
 * Parity tests: the RedisStore must behave the same way as InMemoryStore
 * for the same input sequence. We use ioredis-mock as a fakeredis so the
 * Lua script runs end-to-end without needing a real Redis instance in CI.
 */
describe("RedisStore parity with InMemoryStore", () => {
  let redis: InstanceType<typeof RedisMock>;
  let store: InstanceType<typeof __test__.RedisStore>;

  beforeEach(() => {
    redis = new RedisMock();
    store = new __test__.RedisStore(redis as never);
  });

  afterEach(async () => {
    await redis.quit();
  });

  it("admits up to max within window then 429s", async () => {
    const now = 5_000_000;
    const out: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      out.push((await store.bump("k", now + i, 1000, 3)).allowed);
    }
    expect(out).toEqual([true, true, true, false, false]);
  });

  it("releases a slot once a hit slides out of the window", async () => {
    const t0 = 6_000_000;
    expect((await store.bump("k", t0, 1000, 1)).allowed).toBe(true);
    expect((await store.bump("k", t0 + 100, 1000, 1)).allowed).toBe(false);
    expect((await store.bump("k", t0 + 1500, 1000, 1)).allowed).toBe(true);
  });

  it("returns a sane Retry-After hint when full", async () => {
    const t0 = 7_000_000;
    await store.bump("k", t0, 1000, 1);
    const r = await store.bump("k", t0 + 200, 1000, 1);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBeGreaterThanOrEqual(800);
    expect(r.retryAfterMs).toBeLessThanOrEqual(1000);
  });

  it("isolates buckets per key", async () => {
    const t0 = 8_000_000;
    expect((await store.bump("a", t0, 1000, 1)).allowed).toBe(true);
    expect((await store.bump("a", t0 + 1, 1000, 1)).allowed).toBe(false);
    // Different key still has full quota.
    expect((await store.bump("b", t0 + 2, 1000, 1)).allowed).toBe(true);
  });

  it("stays atomic under concurrent bumps at max-1", async () => {
    // Hammer the store with parallel bumps that would each individually
    // see "count == max-1" under a non-atomic implementation. The Lua
    // script guarantees only `max` of them can succeed.
    const t0 = 9_000_000;
    const max = 10;
    const concurrent = 50;
    const results = await Promise.all(
      Array.from({ length: concurrent }, (_, i) =>
        store.bump("hot", t0 + i, 1000, max),
      ),
    );
    const allowed = results.filter((r) => r.allowed).length;
    expect(allowed).toBe(max);
  });

  it("matches InMemoryStore decisions for an identical hit sequence", async () => {
    const mem = new __test__.InMemoryStore();
    const sequence = [0, 10, 20, 30, 40, 1100, 1200, 2500];
    const max = 3;
    const window = 1000;
    const t0 = 10_000_000;

    const memOut: boolean[] = [];
    const redisOut: boolean[] = [];
    for (const off of sequence) {
      memOut.push((await mem.bump("k", t0 + off, window, max)).allowed);
      redisOut.push((await store.bump("k", t0 + off, window, max)).allowed);
    }
    expect(redisOut).toEqual(memOut);
  });
});
