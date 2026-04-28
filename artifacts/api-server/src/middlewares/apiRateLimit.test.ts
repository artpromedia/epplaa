import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import RedisMock from "ioredis-mock";

const sentryCalls = {
  exceptions: [] as Array<{ err: unknown; options?: unknown }>,
  messages: [] as Array<{ message: string; options?: unknown }>,
};

vi.mock("../lib/sentry", () => ({
  captureException: (err: unknown, options?: unknown) => {
    sentryCalls.exceptions.push({ err, options });
  },
  captureMessage: (message: string, options?: unknown) => {
    sentryCalls.messages.push({ message, options });
  },
  initSentryServer: () => {},
}));

import { __test__, getRateLimitStoreKind } from "./apiRateLimit";

beforeEach(() => {
  sentryCalls.exceptions.length = 0;
  sentryCalls.messages.length = 0;
});

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

describe("getRateLimitStoreKind", () => {
  it("matches the active store implementation", () => {
    const expected = __test__.store instanceof __test__.RedisStore ? "redis" : "memory";
    expect(getRateLimitStoreKind()).toBe(expected);
  });

  it("InMemoryStore reports kind=memory", () => {
    expect(new __test__.InMemoryStore().kind).toBe("memory");
  });

  it("RedisStore reports kind=redis", () => {
    const r = new RedisMock();
    const s = new __test__.RedisStore(r as never);
    expect(s.kind).toBe("redis");
    void r.quit();
  });
});

describe("RedisFailureWatcher Sentry forwarding", () => {
  it("forwards every failure to Sentry with subsystem+kind tags", () => {
    const watcher = new __test__.RedisFailureWatcher({ threshold: 999, cooldownMs: 60_000 });
    const err = new Error("boom");
    watcher.record("rate_limit_redis_bump_failed", err, 1_000_000);
    watcher.record("rate_limit_redis_client_error", err, 1_000_100);
    expect(sentryCalls.exceptions).toHaveLength(2);
    const first = sentryCalls.exceptions[0]!.options as {
      tags: Record<string, string>;
      level: string;
    };
    expect(first.tags).toEqual({
      subsystem: "rate_limit",
      kind: "rate_limit_redis_bump_failed",
    });
    expect(first.level).toBe("error");
    const second = sentryCalls.exceptions[1]!.options as {
      tags: Record<string, string>;
    };
    expect(second.tags.kind).toBe("rate_limit_redis_client_error");
  });

  it("emits a fatal captureMessage once the threshold is crossed", () => {
    const watcher = new __test__.RedisFailureWatcher({ threshold: 3, cooldownMs: 60_000 });
    const t0 = 2_000_000;
    for (let i = 0; i < 2; i++) {
      watcher.record("rate_limit_redis_bump_failed", new Error("x"), t0 + i);
    }
    // Below threshold: per-failure exceptions but no breach message yet.
    expect(sentryCalls.messages).toHaveLength(0);
    watcher.record("rate_limit_redis_bump_failed", new Error("x"), t0 + 2);
    expect(sentryCalls.messages).toHaveLength(1);
    const msg = sentryCalls.messages[0]!;
    expect(msg.message).toBe("rate_limit_redis_failure_threshold_breached");
    const opts = msg.options as {
      level: string;
      tags: Record<string, string>;
      fingerprint: string[];
      extra: Record<string, unknown>;
    };
    expect(opts.level).toBe("fatal");
    expect(opts.tags).toEqual({
      subsystem: "rate_limit",
      alert: "rate_limit_store_degraded",
    });
    expect(opts.fingerprint).toEqual(["rate-limit-redis-failure-threshold"]);
    expect(opts.extra).toMatchObject({ count: 3, threshold: 3, windowSeconds: 60 });
  });

  it("throttles repeat breaches until the cooldown elapses", () => {
    const watcher = new __test__.RedisFailureWatcher({ threshold: 2, cooldownMs: 60_000 });
    const t0 = 3_000_000;
    watcher.record("rate_limit_redis_bump_failed", new Error("x"), t0);
    watcher.record("rate_limit_redis_bump_failed", new Error("x"), t0 + 1);
    expect(sentryCalls.messages).toHaveLength(1);
    // More failures inside the cooldown window: no additional breach event.
    watcher.record("rate_limit_redis_bump_failed", new Error("x"), t0 + 2);
    watcher.record("rate_limit_redis_bump_failed", new Error("x"), t0 + 3);
    expect(sentryCalls.messages).toHaveLength(1);
    // After the cooldown elapses and there are still threshold-many fresh
    // failures in the rolling minute, a second breach event fires.
    watcher.record("rate_limit_redis_bump_failed", new Error("x"), t0 + 60_001);
    watcher.record("rate_limit_redis_bump_failed", new Error("x"), t0 + 60_002);
    expect(sentryCalls.messages).toHaveLength(2);
  });

  it("forgets failures older than the rolling 60s window", () => {
    const watcher = new __test__.RedisFailureWatcher({ threshold: 3, cooldownMs: 60_000 });
    const t0 = 4_000_000;
    watcher.record("rate_limit_redis_bump_failed", new Error("x"), t0);
    watcher.record("rate_limit_redis_bump_failed", new Error("x"), t0 + 1);
    // 61 seconds later — earlier hits have aged out, so threshold is not
    // crossed by a single new failure.
    watcher.record("rate_limit_redis_bump_failed", new Error("x"), t0 + 61_000);
    expect(sentryCalls.messages).toHaveLength(0);
  });
});

describe("RedisStore.bump degrades open and notifies on Lua failure", () => {
  it("returns allowed=true and records a Sentry exception when Redis throws", async () => {
    const fakeRedis = {
      defineCommand: () => {},
      rateLimitBump: async () => {
        throw new Error("simulated NOSCRIPT");
      },
    };
    __test__.redisFailureWatcher.__reset();
    const store = new __test__.RedisStore(fakeRedis as never);
    const r = await store.bump("k", Date.now(), 1000, 5);
    expect(r.allowed).toBe(true);
    expect(r.retryAfterMs).toBe(0);
    expect(sentryCalls.exceptions).toHaveLength(1);
    const opts = sentryCalls.exceptions[0]!.options as {
      tags: Record<string, string>;
    };
    expect(opts.tags.kind).toBe("rate_limit_redis_bump_failed");
  });
});
