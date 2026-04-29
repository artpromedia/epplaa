import { describe, it, expect, beforeEach } from "vitest";
import { assertStubFulfillmentSafe } from "./bootGuard";
import { __resetProductionEnvCacheForTests } from "../productionSignals";

// The boot-time guard for `STUB_FULFILLMENT=1` mirrors
// `assertRehearsalKillSwitchSafe` in `routes/healthzRehearsal.ts`: a
// misconfigured production deploy must crash-loop in the platform
// health check rather than wait for the first carrier failure to
// surface the synthetic-data fallback. We verify both the staging-
// allowed path (must not block) and the production-rejected path
// (must block + log a clear, actionable error).

type ErrorCall = [obj: unknown, msg: string];

function buildLogSink(): {
  error: (obj: unknown, msg: string) => void;
  calls: ErrorCall[];
} {
  const calls: ErrorCall[] = [];
  return {
    error: (obj, msg) => {
      calls.push([obj, msg]);
    },
    calls,
  };
}

beforeEach(() => {
  // The hostname-pattern compile result is cached at module level so
  // a bad pattern only logs once per unique value. Reset between tests
  // so each test sees a fresh cache and "did this call log?"
  // assertions are deterministic.
  __resetProductionEnvCacheForTests();
});

describe("assertStubFulfillmentSafe — staging-allowed paths", () => {
  it("allows boot when STUB_FULFILLMENT is unset (the common production case)", () => {
    const log = buildLogSink();
    const result = assertStubFulfillmentSafe(
      { NODE_ENV: "production" },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("allows boot when STUB_FULFILLMENT=1 in a non-production environment (staging)", () => {
    const log = buildLogSink();
    const result = assertStubFulfillmentSafe(
      { NODE_ENV: "staging", STUB_FULFILLMENT: "1" },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("allows boot when STUB_FULFILLMENT=1 with NODE_ENV=development (local-dev parity)", () => {
    const log = buildLogSink();
    const result = assertStubFulfillmentSafe(
      { NODE_ENV: "development", STUB_FULFILLMENT: "1" },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("allows boot in production when STUB_FULFILLMENT is anything other than '1'", () => {
    // Mirrors the per-request guard convention: only the literal "1"
    // counts as the stub-fallback opt-in. A leftover
    // `STUB_FULFILLMENT=0` (or "true" / "yes" / " 1 ") must not block
    // a legitimate production boot.
    const log = buildLogSink();
    for (const bogus of ["0", "true", "false", "yes", "no", "on", "off", " 1 "]) {
      const result = assertStubFulfillmentSafe(
        { NODE_ENV: "production", STUB_FULFILLMENT: bogus },
        log,
      );
      expect(result.ok, `bogus=${bogus}`).toBe(true);
    }
    expect(log.calls).toEqual([]);
  });

  it("allows boot on a staging hostname when PRODUCTION_HOSTNAME_PATTERN is configured", () => {
    // The hostname check is opt-in: an operator configures the regex
    // of *production* hostnames, and any host that doesn't match
    // (e.g. staging) is allowed.
    const log = buildLogSink();
    const result = assertStubFulfillmentSafe(
      {
        NODE_ENV: "staging",
        STUB_FULFILLMENT: "1",
        HOSTNAME: "api.staging.epplaa.com",
        PRODUCTION_HOSTNAME_PATTERN: "^api\\.epplaa\\.com$",
      },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });
});

describe("assertStubFulfillmentSafe — production-rejected paths", () => {
  it("REJECTS boot when STUB_FULFILLMENT=1 with NODE_ENV=production", () => {
    const log = buildLogSink();
    const result = assertStubFulfillmentSafe(
      { NODE_ENV: "production", STUB_FULFILLMENT: "1" },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");

    // The error message must be actionable enough that an operator
    // reading the crash log knows exactly which env var to unset and
    // where to read more.
    expect(result.reason).toMatch(/STUB_FULFILLMENT/);
    expect(result.reason).toMatch(/NODE_ENV=production/);
    expect(result.reason).toMatch(/staging-only/i);
    expect(result.reason).toMatch(/staging-only-endpoints/i);

    // The structured log must surface the offending env so the
    // pager-page recipient can confirm the misconfiguration without
    // shelling onto the box.
    expect(log.calls).toHaveLength(1);
    const [obj, msg] = log.calls[0]!;
    expect(obj).toMatchObject({
      node_env: "production",
      stub_fulfillment: "1",
      production_signals: ["node_env"],
    });
    expect(msg).toMatch(/stub_fulfillment_kill_switch_on_in_production/);
  });

  it("REJECTS boot when STUB_FULFILLMENT=1 with REPLIT_DEPLOYMENT=1 (Replit production deployment)", () => {
    // The Replit platform sets REPLIT_DEPLOYMENT=1 on production
    // deployments. Even if NODE_ENV is unset the guard must trip on
    // this signal alone.
    const log = buildLogSink();
    const result = assertStubFulfillmentSafe(
      { STUB_FULFILLMENT: "1", REPLIT_DEPLOYMENT: "1" },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/REPLIT_DEPLOYMENT=1/);
    expect(log.calls).toHaveLength(1);
    const [obj] = log.calls[0]!;
    expect(obj).toMatchObject({
      replit_deployment: "1",
      production_signals: ["replit_deployment"],
    });
  });

  it("REJECTS boot when STUB_FULFILLMENT=1 with DEPLOYMENT_ENVIRONMENT=production", () => {
    // Generic deployment-env env var that some IaC stacks set
    // independently of NODE_ENV. Trips the guard on its own.
    const log = buildLogSink();
    const result = assertStubFulfillmentSafe(
      { STUB_FULFILLMENT: "1", DEPLOYMENT_ENVIRONMENT: "production" },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/DEPLOYMENT_ENVIRONMENT=production/);
    expect(log.calls).toHaveLength(1);
    const [obj] = log.calls[0]!;
    expect(obj).toMatchObject({
      deployment_environment: "production",
      production_signals: ["deployment_environment"],
    });
  });

  it("REJECTS boot when HOSTNAME matches PRODUCTION_HOSTNAME_PATTERN even with NODE_ENV unset", () => {
    // The whole point of the hostname backstop: NODE_ENV is unset
    // (or "staging") yet the host is the real production host. The
    // guard must still fire because a misconfigured deploy serving
    // the production URL would silently substitute synthetic carrier
    // data on real-call failure.
    const log = buildLogSink();
    const result = assertStubFulfillmentSafe(
      {
        STUB_FULFILLMENT: "1",
        HOSTNAME: "api.epplaa.com",
        PRODUCTION_HOSTNAME_PATTERN: "^api\\.epplaa\\.com$",
      },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/HOSTNAME=api\.epplaa\.com/);
    expect(result.reason).toMatch(/PRODUCTION_HOSTNAME_PATTERN/);
    expect(log.calls).toHaveLength(1);
    const [obj] = log.calls[0]!;
    expect(obj).toMatchObject({
      hostname: "api.epplaa.com",
      production_signals: ["hostname"],
    });
  });

  it("aggregates multiple production signals into a single structured log so on-call sees every offender at once", () => {
    // If more than one signal is true, the guard must list ALL of
    // them in one error so the operator doesn't have to re-deploy and
    // re-fail to discover the next signal.
    const log = buildLogSink();
    const result = assertStubFulfillmentSafe(
      {
        NODE_ENV: "production",
        STUB_FULFILLMENT: "1",
        HOSTNAME: "api.epplaa.com",
        PRODUCTION_HOSTNAME_PATTERN: "^api\\.epplaa\\.com$",
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
    expect(result.reason).toMatch(/HOSTNAME=api\.epplaa\.com/);
    expect(log.calls).toHaveLength(1);
    const [obj] = log.calls[0]!;
    expect(obj).toMatchObject({
      production_signals: [
        "node_env",
        "replit_deployment",
        "deployment_environment",
        "hostname",
      ],
    });
  });
});
