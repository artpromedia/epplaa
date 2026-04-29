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

import {
  __test__,
  assertRateLimitStoreConfiguredForProduction,
  getRateLimitStoreKind,
  getRateLimitStoreReadyzStatus,
  getRateLimitStoreStatus,
  pingRateLimitRedis,
} from "./apiRateLimit";

beforeEach(() => {
  sentryCalls.exceptions.length = 0;
  sentryCalls.messages.length = 0;
  // The module-level watcher is shared across cases and now also gets
  // poked by every successful RedisStore.bump (recordSuccess). Reset it
  // so leftover streak/breach state from a prior case can't bleed in.
  __test__.redisFailureWatcher.__reset();
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

describe("RedisFailureWatcher.getSnapshot (used by /healthz)", () => {
  it("reports healthy with zeroed counters when no failure has occurred", () => {
    const watcher = new __test__.RedisFailureWatcher({ threshold: 3, cooldownMs: 60_000 });
    expect(watcher.getSnapshot()).toEqual({
      state: "healthy",
      failureCount: 0,
      firstFailureAt: null,
      lastRecoveredAt: null,
    });
  });

  it("flips to degraded on the very first failure and tracks streak depth", () => {
    const watcher = new __test__.RedisFailureWatcher({ threshold: 5, cooldownMs: 60_000 });
    const t0 = 9_000_000;
    watcher.record("rate_limit_redis_bump_failed", new Error("x"), t0);
    watcher.record("rate_limit_redis_bump_failed", new Error("x"), t0 + 50);
    expect(watcher.getSnapshot()).toEqual({
      state: "degraded",
      failureCount: 2,
      firstFailureAt: t0,
      lastRecoveredAt: null,
    });
  });

  it("returns to healthy and stamps lastRecoveredAt after a streak ends", () => {
    const watcher = new __test__.RedisFailureWatcher({ threshold: 5, cooldownMs: 60_000 });
    const t0 = 9_100_000;
    // Sub-threshold blip — even without a paged alert, /healthz should
    // still record the recovery so dashboards can timeline the blip.
    watcher.record("rate_limit_redis_bump_failed", new Error("x"), t0);
    watcher.recordSuccess(t0 + 200);
    expect(watcher.getSnapshot()).toEqual({
      state: "healthy",
      failureCount: 0,
      firstFailureAt: null,
      lastRecoveredAt: t0 + 200,
    });
  });

  it("preserves the prior lastRecoveredAt while a fresh streak is in progress", () => {
    const watcher = new __test__.RedisFailureWatcher({ threshold: 5, cooldownMs: 60_000 });
    const t0 = 9_200_000;
    watcher.record("rate_limit_redis_bump_failed", new Error("x"), t0);
    watcher.recordSuccess(t0 + 100);
    // Second incident starts.
    watcher.record("rate_limit_redis_bump_failed", new Error("x"), t0 + 1_000);
    const snap = watcher.getSnapshot();
    expect(snap.state).toBe("degraded");
    expect(snap.firstFailureAt).toBe(t0 + 1_000);
    expect(snap.failureCount).toBe(1);
    // The previous recovery timestamp survives so consumers can compute
    // the gap between recoveries / mean time between failures.
    expect(snap.lastRecoveredAt).toBe(t0 + 100);
  });
});

describe("getRateLimitStoreStatus (module-level helper)", () => {
  it("merges store kind with the watcher snapshot", () => {
    __test__.redisFailureWatcher.__reset();
    const status = getRateLimitStoreStatus();
    expect(status).toEqual({
      kind: __test__.store.kind,
      state: "healthy",
      failureCount: 0,
      firstFailureAt: null,
      lastRecoveredAt: null,
    });
  });

  it("reflects watcher state changes live without restart", () => {
    __test__.redisFailureWatcher.__reset();
    const t0 = 9_500_000;
    __test__.redisFailureWatcher.record(
      "rate_limit_redis_bump_failed",
      new Error("x"),
      t0,
    );
    const degraded = getRateLimitStoreStatus();
    expect(degraded.state).toBe("degraded");
    expect(degraded.failureCount).toBe(1);
    expect(degraded.firstFailureAt).toBe(t0);

    __test__.redisFailureWatcher.recordSuccess(t0 + 500);
    const recovered = getRateLimitStoreStatus();
    expect(recovered.state).toBe("healthy");
    expect(recovered.failureCount).toBe(0);
    expect(recovered.firstFailureAt).toBeNull();
    expect(recovered.lastRecoveredAt).toBe(t0 + 500);
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

describe("RedisStore.ping (used by /readyz)", () => {
  it("resolves when redis responds with PONG", async () => {
    const r = new RedisMock();
    const s = new __test__.RedisStore(r as never);
    await expect(s.ping(1000)).resolves.toBeUndefined();
    await r.quit();
  });

  it("rejects with the underlying error when ping throws", async () => {
    const fake = {
      defineCommand: () => {},
      ping: async () => {
        throw new Error("ECONNREFUSED");
      },
    };
    const s = new __test__.RedisStore(fake as never);
    await expect(s.ping(1000)).rejects.toThrow("ECONNREFUSED");
  });

  it("rejects with a timeout error when ping never resolves", async () => {
    const fake = {
      defineCommand: () => {},
      ping: () => new Promise<string>(() => {}),
    };
    const s = new __test__.RedisStore(fake as never);
    await expect(s.ping(50)).rejects.toThrow(/redis_ping_timeout_after_50ms/);
  });

  it("rejects when redis returns an unexpected response", async () => {
    const fake = {
      defineCommand: () => {},
      ping: async () => "not-pong",
    };
    const s = new __test__.RedisStore(fake as never);
    await expect(s.ping(1000)).rejects.toThrow(/unexpected_ping_response/);
  });
});

describe("pingRateLimitRedis (module-level helper)", () => {
  it("returns null when the active store is in-memory", async () => {
    // The default test environment leaves RATE_LIMIT_STORE unset, so the
    // module-level singleton resolved to InMemoryStore at import time.
    // The helper must report `null` so /readyz skips the redis check.
    expect(__test__.store).toBeInstanceOf(__test__.InMemoryStore);
    await expect(pingRateLimitRedis(100)).resolves.toBeNull();
  });
});

describe("RedisFailureWatcher recovery signaling", () => {
  it("emits a paired recovery message after a degradation that paged on-call", () => {
    const watcher = new __test__.RedisFailureWatcher({ threshold: 3, cooldownMs: 60_000 });
    const t0 = 5_500_000;
    // Three failures cross the threshold and emit the degraded alert.
    for (let i = 0; i < 3; i++) {
      watcher.record("rate_limit_redis_bump_failed", new Error("x"), t0 + i * 100);
    }
    expect(sentryCalls.messages).toHaveLength(1);
    expect(sentryCalls.messages[0]!.message).toBe(
      "rate_limit_redis_failure_threshold_breached",
    );

    // First success after the streak emits the recovery signal.
    watcher.recordSuccess(t0 + 5_000);
    expect(sentryCalls.messages).toHaveLength(2);
    const recovery = sentryCalls.messages[1]!;
    expect(recovery.message).toBe("rate_limit_redis_recovered");
    const opts = recovery.options as {
      level: string;
      tags: Record<string, string>;
      fingerprint: string[];
      extra: Record<string, unknown>;
    };
    expect(opts.level).toBe("info");
    expect(opts.tags).toEqual({
      subsystem: "rate_limit",
      alert: "rate_limit_store_recovered",
    });
    expect(opts.fingerprint).toEqual(["rate-limit-redis-recovered"]);
    expect(opts.extra).toMatchObject({ durationMs: 5_000, failureCount: 3 });
  });

  it("stays silent for sub-threshold blips that never paged on-call", () => {
    const watcher = new __test__.RedisFailureWatcher({ threshold: 5, cooldownMs: 60_000 });
    const t0 = 5_600_000;
    watcher.record("rate_limit_redis_bump_failed", new Error("x"), t0);
    watcher.record("rate_limit_redis_bump_failed", new Error("x"), t0 + 1);
    expect(sentryCalls.messages).toHaveLength(0);
    watcher.recordSuccess(t0 + 100);
    // No paired recovery event because no degraded alert ever fired.
    expect(sentryCalls.messages).toHaveLength(0);
  });

  it("re-pages immediately after recovery when failures resume", () => {
    const watcher = new __test__.RedisFailureWatcher({ threshold: 2, cooldownMs: 60_000 });
    const t0 = 5_700_000;
    watcher.record("rate_limit_redis_bump_failed", new Error("x"), t0);
    watcher.record("rate_limit_redis_bump_failed", new Error("x"), t0 + 10);
    expect(sentryCalls.messages).toHaveLength(1);
    watcher.recordSuccess(t0 + 1_000);
    expect(sentryCalls.messages).toHaveLength(2);
    expect(sentryCalls.messages[1]!.message).toBe("rate_limit_redis_recovered");
    // Recovery clears the cooldown gate and the rate-based window still
    // contains the prior failures, so the very next failure re-pages
    // instead of being silenced by leftover within-incident throttling.
    watcher.record("rate_limit_redis_bump_failed", new Error("x"), t0 + 2_000);
    expect(sentryCalls.messages).toHaveLength(3);
    expect(sentryCalls.messages[2]!.message).toBe(
      "rate_limit_redis_failure_threshold_breached",
    );
  });

  it("still pages on a flapping outage where successes interleave with failures", () => {
    // Locks in the rate-based breach detector: even with successes
    // between failures, crossing the rolling-minute threshold must page.
    // (Earlier prototype reset the rolling window on every success and
    // would have silently missed a partial outage like this one.)
    const watcher = new __test__.RedisFailureWatcher({ threshold: 3, cooldownMs: 60_000 });
    const t0 = 5_800_000;
    watcher.record("rate_limit_redis_bump_failed", new Error("x"), t0);
    watcher.recordSuccess(t0 + 100);
    watcher.record("rate_limit_redis_bump_failed", new Error("x"), t0 + 200);
    watcher.recordSuccess(t0 + 300);
    expect(sentryCalls.messages).toHaveLength(0);
    // Third failure inside the rolling 60s window crosses threshold even
    // though two successes have happened in between.
    watcher.record("rate_limit_redis_bump_failed", new Error("x"), t0 + 400);
    expect(sentryCalls.messages).toHaveLength(1);
    expect(sentryCalls.messages[0]!.message).toBe(
      "rate_limit_redis_failure_threshold_breached",
    );
  });
});

describe("RedisStore.bump emits recovery after a failure streak", () => {
  it("notifies on first success after a streak that crossed the alert threshold", async () => {
    let shouldFail = true;
    const fakeRedis = {
      defineCommand: () => {},
      rateLimitBump: async () => {
        if (shouldFail) throw new Error("simulated outage");
        return [1, 0];
      },
    };
    const store = new __test__.RedisStore(fakeRedis as never);
    const threshold = __test__.redisFailureWatcher.thresholdPerMin;
    const t0 = 6_500_000;
    // Drive enough failures to cross the configured threshold. Each
    // bump degrades open (allowed=true) but records a failure.
    for (let i = 0; i < threshold; i++) {
      const r = await store.bump("k", t0 + i, 1000, 5);
      expect(r.allowed).toBe(true);
    }
    expect(
      sentryCalls.messages.some(
        (m) => m.message === "rate_limit_redis_failure_threshold_breached",
      ),
    ).toBe(true);

    // Redis comes back; the next successful bump must emit the recovery
    // signal so on-call can close the incident without polling /healthz.
    shouldFail = false;
    const recovered = await store.bump("k", t0 + 4_200, 1000, 5);
    expect(recovered.allowed).toBe(true);
    const recovery = sentryCalls.messages.find(
      (m) => m.message === "rate_limit_redis_recovered",
    );
    expect(recovery).toBeDefined();
    const opts = recovery!.options as {
      tags: Record<string, string>;
      extra: { durationMs: number; failureCount: number };
    };
    expect(opts.tags.alert).toBe("rate_limit_store_recovered");
    expect(opts.extra.failureCount).toBe(threshold);
    // Streak began at t0; recovery clock at t0 + 4_200 — duration must
    // reflect the full incident window, not just the moment of recovery.
    expect(opts.extra.durationMs).toBe(4_200);

    // Subsequent successful bumps must not re-emit recovery.
    const before = sentryCalls.messages.length;
    await store.bump("k", t0 + 5_000, 1000, 5);
    expect(sentryCalls.messages.length).toBe(before);
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

describe("assertRateLimitStoreConfiguredForProduction — production rate-limit store presence check", () => {
  // The rate-limit store kind is read from `RATE_LIMIT_STORE` and
  // silently defaults to the in-process memory bucket when unset
  // (`createBucketStore` above). Multi-replica production deploys with
  // the in-memory bucket give each replica its own counters, so the
  // per-tier rate limit is effectively multiplied by the replica count
  // and trivially bypassed. Task #87 first shipped this check as a
  // structured warning so the misconfiguration would show up in log
  // aggregators / Sentry without crash-looping existing production
  // deploys that hadn't yet wired Redis. Task #90 then graduated the
  // check to a hard boot failure (the boot caller in `index.ts`
  // calls `process.exit(1)` on `{ ok: false }`) so a future env-var
  // rotation can't silently re-introduce the bypassable per-process
  // bucket on a multi-replica deploy. An explicit escape hatch
  // (`RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION=1`) downgrades the
  // failure to a loud `pino warn` for legitimate single-replica
  // deploys (canary, internal-only tools).
  //
  // The check intentionally determines production-ness via
  // `detectNonHostnameProductionSignals` only (the same shared helper
  // used by `assertProductionHostnamePatternConfigured`) — the
  // hostname pattern is out of scope here.

  type LogCall = [obj: unknown, msg: string];
  function buildLogSink(): {
    warn: (obj: unknown, msg: string) => void;
    error: (obj: unknown, msg: string) => void;
    warnCalls: LogCall[];
    errorCalls: LogCall[];
  } {
    const warnCalls: LogCall[] = [];
    const errorCalls: LogCall[] = [];
    return {
      warn: (obj, msg) => {
        warnCalls.push([obj, msg]);
      },
      error: (obj, msg) => {
        errorCalls.push([obj, msg]);
      },
      warnCalls,
      errorCalls,
    };
  }

  it("does nothing on a non-production deploy (staging) with RATE_LIMIT_STORE unset", () => {
    // The pattern is optional outside production — the check must not
    // log, otherwise every staging boot would emit noise about a
    // production-only configuration.
    const log = buildLogSink();
    const result = assertRateLimitStoreConfiguredForProduction(
      { NODE_ENV: "staging" },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.warnCalls).toEqual([]);
    expect(log.errorCalls).toEqual([]);
  });

  it("does nothing on a development deploy", () => {
    // Local-dev parity — the in-process bucket is the right default
    // for a single-process dev workspace.
    const log = buildLogSink();
    const result = assertRateLimitStoreConfiguredForProduction(
      { NODE_ENV: "development" },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.warnCalls).toEqual([]);
    expect(log.errorCalls).toEqual([]);
  });

  it("does nothing on a Replit dev workspace (REPLIT_DEPLOYMENT unset/0)", () => {
    // REPLIT_DEPLOYMENT=0 / unset means "Replit dev workspace, not a
    // production deployment" — Redis is not required.
    const log = buildLogSink();
    for (const value of [undefined, "", "0", "true"]) {
      const env: NodeJS.ProcessEnv = { NODE_ENV: "development" };
      if (value !== undefined) env.REPLIT_DEPLOYMENT = value;
      const result = assertRateLimitStoreConfiguredForProduction(env, log);
      expect(result.ok, `value=${String(value)}`).toBe(true);
    }
    expect(log.warnCalls).toEqual([]);
    expect(log.errorCalls).toEqual([]);
  });

  it("FAILS BOOT when NODE_ENV=production and RATE_LIMIT_STORE is unset", () => {
    // The original task case: a production-shaped deploy ships
    // without Redis-backed rate limiting and silently degrades to
    // per-process buckets. Post-graduation (task #90) the check must
    // return `{ ok: false }` so the boot caller in index.ts exits the
    // process — letting the deploy serve traffic with bypassable
    // per-process buckets is exactly the regression this guard exists
    // to prevent. The structured log must be at `error` level (not
    // `warn`) because this is now a fatal condition.
    const log = buildLogSink();
    const result = assertRateLimitStoreConfiguredForProduction(
      { NODE_ENV: "production" },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/RATE_LIMIT_STORE is unset/);
    expect(result.reason).toMatch(/NODE_ENV=production/);
    expect(result.reason).toMatch(/multi-replica/i);
    expect(result.reason).toMatch(/runbook|rate-limit-store/i);
    // Hard failure ⇒ error-level log, no warn output. This shape is
    // load-bearing for the production Sentry alert keyed off
    // level=error + the message tag below.
    expect(log.warnCalls).toEqual([]);
    expect(log.errorCalls).toHaveLength(1);
    const [obj, msg] = log.errorCalls[0]!;
    // The structured log must surface the offending env vars so an
    // operator reading a Sentry alert can confirm the
    // misconfiguration without shelling onto the box.
    expect(obj).toMatchObject({
      node_env: "production",
      rate_limit_store: null,
      production_signals: ["node_env"],
    });
    // Dedicated message identifier so log aggregators / Sentry
    // alerts can be wired up exactly to this event.
    expect(msg).toMatch(/rate_limit_store_misconfigured_for_production/);
    // The error message must point operators at both fixes — wire
    // Redis OR opt out via the documented escape hatch — so the
    // crash-looping deploy is self-explanatory without grep'ing the
    // runbook for what the new env var name is.
    expect(msg).toMatch(/Refusing to start/);
    expect(msg).toMatch(/RATE_LIMIT_STORE=redis/);
    expect(msg).toMatch(/RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION=1/);
  });

  it("FAILS BOOT when REPLIT_DEPLOYMENT=1 alone triggers production-shape detection", () => {
    // A deploy with NODE_ENV unset / staging but the Replit platform
    // marker set is still production-shaped. Redis is still required.
    const log = buildLogSink();
    const result = assertRateLimitStoreConfiguredForProduction(
      { REPLIT_DEPLOYMENT: "1" },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/REPLIT_DEPLOYMENT=1/);
    expect(log.warnCalls).toEqual([]);
    expect(log.errorCalls).toHaveLength(1);
    const [obj] = log.errorCalls[0]!;
    expect(obj).toMatchObject({
      replit_deployment: "1",
      production_signals: ["replit_deployment"],
    });
  });

  it("FAILS BOOT when DEPLOYMENT_ENVIRONMENT=production alone triggers production-shape detection", () => {
    const log = buildLogSink();
    const result = assertRateLimitStoreConfiguredForProduction(
      { DEPLOYMENT_ENVIRONMENT: "production" },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/DEPLOYMENT_ENVIRONMENT=production/);
    expect(log.warnCalls).toEqual([]);
    expect(log.errorCalls).toHaveLength(1);
    const [obj] = log.errorCalls[0]!;
    expect(obj).toMatchObject({
      deployment_environment: "production",
      production_signals: ["deployment_environment"],
    });
  });

  it("FAILS BOOT when RATE_LIMIT_STORE='memory' is explicitly set in production", () => {
    // Belt-and-braces: an operator who explicitly set the value to
    // the in-memory bucket on a production deploy is in the same
    // bypassable state as one who left it unset. The check must
    // surface both, and the structured log must echo the observed
    // value so the operator can tell the two apart in triage.
    const log = buildLogSink();
    const result = assertRateLimitStoreConfiguredForProduction(
      { NODE_ENV: "production", RATE_LIMIT_STORE: "memory" },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/RATE_LIMIT_STORE="memory"/);
    expect(log.warnCalls).toEqual([]);
    expect(log.errorCalls).toHaveLength(1);
    const [obj] = log.errorCalls[0]!;
    expect(obj).toMatchObject({
      rate_limit_store: "memory",
    });
  });

  it("FAILS BOOT for any non-redis value (typos like 'redys' fall back to memory the same way)", () => {
    // `createBucketStore` defaults to the in-memory bucket and emits
    // `rate_limit_store_unknown_kind_falling_back_to_memory` for any
    // unknown value. Those deploys are equally bypassable — the check
    // must fail boot for them too so a typo'd env var doesn't silently
    // ship to production. Empty string and whitespace-only normalise
    // the same way: not "redis" → fall back to memory → fail.
    const log = buildLogSink();
    for (const value of ["redys", "REDIS_CLUSTER", "Memory", "", " ", "\t"]) {
      const result = assertRateLimitStoreConfiguredForProduction(
        { NODE_ENV: "production", RATE_LIMIT_STORE: value },
        log,
      );
      expect(result.ok, `value=${JSON.stringify(value)}`).toBe(false);
    }
    expect(log.errorCalls.length).toBe(6);
    expect(log.warnCalls).toEqual([]);
  });

  it("does NOT log when RATE_LIMIT_STORE=redis on a production deploy (the healthy path)", () => {
    // The common, correct case: a real production deploy with Redis
    // wired up. Must return ok with zero log output — the check is
    // meant to be silent on a healthy boot.
    const log = buildLogSink();
    const result = assertRateLimitStoreConfiguredForProduction(
      {
        NODE_ENV: "production",
        REPLIT_DEPLOYMENT: "1",
        DEPLOYMENT_ENVIRONMENT: "production",
        RATE_LIMIT_STORE: "redis",
      },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.warnCalls).toEqual([]);
    expect(log.errorCalls).toEqual([]);
  });

  it("normalises RATE_LIMIT_STORE case-insensitively so 'REDIS' / ' redis ' count as configured", () => {
    // Mirrors `createBucketStore`'s `(env ?? "memory").toLowerCase()`
    // — a value of "REDIS" or " redis " selects the Redis backend at
    // boot, so the check must agree and not fail boot.
    const log = buildLogSink();
    for (const value of ["REDIS", "Redis", " redis", "redis ", "  redis  "]) {
      const result = assertRateLimitStoreConfiguredForProduction(
        { NODE_ENV: "production", RATE_LIMIT_STORE: value },
        log,
      );
      expect(result.ok, `value=${JSON.stringify(value)}`).toBe(true);
    }
    expect(log.warnCalls).toEqual([]);
    expect(log.errorCalls).toEqual([]);
  });

  it("aggregates every production signal into a single error so on-call sees them all at once", () => {
    // If multiple signals are lit, the failure must list every one
    // — otherwise an operator who fixes the first signal would have
    // to redeploy and re-read logs to discover the next.
    const log = buildLogSink();
    const result = assertRateLimitStoreConfiguredForProduction(
      {
        NODE_ENV: "production",
        REPLIT_DEPLOYMENT: "1",
        DEPLOYMENT_ENVIRONMENT: "production",
      },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/NODE_ENV=production/);
    expect(result.reason).toMatch(/REPLIT_DEPLOYMENT=1/);
    expect(result.reason).toMatch(/DEPLOYMENT_ENVIRONMENT=production/);
    expect(log.warnCalls).toEqual([]);
    expect(log.errorCalls).toHaveLength(1);
    const [obj] = log.errorCalls[0]!;
    expect(obj).toMatchObject({
      production_signals: [
        "node_env",
        "replit_deployment",
        "deployment_environment",
      ],
    });
  });

  it("ignores REPLIT_DEPLOYMENT values other than the literal '1'", () => {
    // Mirrors the kill-switch and hostname-pattern guards' strictness
    // — only the literal "1" trips the production-deployment signal.
    const log = buildLogSink();
    for (const bogus of ["0", "true", "false", "yes", " 1 "]) {
      const result = assertRateLimitStoreConfiguredForProduction(
        { REPLIT_DEPLOYMENT: bogus },
        log,
      );
      expect(result.ok, `bogus=${bogus}`).toBe(true);
    }
    expect(log.warnCalls).toEqual([]);
    expect(log.errorCalls).toEqual([]);
  });

  it("ignores DEPLOYMENT_ENVIRONMENT values other than the literal 'production'", () => {
    // Mirrors the sibling guards: only the lowercase literal matches.
    // Casing drift (e.g. "Production", "PROD") is the operator's
    // responsibility to normalise upstream.
    const log = buildLogSink();
    for (const value of ["staging", "preview", "Production", "PROD", "qa"]) {
      const result = assertRateLimitStoreConfiguredForProduction(
        { DEPLOYMENT_ENVIRONMENT: value },
        log,
      );
      expect(result.ok, `value=${value}`).toBe(true);
    }
    expect(log.warnCalls).toEqual([]);
    expect(log.errorCalls).toEqual([]);
  });

  it("DOWNGRADES to a warn (and proceeds) when RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION=1 opts out", () => {
    // The escape hatch path (task #90): legitimate single-replica
    // production deploys (canary, internal-only tools) intentionally
    // run on the in-process bucket. Setting the literal "1" must:
    //   - downgrade the log from `error` to `warn` so the deploy is
    //     not crash-looped,
    //   - return `{ ok: true }` so the boot caller proceeds,
    //   - still emit a loud structured warning keyed off
    //     `rate_limit_store_memory_in_production_via_opt_out` so
    //     on-call sees that the bypassable per-process bucket is in
    //     use even though boot was permitted,
    //   - echo the opt-out env var in the structured payload so an
    //     operator triaging a misuse case can prove the flag is what
    //     downgraded the failure (not a code change).
    const log = buildLogSink();
    const result = assertRateLimitStoreConfiguredForProduction(
      {
        NODE_ENV: "production",
        RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION: "1",
      },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.errorCalls).toEqual([]);
    expect(log.warnCalls).toHaveLength(1);
    const [obj, msg] = log.warnCalls[0]!;
    expect(msg).toMatch(/rate_limit_store_memory_in_production_via_opt_out/);
    // The reason wording from the failure path is preserved so triage
    // can still see WHY the deploy is in the bypassable state — only
    // the disposition (warn vs error, ok vs not-ok) changed.
    expect(msg).toMatch(/RATE_LIMIT_STORE is unset/);
    expect(msg).toMatch(/multi-replica/i);
    expect(msg).toMatch(/single-replica/i);
    expect(obj).toMatchObject({
      node_env: "production",
      rate_limit_store: null,
      rate_limit_store_allow_memory_in_production: "1",
      production_signals: ["node_env"],
      // `hostname: null` when HOSTNAME is unset — the field must
      // still be present so the downstream Sentry alert never sees a
      // missing key (which Sentry would group as a separate issue
      // shape from "hostname present"). See
      // `docs/runbooks/rate-limit-store-opt-outs.md` for how the
      // alert uses this field to gate page vs notify routing.
      hostname: null,
    });
  });

  it("opt-out warn payload includes HOSTNAME so the Sentry alert can match against the inventory", () => {
    // The opt-out inventory at
    // `docs/runbooks/rate-limit-store-opt-outs.md` is keyed by
    // container hostname. The warn payload MUST forward `HOSTNAME`
    // verbatim (not the configured production hostname pattern, not
    // a deploy slug) so the Sentry rule keyed off
    // `rate_limit_store_memory_in_production_via_opt_out` can decide
    // whether the emitting host is a sanctioned opt-out (notify) or
    // an uninventoried deploy that has misused the escape hatch
    // (page). Failing to forward this field would degrade the alert
    // back to "warn from somewhere — go grep" which is exactly what
    // the inventory exists to fix.
    const log = buildLogSink();
    const result = assertRateLimitStoreConfiguredForProduction(
      {
        NODE_ENV: "production",
        RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION: "1",
        HOSTNAME: "api-canary-7f9c2",
      },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.warnCalls).toHaveLength(1);
    const [obj] = log.warnCalls[0]!;
    expect(obj).toMatchObject({
      hostname: "api-canary-7f9c2",
      rate_limit_store_allow_memory_in_production: "1",
    });
  });

  it("opt-out path also covers the explicit RATE_LIMIT_STORE='memory' case", () => {
    // A canary deploy that explicitly pinned the in-process bucket
    // and acknowledged the trade-off via the escape hatch must boot
    // cleanly — but on-call should still see the warn so the deploy
    // doesn't quietly ship a memory bucket forever.
    const log = buildLogSink();
    const result = assertRateLimitStoreConfiguredForProduction(
      {
        DEPLOYMENT_ENVIRONMENT: "production",
        RATE_LIMIT_STORE: "memory",
        RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION: "1",
      },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.errorCalls).toEqual([]);
    expect(log.warnCalls).toHaveLength(1);
    const [obj, msg] = log.warnCalls[0]!;
    expect(msg).toMatch(/rate_limit_store_memory_in_production_via_opt_out/);
    expect(obj).toMatchObject({
      rate_limit_store: "memory",
      rate_limit_store_allow_memory_in_production: "1",
    });
  });

  it("opt-out is silent and ok when RATE_LIMIT_STORE=redis is also set (no false 'memory' warning)", () => {
    // Defensive: a deploy that flipped the escape hatch on but later
    // wired up Redis must not emit a misleading "memory in production
    // via opt out" warning — Redis is the actual selected store, so
    // the healthy-path early-return must fire before the opt-out
    // branch is even considered.
    const log = buildLogSink();
    const result = assertRateLimitStoreConfiguredForProduction(
      {
        NODE_ENV: "production",
        RATE_LIMIT_STORE: "redis",
        RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION: "1",
      },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.warnCalls).toEqual([]);
    expect(log.errorCalls).toEqual([]);
  });

  it("opt-out only matches the literal '1' — casing drift still fails boot", () => {
    // Mirrors the strictness of every other production-shape signal
    // in this module (REPLIT_DEPLOYMENT='1', DEPLOYMENT_ENVIRONMENT=
    // 'production'). Loose values like 'true' / 'yes' / ' 1 ' must
    // NOT silence the failure — otherwise an operator who set the
    // wrong value would believe they had opted out when they had
    // actually left the production deploy crash-looping (or worse,
    // believed they had a bypass when the literal check was added
    // strictly later).
    const log = buildLogSink();
    for (const bogus of ["0", "true", "TRUE", "yes", " 1 ", "1\n", "01"]) {
      const result = assertRateLimitStoreConfiguredForProduction(
        {
          NODE_ENV: "production",
          RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION: bogus,
        },
        log,
      );
      expect(result.ok, `bogus=${JSON.stringify(bogus)}`).toBe(false);
    }
    // Every bogus value should have produced an error log (not a warn).
    expect(log.warnCalls).toEqual([]);
    expect(log.errorCalls).toHaveLength(7);
  });

  it("opt-out env var is ignored entirely on non-production deploys", () => {
    // A staging deploy that has the escape hatch set is a no-op —
    // we don't want to emit the "memory in production via opt-out"
    // warn on staging because that would be confusing noise (staging
    // is not production, the per-process bucket is fine, the opt-out
    // is irrelevant).
    const log = buildLogSink();
    const result = assertRateLimitStoreConfiguredForProduction(
      {
        NODE_ENV: "staging",
        RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION: "1",
      },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.warnCalls).toEqual([]);
    expect(log.errorCalls).toEqual([]);
  });

  it("agrees byte-for-byte with createBucketStore's normalisation for representative inputs", () => {
    // Parity guard: the boot-time check exists to surface a missing
    // Redis backend, so its decision (`ok: true` ⇔ "redis selected at
    // runtime") MUST match what `createBucketStore` actually picks.
    // If the two normalise differently — e.g. the guard trims
    // whitespace but the runtime doesn't — a value like " redis "
    // would be approved by the guard while the runtime silently fell
    // back to the per-process bucket, leaving production bypassable
    // without alerting. This test pins the parity so any future drift
    // (e.g. someone adding `.replace(/\s+/g, "")` on one side only)
    // is caught immediately. We deliberately do NOT set the opt-out
    // env var here — that path is tested above and would mask a
    // normalisation drift bug by always returning `ok: true`.
    const { normaliseRateLimitStoreKind } = __test__;
    const cases = [
      undefined,
      "",
      "   ",
      "redis",
      "REDIS",
      " redis ",
      "  redis  ",
      "memory",
      "MEMORY",
      "redys",
      "rediss",
      "redis-cluster",
    ];
    const log = buildLogSink();
    for (const value of cases) {
      const env: Partial<NodeJS.ProcessEnv> = { NODE_ENV: "production" };
      if (value !== undefined) env.RATE_LIMIT_STORE = value;
      const guardOk = assertRateLimitStoreConfiguredForProduction(env, log).ok;
      const runtimeKind = normaliseRateLimitStoreKind(value);
      const runtimePicksRedis = runtimeKind === "redis";
      expect(guardOk, `value=${JSON.stringify(value)}`).toBe(runtimePicksRedis);
    }
  });
});

describe("getRateLimitStoreReadyzStatus — /readyz config block (Task #101)", () => {
  // Helper companion to the boot-time guard
  // `assertRateLimitStoreConfiguredForProduction`: this is the
  // runtime equivalent surfaced on /readyz so an external probe
  // (`scripts/checkReadyzConfig.ts`) can page on-call when the
  // running replica's rate-limit store is in a dangerous state.
  // The boot guard already crash-loops the dangerous combination on
  // a clean restart, but a hot env-var rotation, a platform-side
  // env-var change without restart, or an emergency rollback that
  // skipped the boot guard can still leave a running replica with
  // memory bucket on production. The helper closes that gap.
  //
  // The helper is pure: callers pass the runtime store kind (so
  // tests don't need to spin up a singleton bucket store) plus an
  // explicit env (so tests don't poison `process.env`).

  it("returns 'redis' whenever the running store is redis, regardless of deploy shape", () => {
    expect(getRateLimitStoreReadyzStatus("redis", {})).toBe("redis");
    expect(
      getRateLimitStoreReadyzStatus("redis", { NODE_ENV: "production" }),
    ).toBe("redis");
    expect(
      getRateLimitStoreReadyzStatus("redis", {
        NODE_ENV: "production",
        RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION: "1",
      }),
    ).toBe("redis");
  });

  it("returns 'memory_not_required' on a non-production deploy with memory bucket (the intended dev/staging state)", () => {
    expect(getRateLimitStoreReadyzStatus("memory", {})).toBe(
      "memory_not_required",
    );
    expect(
      getRateLimitStoreReadyzStatus("memory", { NODE_ENV: "staging" }),
    ).toBe("memory_not_required");
  });

  it("returns 'memory_misconfigured' for every non-hostname production signal — the page condition", () => {
    // Each signal independently triggers the page state. This
    // mirrors the boot guard's signal sensitivity so a probe that
    // only checked NODE_ENV would NOT silently exempt a Replit-
    // platform-marked production deploy whose NODE_ENV is unset.
    for (const env of [
      { NODE_ENV: "production" },
      { REPLIT_DEPLOYMENT: "1" },
      { DEPLOYMENT_ENVIRONMENT: "production" },
    ]) {
      expect(
        getRateLimitStoreReadyzStatus("memory", env),
        `env=${JSON.stringify(env)}`,
      ).toBe("memory_misconfigured");
    }
  });

  it("returns 'memory_opt_out_acknowledged' when the operator explicitly opts memory-in-production on", () => {
    // Single-replica production canaries (internal tools, single-
    // replica staging-mirroring-prod environments) opt into the in-
    // process bucket via RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION=1.
    // The probe must distinguish this warn-level state from the
    // page-on-call misconfigured state: opt-out is intentional and
    // shouldn't fire the page. Mirrors the boot-guard's warn-vs-
    // error distinction.
    expect(
      getRateLimitStoreReadyzStatus("memory", {
        NODE_ENV: "production",
        RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION: "1",
      }),
    ).toBe("memory_opt_out_acknowledged");
    expect(
      getRateLimitStoreReadyzStatus("memory", {
        REPLIT_DEPLOYMENT: "1",
        RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION: "1",
      }),
    ).toBe("memory_opt_out_acknowledged");
  });

  it("only treats a literal '1' as opt-out — typo'd values still page (matches boot-guard predicate)", () => {
    // A typo'd opt-out value would silently leave the deploy in the
    // misconfigured state at boot AND silently mask the page here.
    // Match the strict-equality check the boot guard uses so the
    // two layers stay in lockstep.
    for (const v of ["true", "yes", "on", " 1", "1\n", ""]) {
      expect(
        getRateLimitStoreReadyzStatus("memory", {
          NODE_ENV: "production",
          RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION: v,
        }),
        `value=${JSON.stringify(v)}`,
      ).toBe("memory_misconfigured");
    }
  });

  it("ignores the hostname production signal (intentional — the hostname signal is for the rehearsal-injector backstop, not for rate-limit store decisions)", () => {
    // A staging deploy whose HOSTNAME happens to match the
    // PRODUCTION_HOSTNAME_PATTERN should NOT be paged on for the
    // rate-limit store decision — the hostname signal is scoped to
    // the rehearsal-injector backstop. Matching the boot guard's
    // signal selection keeps the runtime probe consistent with
    // boot-time behaviour.
    expect(
      getRateLimitStoreReadyzStatus("memory", {
        HOSTNAME: "api.epplaa.com",
        PRODUCTION_HOSTNAME_PATTERN: "^api\\.epplaa\\.com$",
      }),
    ).toBe("memory_not_required");
  });
});
