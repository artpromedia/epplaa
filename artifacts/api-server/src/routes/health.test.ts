import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const dbExecuteMock = vi.fn();
const pingRedisMock = vi.fn();
let storeStatusMock: {
  kind: "memory" | "redis";
  state: "healthy" | "degraded";
  failureCount: number;
  firstFailureAt: number | null;
  lastRecoveredAt: number | null;
} = {
  kind: "redis",
  state: "healthy",
  failureCount: 0,
  firstFailureAt: null,
  lastRecoveredAt: null,
};

vi.mock("../lib/db", () => ({
  db: {
    execute: (...args: unknown[]) => dbExecuteMock(...args),
  },
}));

vi.mock("../middlewares/apiRateLimit", () => ({
  getRateLimitStoreKind: () => "redis",
  getRateLimitStoreStatus: () => storeStatusMock,
  pingRateLimitRedis: (...args: unknown[]) => pingRedisMock(...args),
}));

vi.mock("../lib/logger", () => ({
  logger: {
    warn: () => {},
    error: () => {},
    info: () => {},
  },
}));

const { dbHealthWatcher } = await import("../lib/subsystemHealth");
const { default: healthRouter, getReadyzConfigBlock } = await import("./health");
const { __resetProductionEnvCacheForTests } = await import(
  "../lib/productionSignals"
);

function buildApp(): Express {
  const app = express();
  app.use(healthRouter);
  return app;
}

const PRODUCTION_CONFIG_ENV_KEYS = [
  "NODE_ENV",
  "REPLIT_DEPLOYMENT",
  "DEPLOYMENT_ENVIRONMENT",
  "PRODUCTION_HOSTNAME_PATTERN",
  "HOSTNAME",
] as const;

function clearProductionConfigEnv(): void {
  for (const k of PRODUCTION_CONFIG_ENV_KEYS) {
    delete process.env[k];
  }
}

beforeEach(() => {
  dbExecuteMock.mockReset();
  pingRedisMock.mockReset();
  storeStatusMock = {
    kind: "redis",
    state: "healthy",
    failureCount: 0,
    firstFailureAt: null,
    lastRecoveredAt: null,
  };
  dbHealthWatcher.__reset();
  clearProductionConfigEnv();
  __resetProductionEnvCacheForTests();
});

describe("GET /healthz (liveness)", () => {
  it("returns 200 with rateLimitStore + subsystems map even when dependencies are down", async () => {
    // Liveness should never reach the DB or Redis — verify by making
    // both mocks throw and asserting healthz still returns 200.
    dbExecuteMock.mockRejectedValue(new Error("nope"));
    pingRedisMock.mockResolvedValue({ ok: false, error: "nope" });
    const res = await request(buildApp()).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    // Legacy top-level rateLimitStore field stays for back-compat with
    // the older probe + dashboards.
    expect(res.body.rateLimitStore).toEqual({
      kind: "redis",
      state: "healthy",
      failureCount: 0,
      firstFailureAt: null,
      lastRecoveredAt: null,
    });
    // New canonical multi-subsystem map. Each entry must have the same
    // shape so a probe walking it doesn't need per-subsystem branching.
    expect(res.body.subsystems).toEqual({
      rateLimitStore: {
        state: "healthy",
        failureCount: 0,
        firstFailureAt: null,
        lastRecoveredAt: null,
      },
      db: {
        state: "healthy",
        failureCount: 0,
        firstFailureAt: null,
        lastRecoveredAt: null,
      },
    });
    expect(dbExecuteMock).not.toHaveBeenCalled();
    expect(pingRedisMock).not.toHaveBeenCalled();
  });

  it("reflects degraded → recovered transitions in rateLimitStore (legacy + subsystems map)", async () => {
    // Simulate the watcher snapshot moving through three states the way
    // it would in production as Redis fails, fails again, then recovers.
    // /healthz must surface each transition without restart.
    storeStatusMock = {
      kind: "redis",
      state: "degraded",
      failureCount: 1,
      firstFailureAt: 1_700_000_000_000,
      lastRecoveredAt: null,
    };
    let res = await request(buildApp()).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.rateLimitStore.state).toBe("degraded");
    expect(res.body.subsystems.rateLimitStore).toEqual({
      state: "degraded",
      failureCount: 1,
      firstFailureAt: 1_700_000_000_000,
      lastRecoveredAt: null,
    });

    // Streak deepens — failureCount climbs but firstFailureAt is sticky.
    storeStatusMock = {
      ...storeStatusMock,
      failureCount: 4,
    };
    res = await request(buildApp()).get("/healthz");
    expect(res.body.subsystems.rateLimitStore.failureCount).toBe(4);
    expect(res.body.subsystems.rateLimitStore.firstFailureAt).toBe(
      1_700_000_000_000,
    );

    // Redis recovers: state flips to healthy, the streak fields reset,
    // and lastRecoveredAt advances so dashboards can timeline the
    // incident from /healthz alone.
    storeStatusMock = {
      kind: "redis",
      state: "healthy",
      failureCount: 0,
      firstFailureAt: null,
      lastRecoveredAt: 1_700_000_005_000,
    };
    res = await request(buildApp()).get("/healthz");
    expect(res.body.subsystems.rateLimitStore).toEqual({
      state: "healthy",
      failureCount: 0,
      firstFailureAt: null,
      lastRecoveredAt: 1_700_000_005_000,
    });
  });

  it("surfaces a degraded DB streak in subsystems.db once /readyz has recorded failures", async () => {
    // Drive the dbHealthWatcher via /readyz the way the platform LB
    // would in production — a stuck DB outage should show up as a
    // degraded streak on /healthz without any extra plumbing.
    dbExecuteMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    pingRedisMock.mockResolvedValueOnce({ ok: true });
    await request(buildApp()).get("/readyz");

    const res = await request(buildApp()).get("/healthz");
    expect(res.body.subsystems.db.state).toBe("degraded");
    expect(typeof res.body.subsystems.db.firstFailureAt).toBe("number");
    expect(res.body.subsystems.db.failureCount).toBeGreaterThanOrEqual(1);
    // Other subsystems remain healthy — only the failing one is flagged.
    expect(res.body.subsystems.rateLimitStore.state).toBe("healthy");
  });

  it("clears the DB streak on /healthz once /readyz observes a successful DB ping", async () => {
    // Fail once, then succeed — the streak should close and
    // lastRecoveredAt should be populated.
    dbExecuteMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    pingRedisMock.mockResolvedValueOnce({ ok: true });
    await request(buildApp()).get("/readyz");
    dbExecuteMock.mockResolvedValueOnce({ rows: [] });
    pingRedisMock.mockResolvedValueOnce({ ok: true });
    await request(buildApp()).get("/readyz");

    const res = await request(buildApp()).get("/healthz");
    expect(res.body.subsystems.db.state).toBe("healthy");
    expect(res.body.subsystems.db.firstFailureAt).toBeNull();
    expect(typeof res.body.subsystems.db.lastRecoveredAt).toBe("number");
  });
});

describe("GET /readyz (readiness)", () => {
  it("returns 200 ready when DB and Redis are reachable", async () => {
    dbExecuteMock.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });
    pingRedisMock.mockResolvedValueOnce({ ok: true });
    const res = await request(buildApp()).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
    expect(res.body.checks).toEqual({ db: "ok", redis: "ok" });
    expect(res.body.failures).toBeUndefined();
    expect(res.body.rateLimitStore).toBe("redis");
    // The config block is always present (even on a non-production
    // staging boot like the default test env) so external probes can
    // assert its shape unconditionally — callers that only care about
    // production deploys filter on the value, not the field's
    // presence.
    expect(res.body.config).toEqual({
      productionHostnamePattern: "not_required",
    });
  });

  it("returns 200 ready and skips Redis when memory store is configured", async () => {
    dbExecuteMock.mockResolvedValueOnce({ rows: [] });
    pingRedisMock.mockResolvedValueOnce(null);
    const res = await request(buildApp()).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
    expect(res.body.checks).toEqual({ db: "ok", redis: "skipped" });
  });

  it("returns 503 not_ready with failure detail when DB is unreachable", async () => {
    dbExecuteMock.mockRejectedValueOnce(new Error("ECONNREFUSED 5432"));
    pingRedisMock.mockResolvedValueOnce({ ok: true });
    const res = await request(buildApp()).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("not_ready");
    expect(res.body.checks.db).toBe("failed");
    expect(res.body.checks.redis).toBe("ok");
    expect(res.body.failures.db).toContain("ECONNREFUSED");
  });

  it("returns 503 not_ready with failure detail when Redis ping fails", async () => {
    dbExecuteMock.mockResolvedValueOnce({ rows: [] });
    pingRedisMock.mockResolvedValueOnce({
      ok: false,
      error: "redis_ping_timeout_after_2000ms",
    });
    const res = await request(buildApp()).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("not_ready");
    expect(res.body.checks.db).toBe("ok");
    expect(res.body.checks.redis).toBe("failed");
    expect(res.body.failures.redis).toBe("redis_ping_timeout_after_2000ms");
  });

  it("reports both dependencies as failed when DB and Redis are both down", async () => {
    dbExecuteMock.mockRejectedValueOnce(new Error("db gone"));
    pingRedisMock.mockResolvedValueOnce({ ok: false, error: "redis gone" });
    const res = await request(buildApp()).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body.checks).toEqual({ db: "failed", redis: "failed" });
    expect(res.body.failures).toEqual({
      db: expect.stringContaining("db gone"),
      redis: "redis gone",
    });
  });

  it("treats a hung DB query as a failure via timeout", async () => {
    process.env.READYZ_DB_TIMEOUT_MS = "50";
    vi.resetModules();
    const { default: freshRouter } = await import("./health");
    const app = express();
    app.use(freshRouter);
    dbExecuteMock.mockImplementationOnce(() => new Promise(() => {}));
    pingRedisMock.mockResolvedValueOnce({ ok: true });
    const res = await request(app).get("/readyz");
    delete process.env.READYZ_DB_TIMEOUT_MS;
    expect(res.status).toBe(503);
    expect(res.body.checks.db).toBe("failed");
    expect(res.body.failures.db).toMatch(/db_timeout_after_\d+ms/);
  });

  it("ignores a malformed READYZ_DB_TIMEOUT_MS and uses the safe default", async () => {
    // Without sanitisation, Number("not-a-number") -> NaN -> setTimeout
    // fires immediately on every call and turns every probe into a 503.
    // The route must fall back to the 2s default when the env value is
    // missing, NaN, zero, or negative.
    for (const bogus of ["not-a-number", "0", "-5", ""]) {
      process.env.READYZ_DB_TIMEOUT_MS = bogus;
      vi.resetModules();
      const { default: freshRouter } = await import("./health");
      const app = express();
      app.use(freshRouter);
      dbExecuteMock.mockResolvedValueOnce({ rows: [] });
      pingRedisMock.mockResolvedValueOnce({ ok: true });
      const res = await request(app).get("/readyz");
      expect(res.status, `bogus=${bogus}`).toBe(200);
      expect(res.body.checks.db).toBe("ok");
    }
    delete process.env.READYZ_DB_TIMEOUT_MS;
  });

  // -------------------------------------------------------------------
  // Production-config block (task #89): the response body must surface
  // the operator-set `PRODUCTION_HOSTNAME_PATTERN` status so an
  // external probe can page on-call when a production deploy ships
  // without the hostname backstop. Crucially, the config status MUST
  // NOT influence the ready/not_ready decision — failing readiness for
  // a configuration warning would drain the replica out of rotation,
  // which is more disruptive than the marginal security gain (the
  // boot-time check `assertProductionHostnamePatternConfigured` made
  // the same trade-off).
  // -------------------------------------------------------------------

  it("includes config.productionHostnamePattern='configured' on a production-shaped deploy with the env set", async () => {
    process.env.NODE_ENV = "production";
    process.env.PRODUCTION_HOSTNAME_PATTERN = "^api\\.epplaa\\.com$";
    dbExecuteMock.mockResolvedValueOnce({ rows: [] });
    pingRedisMock.mockResolvedValueOnce({ ok: true });
    const res = await request(buildApp()).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body.config.productionHostnamePattern).toBe("configured");
  });

  it("includes config.productionHostnamePattern='missing' on a production-shaped deploy with the env unset — but stays ready (200) so the LB does not drain", async () => {
    // The whole point of the new field: surface the misconfiguration
    // without taking the replica out of rotation. An external probe
    // pages on this without affecting user traffic.
    process.env.NODE_ENV = "production";
    dbExecuteMock.mockResolvedValueOnce({ rows: [] });
    pingRedisMock.mockResolvedValueOnce({ ok: true });
    const res = await request(buildApp()).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
    expect(res.body.config.productionHostnamePattern).toBe("missing");
  });

  it("reports config.productionHostnamePattern='missing' for every production signal (NODE_ENV / REPLIT_DEPLOYMENT / DEPLOYMENT_ENVIRONMENT)", async () => {
    // Each non-hostname production signal is sufficient on its own to
    // require the hostname backstop; the probe must page on any of
    // them. A regression that only checked NODE_ENV would silently
    // exempt a Replit-platform-marked production deploy that runs
    // with NODE_ENV unset.
    for (const env of [
      { NODE_ENV: "production" },
      { REPLIT_DEPLOYMENT: "1" },
      { DEPLOYMENT_ENVIRONMENT: "production" },
    ]) {
      clearProductionConfigEnv();
      __resetProductionEnvCacheForTests();
      Object.assign(process.env, env);
      dbExecuteMock.mockResolvedValueOnce({ rows: [] });
      pingRedisMock.mockResolvedValueOnce({ ok: true });
      const res = await request(buildApp()).get("/readyz");
      expect(
        res.body.config.productionHostnamePattern,
        `env=${JSON.stringify(env)}`,
      ).toBe("missing");
    }
  });

  it("treats whitespace-only PRODUCTION_HOSTNAME_PATTERN as missing on a production deploy", async () => {
    // `compileHostnamePattern` already trims and ignores whitespace-
    // only values, so a pattern of "   " silently disables the
    // hostname signal. The probe must surface that the same way as
    // an unset env var.
    process.env.NODE_ENV = "production";
    process.env.PRODUCTION_HOSTNAME_PATTERN = "   ";
    dbExecuteMock.mockResolvedValueOnce({ rows: [] });
    pingRedisMock.mockResolvedValueOnce({ ok: true });
    const res = await request(buildApp()).get("/readyz");
    expect(res.body.config.productionHostnamePattern).toBe("missing");
  });

  it("includes the same config block on a 503 not_ready response (so probes can verify config even during a dependency outage)", async () => {
    // A misconfigured pattern + a downstream outage is the worst-case
    // combination — we still want the probe to page on the config
    // miss even while the replica is draining. Asserting the field
    // shape on the 503 path proves that.
    process.env.NODE_ENV = "production";
    dbExecuteMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    pingRedisMock.mockResolvedValueOnce({ ok: true });
    const res = await request(buildApp()).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body.config.productionHostnamePattern).toBe("missing");
  });
});

describe("getReadyzConfigBlock — pure helper", () => {
  // The pure helper is the source of truth surfaced on /readyz. The
  // route-level tests above exercise the wire shape; these tests pin
  // down each branch of the helper so a future addition (e.g. a new
  // boot-time-config check) doesn't accidentally regress an existing
  // status mapping.

  it("returns 'not_required' when no production signal is observed", () => {
    expect(getReadyzConfigBlock({ NODE_ENV: "staging" })).toEqual({
      productionHostnamePattern: "not_required",
    });
    expect(getReadyzConfigBlock({})).toEqual({
      productionHostnamePattern: "not_required",
    });
  });

  it("returns 'configured' when production-shaped AND env var set", () => {
    expect(
      getReadyzConfigBlock({
        NODE_ENV: "production",
        PRODUCTION_HOSTNAME_PATTERN: "^api\\.epplaa\\.com$",
      }),
    ).toEqual({ productionHostnamePattern: "configured" });
  });

  it("returns 'missing' when production-shaped AND env var unset/blank", () => {
    expect(
      getReadyzConfigBlock({ NODE_ENV: "production" }),
    ).toEqual({ productionHostnamePattern: "missing" });
    expect(
      getReadyzConfigBlock({
        REPLIT_DEPLOYMENT: "1",
        PRODUCTION_HOSTNAME_PATTERN: "",
      }),
    ).toEqual({ productionHostnamePattern: "missing" });
  });

  it("treats a malformed-but-non-empty pattern as 'configured' (the malformed-regex error is logged elsewhere)", () => {
    // Mirrors `assertProductionHostnamePatternConfigured`: a typo'd
    // regex still counts as "operator set the env var" so the probe
    // doesn't double-page on a misconfiguration the
    // `production_hostname_pattern_invalid` log already surfaces.
    expect(
      getReadyzConfigBlock({
        NODE_ENV: "production",
        PRODUCTION_HOSTNAME_PATTERN: "[invalid(regex",
      }),
    ).toEqual({ productionHostnamePattern: "configured" });
  });
});
