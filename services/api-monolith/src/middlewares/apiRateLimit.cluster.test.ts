import { describe, it, expect, vi } from "vitest";
import RedisMock from "ioredis-mock";
import IORedis from "ioredis";

/**
 * Regression test for #202 — prove the rate limiter holds together
 * under two live API servers.
 *
 * The single-instance parity tests in `apiRateLimit.test.ts` already
 * pin down that the Redis-backed Lua script matches the in-memory
 * sliding-window log. The remaining production-gate question is: when
 * two api-server replicas share one Redis (the multi-instance deploy
 * `assertRateLimitStoreConfiguredForProduction` requires), does the
 * effective per-identity ceiling stay at `max`, or does each replica
 * own its own quota and let an attacker multiply the cap by spreading
 * traffic across replicas?
 *
 * We model that by spinning up two separate `RedisStore` instances
 * that share one underlying `ioredis-mock` keyspace. ioredis-mock is
 * an in-process fake that shares state across instances created with
 * the same options, which is enough to model "two replicas talking to
 * the same Redis" — every key, sorted-set, and PEXPIRE applied by one
 * `RedisStore` is visible to the other on the next round-trip.
 *
 * If a future refactor accidentally caches counters in-process (e.g.
 * sticking an LRU in front of `bump` to "speed up the hot path"),
 * this test will fail loudly because replica B's bump will see fewer
 * hits than replica A wrote and the cap will silently double.
 */

vi.mock("../lib/sentry", () => ({
  captureException: () => {},
  captureMessage: () => {},
  initSentryServer: () => {},
}));

import { __test__ } from "./apiRateLimit";

interface ReplicaPair {
  redisA: IORedis;
  redisB: IORedis;
  storeA: InstanceType<typeof __test__.RedisStore>;
  storeB: InstanceType<typeof __test__.RedisStore>;
}

function spawnReplicaPair(): ReplicaPair {
  // ioredis-mock shares its in-process keyspace across instances by
  // default, which is exactly the topology we want: two clients talking
  // to "the same Redis" without any real network.
  const redisA = new RedisMock() as unknown as IORedis;
  const redisB = new RedisMock() as unknown as IORedis;
  const storeA = new __test__.RedisStore(redisA);
  const storeB = new __test__.RedisStore(redisB);
  return { redisA, redisB, storeA, storeB };
}

describe("Cluster rate limit — two replicas share one Redis-backed counter", () => {
  it("treats `max` as a global cap across both replicas, not per-replica", async () => {
    const { storeA, storeB, redisA, redisB } = spawnReplicaPair();
    try {
      const max = 10;
      const windowMs = 60_000;
      const now = Date.now();
      const key = "cluster:user:42";

      // Drive an interleaved sequence: 5 hits to A, 5 hits to B. Total
      // hits across replicas == max, so all 10 must be admitted.
      const decisions: boolean[] = [];
      for (let i = 0; i < 5; i++) {
        decisions.push((await storeA.bump(key, now + i, windowMs, max)).allowed);
        decisions.push((await storeB.bump(key, now + i + 100, windowMs, max)).allowed);
      }
      expect(decisions.every(Boolean)).toBe(true);
      expect(decisions.length).toBe(max);

      // The 11th request — to either replica — must 429. The pre-bug
      // (per-replica buckets) would let each replica admit its own 10
      // and only fail at hit 21.
      const oneMore = await storeA.bump(key, now + 1000, windowMs, max);
      expect(oneMore.allowed).toBe(false);
      expect(oneMore.retryAfterMs).toBeGreaterThan(0);

      const oneMoreOnB = await storeB.bump(key, now + 1100, windowMs, max);
      expect(oneMoreOnB.allowed).toBe(false);
      expect(oneMoreOnB.retryAfterMs).toBeGreaterThan(0);
    } finally {
      redisA.disconnect();
      redisB.disconnect();
    }
  });

  it("does NOT cross-pollinate buckets for different identities", async () => {
    const { storeA, storeB, redisA, redisB } = spawnReplicaPair();
    try {
      const max = 3;
      const windowMs = 60_000;
      const now = Date.now();

      // Fill replica A's bucket for user 1.
      for (let i = 0; i < max; i++) {
        const r = await storeA.bump("cluster:user:1", now + i, windowMs, max);
        expect(r.allowed).toBe(true);
      }
      const blocked = await storeB.bump(
        "cluster:user:1",
        now + 100,
        windowMs,
        max,
      );
      expect(blocked.allowed).toBe(false);

      // User 2 still gets a fresh quota on replica B.
      for (let i = 0; i < max; i++) {
        const r = await storeB.bump("cluster:user:2", now + i, windowMs, max);
        expect(r.allowed).toBe(true);
      }
      const user2Blocked = await storeA.bump(
        "cluster:user:2",
        now + 200,
        windowMs,
        max,
      );
      expect(user2Blocked.allowed).toBe(false);
    } finally {
      redisA.disconnect();
      redisB.disconnect();
    }
  });

  it("models the MFA challenge case: state issued on A is enforced on B", async () => {
    // Same Redis backing as the rate limiter — an MFA challenge issued
    // on replica A and consumed on replica B both go through the same
    // shared Redis (rate-limit counters AND MFA state share REDIS_URL
    // in the api-monolith deploy). We model the relevant invariant:
    // a tight burst of MFA verify attempts spread across replicas
    // hits the per-identity ceiling at the same total count as a
    // single-replica burst.
    const { storeA, storeB, redisA, redisB } = spawnReplicaPair();
    try {
      const max = 5;
      const windowMs = 5 * 60_000;
      const now = Date.now();
      const mfaKey = "mfa_verify:anon:POST:/api/mfa/verify:ip:198.51.100.7";

      let admittedCount = 0;
      for (let i = 0; i < max * 2; i++) {
        const replica = i % 2 === 0 ? storeA : storeB;
        const r = await replica.bump(mfaKey, now + i, windowMs, max);
        if (r.allowed) admittedCount += 1;
      }
      // Total admitted across the cluster equals `max`, not 2 * max —
      // the very property the per-tier cap is meant to enforce.
      expect(admittedCount).toBe(max);
    } finally {
      redisA.disconnect();
      redisB.disconnect();
    }
  });
});
