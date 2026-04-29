import { describe, it, expect, beforeEach, vi } from "vitest";
import RedisMock from "ioredis-mock";

vi.mock("../lib/sentry", () => ({
  captureException: () => {},
  captureMessage: () => {},
  initSentryServer: () => {},
}));

vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: null }),
}));

import { ipRateLimit } from "./ipRateLimit";
import { __test__ } from "./apiRateLimit";

interface FakeReq {
  ip: string;
  headers: Record<string, string | string[] | undefined>;
  socket: { remoteAddress: string };
}

interface FakeRes {
  statusCode: number;
  headers: Record<string, string | number>;
  body: unknown;
  status(code: number): FakeRes;
  json(body: unknown): FakeRes;
  setHeader(k: string, v: string | number): void;
}

function makeReq(ip: string, xff?: string): FakeReq {
  return {
    ip,
    headers: xff ? { "x-forwarded-for": xff } : {},
    socket: { remoteAddress: ip },
  };
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 0,
    headers: {},
    body: undefined,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(body) {
      res.body = body;
      return res;
    },
    setHeader(k, v) {
      res.headers[k] = v;
    },
  };
  return res;
}

/**
 * Run a request through `ipRateLimit` and resolve once `next()` is
 * called or the middleware writes a 429 response. The middleware is
 * async-internally (it awaits the shared bucket store) so we can't
 * just call `next` synchronously after `mw(req, res, next)` returns —
 * we need a tiny promise barrier.
 */
function runMw(
  mw: ReturnType<typeof ipRateLimit>,
  req: FakeReq,
  res: FakeRes,
): Promise<{ called: boolean }> {
  return new Promise((resolve) => {
    let called = false;
    const next = () => {
      called = true;
      resolve({ called });
    };
    mw(req as never, res as never, next as never);
    // Also resolve once the response has been written (429 path).
    const deadline = Date.now() + 500;
    const tick = () => {
      if (called || res.statusCode !== 0) {
        resolve({ called });
        return;
      }
      if (Date.now() > deadline) {
        resolve({ called });
        return;
      }
      setTimeout(tick, 1);
    };
    setTimeout(tick, 1);
  });
}

beforeEach(() => {
  // The shared bucket store is the singleton InMemoryStore (test env
  // never sets RATE_LIMIT_STORE=redis). Wipe its internal map between
  // cases so leftover hits from a previous test can't bleed in.
  const store = __test__.store as unknown as { map: Map<string, unknown> };
  store.map.clear();
});

describe("ipRateLimit basic admission/429", () => {
  it("admits up to max within the window then returns 429", async () => {
    const mw = ipRateLimit({ name: "otp_test", windowMs: 60_000, max: 3 });
    const out: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = makeRes();
      const r = await runMw(mw, makeReq("1.2.3.4"), res);
      out.push(r.called ? 200 : res.statusCode);
    }
    expect(out).toEqual([200, 200, 200, 429, 429]);
  });

  it("isolates buckets per IP", async () => {
    const mw = ipRateLimit({ name: "otp_test", windowMs: 60_000, max: 1 });
    const r1 = await runMw(mw, makeReq("1.1.1.1"), makeRes());
    expect(r1.called).toBe(true);
    const r2res = makeRes();
    await runMw(mw, makeReq("1.1.1.1"), r2res);
    expect(r2res.statusCode).toBe(429);
    // Different IP still has full quota.
    const r3 = await runMw(mw, makeReq("2.2.2.2"), makeRes());
    expect(r3.called).toBe(true);
  });

  it("isolates buckets per name", async () => {
    const mwA = ipRateLimit({ name: "alpha", windowMs: 60_000, max: 1 });
    const mwB = ipRateLimit({ name: "beta", windowMs: 60_000, max: 1 });
    expect((await runMw(mwA, makeReq("9.9.9.9"), makeRes())).called).toBe(true);
    // Same IP, different bucket name → still allowed.
    expect((await runMw(mwB, makeReq("9.9.9.9"), makeRes())).called).toBe(true);
    // Repeat on first bucket → 429.
    const res = makeRes();
    await runMw(mwA, makeReq("9.9.9.9"), res);
    expect(res.statusCode).toBe(429);
  });

  it("sets a Retry-After header at least 1s when 429ing", async () => {
    const mw = ipRateLimit({ name: "ra", windowMs: 5_000, max: 1 });
    await runMw(mw, makeReq("3.3.3.3"), makeRes());
    const res = makeRes();
    await runMw(mw, makeReq("3.3.3.3"), res);
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers["Retry-After"])).toBeGreaterThanOrEqual(1);
    expect(Number(res.headers["Retry-After"])).toBeLessThanOrEqual(5);
  });
});

describe("ipRateLimit x-forwarded-for handling", () => {
  it("ignores x-forwarded-for unless IP_RATE_LIMIT_TRUST_PROXY=1", async () => {
    delete process.env.IP_RATE_LIMIT_TRUST_PROXY;
    const mw = ipRateLimit({ name: "xff_off", windowMs: 60_000, max: 1 });
    const reqA = makeReq("10.0.0.1", "1.2.3.4");
    const reqB = makeReq("10.0.0.1", "5.6.7.8");
    expect((await runMw(mw, reqA, makeRes())).called).toBe(true);
    // Same socket IP, different forwarded IP — without trust-proxy
    // both share the bucket because the forwarded header is ignored.
    const res = makeRes();
    await runMw(mw, reqB, res);
    expect(res.statusCode).toBe(429);
  });

  it("honors the first x-forwarded-for hop when IP_RATE_LIMIT_TRUST_PROXY=1", async () => {
    process.env.IP_RATE_LIMIT_TRUST_PROXY = "1";
    try {
      const mw = ipRateLimit({ name: "xff_on", windowMs: 60_000, max: 1 });
      const reqA = makeReq("10.0.0.1", "1.2.3.4, 10.0.0.1");
      const reqB = makeReq("10.0.0.1", "5.6.7.8, 10.0.0.1");
      // Different upstream IPs → different buckets, both admitted.
      expect((await runMw(mw, reqA, makeRes())).called).toBe(true);
      expect((await runMw(mw, reqB, makeRes())).called).toBe(true);
    } finally {
      delete process.env.IP_RATE_LIMIT_TRUST_PROXY;
    }
  });
});

/**
 * Cross-replica parity: simulate two api-server replicas sharing the
 * same Redis store. Both replicas call into the SAME `RedisStore`
 * instance (because in a real deploy they connect to the same Redis
 * URL), and the per-IP cap must hold across them — i.e. the effective
 * limit does NOT multiply by the number of replicas the way it would
 * with the old per-process `Map`.
 *
 * We exercise the underlying `RedisStore` directly here because the
 * `ipRateLimit` middleware is a thin wrapper over `bumpRateLimitBucket`
 * that delegates to the singleton store; the cross-replica claim
 * reduces to "if both replicas share the Redis-backed store, the
 * counter is shared". Driving the store directly with the same key
 * the middleware would generate (`iprl:<name>:<ip>`) is the cleanest
 * way to assert that.
 */
describe("ipRateLimit cross-replica counter sharing", () => {
  it("shares per-IP counters across replicas via the shared Redis store", async () => {
    const redis = new RedisMock();
    // Two `RedisStore` instances backed by the same fake Redis stand
    // in for two api-server replicas connected to the same managed
    // Redis instance in production.
    const replicaA = new __test__.RedisStore(redis as never);
    const replicaB = new __test__.RedisStore(redis as never);
    const key = "iprl:otp_start:10.20.30.40";
    const t0 = 1_000_000;
    const max = 3;
    const window = 60_000;

    // Spread 6 hits across two "replicas" — a cap of 3 means only 3
    // total are admitted, regardless of which replica handled them.
    // Without a shared store each replica would have its own counter
    // and all 6 hits would slip through (effective cap 3 × 2 = 6).
    const allowed: boolean[] = [];
    allowed.push((await replicaA.bump(key, t0 + 0, window, max)).allowed);
    allowed.push((await replicaB.bump(key, t0 + 1, window, max)).allowed);
    allowed.push((await replicaA.bump(key, t0 + 2, window, max)).allowed);
    allowed.push((await replicaB.bump(key, t0 + 3, window, max)).allowed);
    allowed.push((await replicaA.bump(key, t0 + 4, window, max)).allowed);
    allowed.push((await replicaB.bump(key, t0 + 5, window, max)).allowed);

    expect(allowed).toEqual([true, true, true, false, false, false]);
    await redis.quit();
  });

  it("falls back to in-memory in dev when Redis is not configured", () => {
    // The module-level singleton store is selected at import time from
    // RATE_LIMIT_STORE. Test env never sets it to "redis", so the
    // shared store is the InMemoryStore — i.e. the dev fallback path.
    // This test just pins that contract: ipRateLimit still works with
    // the unset env var and uses the shared in-memory bucket.
    expect(__test__.store.kind).toBe("memory");
    expect(__test__.store).toBeInstanceOf(__test__.InMemoryStore);
  });
});

/**
 * Namespace contract: `ipRateLimit` and `apiRateLimit` now share the
 * SAME singleton bucket store, so their key formats MUST be disjoint.
 * If a future refactor accidentally shortened the `iprl:` prefix or
 * an `apiRateLimit` mount got the literal name `"iprl"`, the two
 * limiters would silently start sharing buckets — which would either
 * over-restrict legitimate traffic (an OTP throttle eating into the
 * generic API quota) or under-restrict abuse (an IP-keyed bucket
 * letting through a tier-keyed identity it never observed).
 *
 * This test pins the contract at the bucket-key level rather than by
 * staring at strings: we run requests through both middlewares from
 * the same IP / same logical name and assert that exhausting one does
 * not leak into the other.
 */
describe("ipRateLimit namespace isolation from apiRateLimit", () => {
  it("does not collide with an apiRateLimit bucket of the same name", async () => {
    // Late import so we pick up the same singleton store our beforeEach
    // already wiped — apiRateLimit is loaded as a side effect via
    // ipRateLimit's import chain, so this is just a named handle.
    const { apiRateLimit } = await import("./apiRateLimit");
    const ip = ipRateLimit({ name: "shared", windowMs: 60_000, max: 1 });
    const api = apiRateLimit({ name: "shared", windowMs: 60_000, max: 1 });

    // Exhaust the IP bucket first.
    expect((await runMw(ip, makeReq("4.4.4.4"), makeRes())).called).toBe(true);
    const ipReject = makeRes();
    await runMw(ip, makeReq("4.4.4.4"), ipReject);
    expect(ipReject.statusCode).toBe(429);

    // Same identity / same logical bucket name on the api limiter
    // must still be admitted — different namespace, different key.
    const apiAllow = makeRes();
    const apiResult = await runMw(api, makeReq("4.4.4.4"), apiAllow);
    expect(apiResult.called).toBe(true);
    expect(apiAllow.statusCode).toBe(0);
  });
});
