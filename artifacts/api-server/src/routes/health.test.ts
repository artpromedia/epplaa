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

// Use a mutable holder so individual tests can flip the running
// rate-limit-store kind without re-resetting the whole module mock.
// Mirrors how `storeStatusMock` is shared across tests above.
let storeKindMock: "memory" | "redis" = "redis";

vi.mock("../middlewares/apiRateLimit", () => ({
  getRateLimitStoreKind: () => storeKindMock,
  getRateLimitStoreStatus: () => storeStatusMock,
  // Pure helper — re-implemented here in the mock rather than imported
  // via `vi.importActual` because importing the real apiRateLimit
  // module has init-time side effects (constructing the singleton
  // bucket store, optionally connecting to Redis, scheduling a sweep
  // interval) that this route-level test deliberately avoids. The
  // helper's branch coverage lives in `apiRateLimit.test.ts`; here
  // we only need it to behave consistently for the route's
  // composition.
  getRateLimitStoreReadyzStatus: (
    currentStoreKind: "memory" | "redis",
    env: NodeJS.ProcessEnv,
  ): string => {
    if (currentStoreKind === "redis") return "redis";
    const productionShaped =
      env.NODE_ENV === "production" ||
      env.REPLIT_DEPLOYMENT === "1" ||
      env.DEPLOYMENT_ENVIRONMENT === "production";
    if (!productionShaped) return "memory_not_required";
    if (env.RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION === "1") {
      return "memory_opt_out_acknowledged";
    }
    return "memory_misconfigured";
  },
  pingRateLimitRedis: (...args: unknown[]) => pingRedisMock(...args),
}));

vi.mock("../lib/logger", () => ({
  logger: {
    warn: () => {},
    error: () => {},
    info: () => {},
  },
}));

const {
  auditHealthWatcher,
  dbHealthWatcher,
  registerPaymentGatewayWatcher,
  __resetPaymentGatewayWatchersForTests,
} = await import("../lib/subsystemHealth");
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
  "HEALTHZ_REHEARSAL_ENABLED",
  "STUB_FULFILLMENT",
  "RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION",
  "SENTRY_DSN",
  // Dependency-probe env vars — cleared so the probes default to
  // disabled in every test that doesn't explicitly opt them in.
  "READYZ_PROBE_CLERK",
  "READYZ_CLERK_URL",
  "READYZ_CLERK_TIMEOUT_MS",
  "READYZ_PROBE_PAYSTACK",
  "READYZ_PAYSTACK_URL",
  "READYZ_PAYSTACK_TIMEOUT_MS",
  "READYZ_PROBE_FLUTTERWAVE",
  "READYZ_FLUTTERWAVE_URL",
  "READYZ_FLUTTERWAVE_TIMEOUT_MS",
] as const;

// Reused across the route-level and helper tests so adding a new
// optional probe doesn't require touching every assertion site.
const DEFAULT_PROBES_CONFIG = {
  clerk: { enabled: false, url: "https://api.clerk.com", timeoutMs: 2000 },
  paystack: {
    enabled: false,
    url: "https://api.paystack.co",
    timeoutMs: 2000,
  },
  flutterwave: {
    enabled: false,
    url: "https://api.flutterwave.com",
    timeoutMs: 2000,
  },
};

// Default config-block shape on a clean dev/staging env. Every new
// test assertion either compares against this baseline or overrides
// the specific fields it cares about — the goal is that adding a
// new readyz config field doesn't require touching every test that
// only cared about hostname pattern (etc.).
const DEFAULT_CONFIG_BLOCK = {
  productionHostnamePattern: "not_required",
  rehearsalInjectorEnabled: "disabled",
  stubFulfillmentEnabled: "disabled",
  // The mocked `getRateLimitStoreKind` returns "redis" so the readyz
  // status helper short-circuits to "redis" regardless of env shape.
  rateLimitStore: "redis",
  sentryDsn: "not_required",
  dependencyProbes: DEFAULT_PROBES_CONFIG,
};

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
  storeKindMock = "redis";
  dbHealthWatcher.__reset();
  auditHealthWatcher.__reset();
  __resetPaymentGatewayWatchersForTests();
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
    expect(typeof res.body.replicaId).toBe("string");
    expect(res.body.replicaId.length).toBeGreaterThan(0);
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
      auditChain: {
        state: "healthy",
        failureCount: 0,
        firstFailureAt: null,
        lastRecoveredAt: null,
      },
    });
    expect(dbExecuteMock).not.toHaveBeenCalled();
    expect(pingRedisMock).not.toHaveBeenCalled();
  });

  it("surfaces a degraded audit pipeline streak in subsystems.auditChain when recordAudit has been failing", async () => {
    // The audit-chain watcher is fed by recordAudit success/failure
    // in lib/audit.ts. When DB pressure causes a sustained run of
    // failed audit writes, the in-process watcher accumulates a
    // streak that /healthz must surface — otherwise the
    // duration alert can't see the compliance gap. We exercise the
    // watcher directly here (audit.ts is unit-covered in its own
    // file) and assert /healthz round-trips the snapshot under the
    // canonical `auditChain` key.
    const FIRST_FAILURE_AT = 1_700_000_000_000;
    auditHealthWatcher.__injectStreak(FIRST_FAILURE_AT, 17);

    const res = await request(buildApp()).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.subsystems.auditChain).toEqual({
      state: "degraded",
      failureCount: 17,
      firstFailureAt: FIRST_FAILURE_AT,
      lastRecoveredAt: null,
    });
    // Sibling subsystems are unaffected — the audit pipeline is the
    // only one degraded, the duration alert pages naming exactly it.
    expect(res.body.subsystems.rateLimitStore.state).toBe("healthy");
    expect(res.body.subsystems.db.state).toBe("healthy");
  });

  it("clears the audit pipeline streak in subsystems.auditChain after a successful recordAudit", async () => {
    // Recovery path: a sustained outage that has been paging on-call
    // must self-heal once the next audit write succeeds, so the
    // duration alert auto-resolves without manual intervention.
    auditHealthWatcher.record(1_700_000_000_000);
    auditHealthWatcher.record(1_700_000_005_000);
    expect(auditHealthWatcher.getSnapshot().state).toBe("degraded");

    auditHealthWatcher.recordSuccess(1_700_000_010_000);
    const res = await request(buildApp()).get("/healthz");
    expect(res.body.subsystems.auditChain).toEqual({
      state: "healthy",
      failureCount: 0,
      firstFailureAt: null,
      lastRecoveredAt: 1_700_000_010_000,
    });
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

  it("exposes one entry per registered payment gateway under paymentGateway<Name> keys, healthy by default", async () => {
    // The map shape is the contract the duration alert
    // (`scripts/checkHealthzDegraded.ts`) iterates: each registered
    // real gateway must show up with the same `{ state,
    // failureCount, firstFailureAt, lastRecoveredAt }` shape as the
    // existing rateLimitStore + db entries so the probe doesn't
    // need per-subsystem branching.
    registerPaymentGatewayWatcher("paystack");
    registerPaymentGatewayWatcher("flutterwave");
    const res = await request(buildApp()).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.subsystems.paymentGatewayPaystack).toEqual({
      state: "healthy",
      failureCount: 0,
      firstFailureAt: null,
      lastRecoveredAt: null,
    });
    expect(res.body.subsystems.paymentGatewayFlutterwave).toEqual({
      state: "healthy",
      failureCount: 0,
      firstFailureAt: null,
      lastRecoveredAt: null,
    });
  });

  it("does NOT expose any paymentGateway* entry when no real gateway is configured (dev-mock fallback)", async () => {
    // A deploy without PAYSTACK_SECRET_KEY / FLUTTERWAVE_SECRET_KEY
    // routes to DevMockGateway whose "success" is fake. Publishing a
    // permanently-healthy `paymentGatewayDevmock` entry would mask
    // the matching `payment_provider_missing_for_production` boot
    // warning during triage, so the registry stays empty and only
    // the canonical non-payment subsystem entries (rateLimitStore,
    // db, auditChain) are exposed.
    const res = await request(buildApp()).get("/healthz");
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.subsystems).sort()).toEqual([
      "auditChain",
      "db",
      "rateLimitStore",
    ]);
    for (const k of Object.keys(res.body.subsystems)) {
      expect(k.startsWith("paymentGateway")).toBe(false);
    }
  });

  it("flips a payment gateway entry to degraded with a sticky firstFailureAt across the failure streak", async () => {
    // Mirror the rate-limit-store + db tests: a stuck-degraded
    // gateway must surface as `state=degraded` with a stable
    // `firstFailureAt` even as `failureCount` climbs across
    // successive failed charges. This is the timestamp the duration
    // alert subtracts from `Date.now()` to decide whether to page.
    const watcher = registerPaymentGatewayWatcher("paystack");
    watcher.record(1_700_000_000_000);
    watcher.record(1_700_000_001_000);
    watcher.record(1_700_000_002_000);

    let res = await request(buildApp()).get("/healthz");
    expect(res.body.subsystems.paymentGatewayPaystack).toEqual({
      state: "degraded",
      failureCount: 3,
      firstFailureAt: 1_700_000_000_000,
      lastRecoveredAt: null,
    });

    // Streak deepens — failureCount climbs but firstFailureAt is
    // sticky so the duration alert keeps measuring against the
    // original start of the incident, not the most recent failure.
    watcher.record(1_700_000_003_000);
    res = await request(buildApp()).get("/healthz");
    expect(res.body.subsystems.paymentGatewayPaystack.failureCount).toBe(4);
    expect(res.body.subsystems.paymentGatewayPaystack.firstFailureAt).toBe(
      1_700_000_000_000,
    );
  });

  it("clears the payment gateway streak and stamps lastRecoveredAt on the next successful charge", async () => {
    // Recovery semantics must match the other watchers: a single
    // success closes the streak, resets the counters, and stamps
    // `lastRecoveredAt` so dashboards can timeline the incident
    // without grepping logs.
    const watcher = registerPaymentGatewayWatcher("paystack");
    watcher.record(1_700_000_000_000);
    watcher.record(1_700_000_001_000);
    watcher.recordSuccess(1_700_000_005_000);

    const res = await request(buildApp()).get("/healthz");
    expect(res.body.subsystems.paymentGatewayPaystack).toEqual({
      state: "healthy",
      failureCount: 0,
      firstFailureAt: null,
      lastRecoveredAt: 1_700_000_005_000,
    });
  });

  it("flags ONE gateway as degraded while a co-registered gateway stays healthy (independent failure modes)", async () => {
    // The whole reason for per-gateway watchers (vs. one combined
    // `paymentGateway` entry): Paystack stuck while Flutterwave
    // absorbs failover traffic must page on Paystack alone. A
    // shared watcher would reset the moment Flutterwave succeeded.
    const paystack = registerPaymentGatewayWatcher("paystack");
    registerPaymentGatewayWatcher("flutterwave");
    paystack.record(1_700_000_000_000);
    paystack.record(1_700_000_001_000);

    const res = await request(buildApp()).get("/healthz");
    expect(res.body.subsystems.paymentGatewayPaystack.state).toBe(
      "degraded",
    );
    expect(res.body.subsystems.paymentGatewayPaystack.firstFailureAt).toBe(
      1_700_000_000_000,
    );
    expect(res.body.subsystems.paymentGatewayFlutterwave.state).toBe(
      "healthy",
    );
    expect(
      res.body.subsystems.paymentGatewayFlutterwave.firstFailureAt,
    ).toBeNull();
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
    expect(typeof res.body.replicaId).toBe("string");
    expect(res.body.replicaId.length).toBeGreaterThan(0);
    expect(res.body.checks).toEqual({
      db: "ok",
      redis: "ok",
      clerk: "skipped",
      paystack: "skipped",
      flutterwave: "skipped",
    });
    expect(res.body.failures).toBeUndefined();
    expect(res.body.rateLimitStore).toBe("redis");
    // The config block is always present (even on a non-production
    // staging boot like the default test env) so external probes can
    // assert its shape unconditionally — callers that only care about
    // production deploys filter on the value, not the field's
    // presence. The block now surfaces every high-risk operator-set
    // setting (task #101) plus the opt-in dependency-probe config
    // (task #91); on a clean dev env every status defaults to a
    // non-paging value so the probe stays silent.
    expect(res.body.config).toEqual(DEFAULT_CONFIG_BLOCK);
  });

  it("returns 200 ready and skips Redis when memory store is configured", async () => {
    dbExecuteMock.mockResolvedValueOnce({ rows: [] });
    pingRedisMock.mockResolvedValueOnce(null);
    const res = await request(buildApp()).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
    expect(res.body.checks).toEqual({
      db: "ok",
      redis: "skipped",
      clerk: "skipped",
      paystack: "skipped",
      flutterwave: "skipped",
    });
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
    expect(typeof res.body.replicaId).toBe("string");
    expect(res.body.replicaId.length).toBeGreaterThan(0);
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
    expect(res.body.checks).toEqual({
      db: "failed",
      redis: "failed",
      clerk: "skipped",
      paystack: "skipped",
      flutterwave: "skipped",
    });
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
    // The other config fields must also be present on 503 — a probe
    // that only inspected hostnamePattern would silently drop the
    // newer status fields during a dependency outage. Asserting the
    // full shape locks the contract in.
    expect(res.body.config.rehearsalInjectorEnabled).toBe("disabled");
    expect(res.body.config.stubFulfillmentEnabled).toBe("disabled");
    expect(res.body.config.rateLimitStore).toBe("redis");
    // SENTRY_DSN is unset on this prod-shaped test → "missing"; this
    // is a paging state and exercises the worst-case "everything is
    // wrong" combination the probe must surface in one response.
    expect(res.body.config.sentryDsn).toBe("missing");
  });

  // -------------------------------------------------------------------
  // New config fields (task #101): each high-risk operator-set boot-
  // time setting now has a tri-state status on /readyz so the
  // generalised post-deploy probe (`scripts/checkReadyzConfig.ts`)
  // can page on-call when ANY of them is in a dangerous combination
  // — not just hostname pattern. The boot-time guards already crash-
  // loop most of these, but the readyz surface adds the runtime
  // probe so a hot env-var rotation or post-boot platform-side
  // change is still caught.
  // -------------------------------------------------------------------

  it("reports rehearsalInjectorEnabled='disabled' on a clean dev env", async () => {
    dbExecuteMock.mockResolvedValueOnce({ rows: [] });
    pingRedisMock.mockResolvedValueOnce({ ok: true });
    const res = await request(buildApp()).get("/readyz");
    expect(res.body.config.rehearsalInjectorEnabled).toBe("disabled");
  });

  it("reports rehearsalInjectorEnabled='enabled_non_production' when the staging rehearsal flag is set on a non-prod deploy", async () => {
    // The intended state for staging — the rehearsal workflow
    // exercises the stuck-degraded probe end-to-end. The probe must
    // NOT page on this combination.
    process.env.HEALTHZ_REHEARSAL_ENABLED = "1";
    dbExecuteMock.mockResolvedValueOnce({ rows: [] });
    pingRedisMock.mockResolvedValueOnce({ ok: true });
    const res = await request(buildApp()).get("/readyz");
    expect(res.body.config.rehearsalInjectorEnabled).toBe(
      "enabled_non_production",
    );
  });

  it("reports rehearsalInjectorEnabled='enabled_in_production' when the staging flag leaks into a prod-shaped deploy — the page condition", async () => {
    // The boot guard would have already crash-looped this, but a hot
    // env-var rotation that flipped a production signal post-boot
    // can still land here. Page on-call so the deploy is restarted.
    process.env.HEALTHZ_REHEARSAL_ENABLED = "1";
    process.env.NODE_ENV = "production";
    dbExecuteMock.mockResolvedValueOnce({ rows: [] });
    pingRedisMock.mockResolvedValueOnce({ ok: true });
    const res = await request(buildApp()).get("/readyz");
    expect(res.body.status).toBe("ready");
    expect(res.body.config.rehearsalInjectorEnabled).toBe(
      "enabled_in_production",
    );
  });

  it("reports stubFulfillmentEnabled='enabled_in_production' when STUB_FULFILLMENT=1 on a prod-shaped deploy", async () => {
    process.env.STUB_FULFILLMENT = "1";
    process.env.REPLIT_DEPLOYMENT = "1";
    dbExecuteMock.mockResolvedValueOnce({ rows: [] });
    pingRedisMock.mockResolvedValueOnce({ ok: true });
    const res = await request(buildApp()).get("/readyz");
    // Carriers refuse the stub fallback in production regardless of
    // the env var (task #83), but the env var itself is wrong and
    // the probe surfaces that.
    expect(res.body.config.stubFulfillmentEnabled).toBe(
      "enabled_in_production",
    );
  });

  it("reports stubFulfillmentEnabled='enabled_non_production' when STUB_FULFILLMENT=1 on dev/CI (intended)", async () => {
    process.env.STUB_FULFILLMENT = "1";
    dbExecuteMock.mockResolvedValueOnce({ rows: [] });
    pingRedisMock.mockResolvedValueOnce({ ok: true });
    const res = await request(buildApp()).get("/readyz");
    expect(res.body.config.stubFulfillmentEnabled).toBe(
      "enabled_non_production",
    );
  });

  it("reports rateLimitStore='memory_misconfigured' when running on memory bucket on a prod-shaped deploy with no opt-out — the page condition", async () => {
    // The boot guard already crash-loops this combination on a clean
    // restart, but we surface the runtime status so a probe can
    // verify the deploy didn't reach steady-state via a hot env-var
    // rotation that bypassed the boot check.
    storeKindMock = "memory";
    process.env.NODE_ENV = "production";
    dbExecuteMock.mockResolvedValueOnce({ rows: [] });
    pingRedisMock.mockResolvedValueOnce(null);
    const res = await request(buildApp()).get("/readyz");
    expect(res.body.config.rateLimitStore).toBe("memory_misconfigured");
  });

  it("reports rateLimitStore='memory_opt_out_acknowledged' when memory-on-prod is explicitly opted into", async () => {
    // Single-replica production deploys (canary, internal-only
    // tools) opt into the in-process bucket via
    // RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION=1. The probe must
    // distinguish this warn-level state from the misconfigured page
    // state — opt-out is intentional and shouldn't fire the page.
    storeKindMock = "memory";
    process.env.NODE_ENV = "production";
    process.env.RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION = "1";
    dbExecuteMock.mockResolvedValueOnce({ rows: [] });
    pingRedisMock.mockResolvedValueOnce(null);
    const res = await request(buildApp()).get("/readyz");
    expect(res.body.config.rateLimitStore).toBe(
      "memory_opt_out_acknowledged",
    );
  });

  it("reports rateLimitStore='memory_not_required' when running memory bucket on a non-prod deploy", async () => {
    storeKindMock = "memory";
    dbExecuteMock.mockResolvedValueOnce({ rows: [] });
    pingRedisMock.mockResolvedValueOnce(null);
    const res = await request(buildApp()).get("/readyz");
    expect(res.body.config.rateLimitStore).toBe("memory_not_required");
  });

  it("reports rateLimitStore='redis' on any redis-backed deploy, even production-shaped", async () => {
    storeKindMock = "redis";
    process.env.NODE_ENV = "production";
    dbExecuteMock.mockResolvedValueOnce({ rows: [] });
    pingRedisMock.mockResolvedValueOnce({ ok: true });
    const res = await request(buildApp()).get("/readyz");
    expect(res.body.config.rateLimitStore).toBe("redis");
  });

  it("reports sentryDsn='missing' on a prod-shaped deploy with the DSN unset — the page condition", async () => {
    process.env.DEPLOYMENT_ENVIRONMENT = "production";
    dbExecuteMock.mockResolvedValueOnce({ rows: [] });
    pingRedisMock.mockResolvedValueOnce({ ok: true });
    const res = await request(buildApp()).get("/readyz");
    expect(res.body.config.sentryDsn).toBe("missing");
  });

  it("reports sentryDsn='configured' whenever the DSN is set, regardless of deploy shape", async () => {
    process.env.SENTRY_DSN =
      "https://abc@o123.ingest.sentry.io/456";
    dbExecuteMock.mockResolvedValueOnce({ rows: [] });
    pingRedisMock.mockResolvedValueOnce({ ok: true });
    const res = await request(buildApp()).get("/readyz");
    expect(res.body.config.sentryDsn).toBe("configured");
  });

  it("reports sentryDsn='not_required' on a clean dev env (DSN unset, no production signal)", async () => {
    dbExecuteMock.mockResolvedValueOnce({ rows: [] });
    pingRedisMock.mockResolvedValueOnce({ ok: true });
    const res = await request(buildApp()).get("/readyz");
    expect(res.body.config.sentryDsn).toBe("not_required");
  });
});

describe("GET /readyz — optional dependency probes (Clerk / payment gateways)", () => {
  // The probes default OFF and report `<name>: "skipped"` so a
  // misbehaving third party can't drain replicas without an explicit
  // opt-in. These tests pin down the four combinations that matter
  // operationally:
  //   1. Default (no flag): "skipped", does NOT fail readyz.
  //   2. Enabled + reachable: "ok", does NOT fail readyz.
  //   3. Enabled + network error: "failed", DOES fail readyz (503).
  //   4. Enabled + timeout: "failed" with the *_timeout_after_*ms
  //      marker, DOES fail readyz.
  //
  // We stub the global `fetch` so the probes never make real network
  // calls — `pingHttpEndpoint` captures `fetch` lazily at call time
  // via its default parameter, so a `vi.stubGlobal` per test suffices.
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    // Make DB / Redis paths green so the only failure source is the
    // probe under test.
    dbExecuteMock.mockResolvedValue({ rows: [] });
    pingRedisMock.mockResolvedValue({ ok: true });
  });

  function stubFetch(
    impl: (input: string | URL, init?: RequestInit) => Promise<Response>,
  ) {
    vi.stubGlobal("fetch", vi.fn(impl) as typeof fetch);
  }

  function restoreFetch() {
    vi.stubGlobal("fetch", realFetch);
  }

  it("reports each disabled probe as 'skipped' and stays ready", async () => {
    // Default test env has none of the READYZ_PROBE_* flags set.
    const res = await request(buildApp()).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
    expect(res.body.checks.clerk).toBe("skipped");
    expect(res.body.checks.paystack).toBe("skipped");
    expect(res.body.checks.flutterwave).toBe("skipped");
  });

  it("reports an enabled-and-reachable probe as 'ok' (any HTTP status counts as reachable)", async () => {
    process.env.READYZ_PROBE_CLERK = "1";
    process.env.READYZ_PROBE_PAYSTACK = "1";
    // 404 is intentionally chosen — the route doesn't care WHICH
    // status the probe got, only that one came back. A network
    // round-trip = the gateway is reachable.
    stubFetch(async () => new Response("not found", { status: 404 }));
    try {
      const res = await request(buildApp()).get("/readyz");
      expect(res.status).toBe(200);
      expect(res.body.checks.clerk).toBe("ok");
      expect(res.body.checks.paystack).toBe("ok");
      expect(res.body.checks.flutterwave).toBe("skipped");
      expect(res.body.failures).toBeUndefined();
    } finally {
      restoreFetch();
    }
  });

  it("returns 503 with a per-probe failure detail when the probe's fetch throws (DNS / TCP refused)", async () => {
    process.env.READYZ_PROBE_CLERK = "1";
    stubFetch(async () => {
      throw new Error("getaddrinfo ENOTFOUND api.clerk.com");
    });
    try {
      const res = await request(buildApp()).get("/readyz");
      expect(res.status).toBe(503);
      expect(res.body.status).toBe("not_ready");
      expect(res.body.checks.clerk).toBe("failed");
      expect(res.body.failures.clerk).toContain("ENOTFOUND");
    } finally {
      restoreFetch();
    }
  });

  it("translates an AbortError into the http_probe_timeout_after_*ms marker so failures.<name> stays uniform with the redis probe", async () => {
    process.env.READYZ_PROBE_CLERK = "1";
    process.env.READYZ_CLERK_TIMEOUT_MS = "25";
    // Never resolve — the AbortSignal will fire after 25ms and the
    // probe must translate that into a stable marker string. The
    // `signal` carries through so we can hook 'abort' and reject
    // with the same error name `fetch` would.
    stubFetch(
      (_input, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            (err as Error & { name: string }).name = "AbortError";
            reject(err);
          });
        }),
    );
    try {
      const res = await request(buildApp()).get("/readyz");
      expect(res.status).toBe(503);
      expect(res.body.checks.clerk).toBe("failed");
      expect(res.body.failures.clerk).toMatch(/http_probe_timeout_after_\d+ms/);
    } finally {
      restoreFetch();
      delete process.env.READYZ_CLERK_TIMEOUT_MS;
    }
  });

  it("treats a non-'1' flag value (e.g. 'true', '0') as disabled — strict matching prevents accidental opt-in via casing drift", async () => {
    // Same strictness as REPLIT_DEPLOYMENT=1 elsewhere in the boot
    // sequence so a typo doesn't enable a probe an operator didn't
    // intend to. We assert by NOT installing a fetch mock — if the
    // probe were enabled, a real fetch attempt would be made (and
    // either time out or throw network errors), failing readyz.
    process.env.READYZ_PROBE_CLERK = "true";
    process.env.READYZ_PROBE_PAYSTACK = "0";
    process.env.READYZ_PROBE_FLUTTERWAVE = " 1 ";
    const res = await request(buildApp()).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body.checks.clerk).toBe("skipped");
    expect(res.body.checks.paystack).toBe("skipped");
    expect(res.body.checks.flutterwave).toBe("skipped");
  });

  it("runs the probes in parallel, not serially, so the worst-case wait is one probe — not the sum", async () => {
    // Document the parallelism guarantee with a timing-based assertion.
    // Each probe waits 60ms; if the route serialised them the wall
    // time would be >180ms; in parallel it should land under ~120ms
    // even with vitest scheduling jitter.
    process.env.READYZ_PROBE_CLERK = "1";
    process.env.READYZ_PROBE_PAYSTACK = "1";
    process.env.READYZ_PROBE_FLUTTERWAVE = "1";
    stubFetch(
      () =>
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(new Response("", { status: 200 })), 60),
        ),
    );
    try {
      const t0 = Date.now();
      const res = await request(buildApp()).get("/readyz");
      const elapsed = Date.now() - t0;
      expect(res.status).toBe(200);
      expect(res.body.checks.clerk).toBe("ok");
      expect(res.body.checks.paystack).toBe("ok");
      expect(res.body.checks.flutterwave).toBe("ok");
      expect(elapsed).toBeLessThan(150);
    } finally {
      restoreFetch();
    }
  });

  it("a probe failure does NOT mask db/redis failures — every failed dependency surfaces under failures.<name>", async () => {
    process.env.READYZ_PROBE_CLERK = "1";
    dbExecuteMock.mockReset();
    dbExecuteMock.mockRejectedValueOnce(new Error("ECONNREFUSED 5432"));
    pingRedisMock.mockReset();
    pingRedisMock.mockResolvedValueOnce({ ok: true });
    stubFetch(async () => {
      throw new Error("clerk down");
    });
    try {
      const res = await request(buildApp()).get("/readyz");
      expect(res.status).toBe(503);
      expect(res.body.checks.db).toBe("failed");
      expect(res.body.checks.clerk).toBe("failed");
      expect(res.body.failures.db).toContain("ECONNREFUSED");
      expect(res.body.failures.clerk).toContain("clerk down");
    } finally {
      restoreFetch();
    }
  });

  it("uses the URL override from READYZ_<NAME>_URL so an operator can swap in a regional endpoint without a code change", async () => {
    process.env.READYZ_PROBE_CLERK = "1";
    process.env.READYZ_CLERK_URL = "https://clerk-eu.example/probe";
    const fetchMock = vi.fn(
      async () => new Response("", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock as typeof fetch);
    try {
      await request(buildApp()).get("/readyz");
      expect(fetchMock).toHaveBeenCalledWith(
        "https://clerk-eu.example/probe",
        expect.objectContaining({ method: "GET" }),
      );
    } finally {
      restoreFetch();
    }
  });
});

describe("getReadyzConfigBlock — pure helper", () => {
  // The pure helper is the source of truth surfaced on /readyz. The
  // route-level tests above exercise the wire shape; these tests pin
  // down the helper's per-field composition so a future addition
  // doesn't accidentally regress an existing status mapping.
  //
  // Each test passes the rate-limit-store kind explicitly so the
  // helper can be exercised without a singleton bucket store. The
  // route default (`getRateLimitStoreKind()`) is verified at the
  // route level via the existing readyz tests.

  it("returns the all-safe baseline on a clean env (every field at its non-paging value)", () => {
    expect(getReadyzConfigBlock({}, "redis")).toEqual({
      productionHostnamePattern: "not_required",
      rehearsalInjectorEnabled: "disabled",
      stubFulfillmentEnabled: "disabled",
      rateLimitStore: "redis",
      sentryDsn: "not_required",
      dependencyProbes: DEFAULT_PROBES_CONFIG,
    });
  });

  it("composes the production-shaped page-everything case in a single call", () => {
    // A production-shaped deploy with every dangerous combination
    // simultaneously lit. The helper must report the exact paging
    // status for each field independently — the per-setting probe
    // can then list every misconfiguration in one page body.
    expect(
      getReadyzConfigBlock(
        {
          NODE_ENV: "production",
          HEALTHZ_REHEARSAL_ENABLED: "1",
          STUB_FULFILLMENT: "1",
        },
        "memory",
      ),
    ).toEqual({
      productionHostnamePattern: "missing",
      rehearsalInjectorEnabled: "enabled_in_production",
      stubFulfillmentEnabled: "enabled_in_production",
      rateLimitStore: "memory_misconfigured",
      sentryDsn: "missing",
      dependencyProbes: DEFAULT_PROBES_CONFIG,
    });
  });

  it("composes the healthy-production case (every signal lit + every config configured)", () => {
    expect(
      getReadyzConfigBlock(
        {
          NODE_ENV: "production",
          PRODUCTION_HOSTNAME_PATTERN: "^api\\.epplaa\\.com$",
          SENTRY_DSN: "https://abc@o123.ingest.sentry.io/456",
        },
        "redis",
      ),
    ).toEqual({
      productionHostnamePattern: "configured",
      rehearsalInjectorEnabled: "disabled",
      stubFulfillmentEnabled: "disabled",
      rateLimitStore: "redis",
      sentryDsn: "configured",
      dependencyProbes: DEFAULT_PROBES_CONFIG,
    });
  });

  it("treats a malformed-but-non-empty pattern as 'configured' (the malformed-regex error is logged elsewhere)", () => {
    // Mirrors `assertProductionHostnamePatternConfigured`: a typo'd
    // regex still counts as "operator set the env var" so the probe
    // doesn't double-page on a misconfiguration the
    // `production_hostname_pattern_invalid` log already surfaces.
    expect(
      getReadyzConfigBlock(
        {
          NODE_ENV: "production",
          PRODUCTION_HOSTNAME_PATTERN: "[invalid(regex",
        },
        "redis",
      ).productionHostnamePattern,
    ).toBe("configured");
  });

  it("differentiates the rate-limit-store opt-out from the misconfigured page state", () => {
    // The opt-out path is intentional (single-replica production
    // canary / internal tools) and must NOT be lumped in with the
    // page-on-call misconfigured state. Mirrors the boot-time
    // `assertRateLimitStoreConfiguredForProduction` warn-vs-error
    // distinction.
    expect(
      getReadyzConfigBlock(
        {
          NODE_ENV: "production",
          RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION: "1",
        },
        "memory",
      ).rateLimitStore,
    ).toBe("memory_opt_out_acknowledged");
  });

  it("includes per-probe enabled/url/timeout in dependencyProbes when env flags are set", () => {
    // Strict matching on "1" — values like "true" / " 1 " stay
    // disabled. URL and timeout overrides flow through. Only the
    // dependency-probe sub-block is asserted here so this test is
    // not coupled to the rest of the config-block shape (which is
    // already pinned by the composite tests above).
    expect(
      getReadyzConfigBlock(
        {
          READYZ_PROBE_CLERK: "1",
          READYZ_CLERK_URL: "https://clerk.example/probe",
          READYZ_CLERK_TIMEOUT_MS: "1500",
          READYZ_PROBE_PAYSTACK: "true", // not "1" → stays disabled
          READYZ_PROBE_FLUTTERWAVE: "1",
          // No URL/timeout overrides for flutterwave → defaults apply.
        },
        "redis",
      ).dependencyProbes,
    ).toEqual({
      clerk: {
        enabled: true,
        url: "https://clerk.example/probe",
        timeoutMs: 1500,
      },
      paystack: {
        enabled: false,
        url: "https://api.paystack.co",
        timeoutMs: 2000,
      },
      flutterwave: {
        enabled: true,
        url: "https://api.flutterwave.com",
        timeoutMs: 2000,
      },
    });
  });

  it("falls back to the safe default for malformed timeouts and blank URLs", () => {
    // NaN / zero / negative timeouts would otherwise produce a timer
    // that fires immediately on every probe — same sanitisation as
    // READYZ_DB_TIMEOUT_MS. Whitespace-only URL falls back to the
    // documented default so an operator mis-pasting an env var
    // doesn't accidentally probe the empty string.
    const block = getReadyzConfigBlock(
      {
        READYZ_PROBE_CLERK: "1",
        READYZ_CLERK_URL: "   ",
        READYZ_CLERK_TIMEOUT_MS: "not-a-number",
        READYZ_PROBE_PAYSTACK: "1",
        READYZ_PAYSTACK_TIMEOUT_MS: "0",
        READYZ_PROBE_FLUTTERWAVE: "1",
        READYZ_FLUTTERWAVE_TIMEOUT_MS: "-5",
      },
      "redis",
    );
    expect(block.dependencyProbes.clerk).toEqual({
      enabled: true,
      url: "https://api.clerk.com",
      timeoutMs: 2000,
    });
    expect(block.dependencyProbes.paystack.timeoutMs).toBe(2000);
    expect(block.dependencyProbes.flutterwave.timeoutMs).toBe(2000);
  });
});
