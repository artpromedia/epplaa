import { describe, it, expect, beforeEach } from "vitest";
import {
  assertCarrierCredentialsConfiguredForProduction,
  assertStubFulfillmentSafe,
} from "./bootGuard";
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

// `assertCarrierCredentialsConfiguredForProduction` (Task #99) closes
// the second half of the synthetic-data threat model that
// `assertStubFulfillmentSafe` opened: when STUB_FULFILLMENT is unset
// AND the carrier credentials themselves are unset on a production
// deploy, each carrier's `isConfigured()` returns false and
// quote/dispatch/verify short-circuits to the stub path BEFORE the
// per-request `allowStubFallback()` production-signal guard ever
// runs (no real-call failure to trigger it). The boot guard must
// crash-loop the deploy unless the operator explicitly opts out
// per-carrier via DISABLE_CARRIER_{SHIPBUBBLE,GIG,OKHI}=1.

const ALL_CARRIER_CREDS = {
  SHIPBUBBLE_API_KEY: "shp_xxx",
  GIG_API_KEY: "gig_xxx",
  GIG_USERNAME: "gig_user",
  OKHI_API_KEY: "ok_test_xxx",
  OKHI_BRANCH_ID: "branch_xxx",
} as const;

describe("assertCarrierCredentialsConfiguredForProduction — staging-allowed paths", () => {
  it("allows boot on a non-production deploy with no creds at all (dev/CI baseline)", () => {
    const log = buildLogSink();
    const result = assertCarrierCredentialsConfiguredForProduction({}, log);
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("allows boot when NODE_ENV=staging even with no carrier creds", () => {
    const log = buildLogSink();
    const result = assertCarrierCredentialsConfiguredForProduction(
      { NODE_ENV: "staging" },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("allows boot when all three carriers are fully credentialed on a production deploy", () => {
    const log = buildLogSink();
    const result = assertCarrierCredentialsConfiguredForProduction(
      { NODE_ENV: "production", ...ALL_CARRIER_CREDS },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("allows boot on a staging hostname when PRODUCTION_HOSTNAME_PATTERN is configured (no production signal lit)", () => {
    const log = buildLogSink();
    const result = assertCarrierCredentialsConfiguredForProduction(
      {
        HOSTNAME: "api.staging.epplaa.com",
        PRODUCTION_HOSTNAME_PATTERN: "^api\\.epplaa\\.com$",
      },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("allows boot when all carriers are explicitly opted-out on production", () => {
    // The opt-out path lets a brand-new production deploy ship
    // without any carriers wired up while integrations are still in
    // procurement. Ops accepts the trade-off (the carriers' implicit
    // stub paths still serve fake quotes at runtime — this guard
    // only governs whether boot proceeds).
    const log = buildLogSink();
    const result = assertCarrierCredentialsConfiguredForProduction(
      {
        NODE_ENV: "production",
        DISABLE_CARRIER_SHIPBUBBLE: "1",
        DISABLE_CARRIER_GIG: "1",
        DISABLE_CARRIER_OKHI: "1",
      },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("allows boot when GIG is opted-out and the other two are credentialed (the canonical 'GIG not yet contracted' case)", () => {
    const log = buildLogSink();
    const result = assertCarrierCredentialsConfiguredForProduction(
      {
        NODE_ENV: "production",
        SHIPBUBBLE_API_KEY: "shp_xxx",
        OKHI_API_KEY: "ok_test_xxx",
        OKHI_BRANCH_ID: "branch_xxx",
        DISABLE_CARRIER_GIG: "1",
      },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });
});

describe("assertCarrierCredentialsConfiguredForProduction — production-rejected paths", () => {
  it("REJECTS boot when production-shape detected and ALL carrier creds are missing", () => {
    const log = buildLogSink();
    const result = assertCarrierCredentialsConfiguredForProduction(
      { NODE_ENV: "production" },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");

    // The error must enumerate every misconfigured carrier and name
    // every missing env var so the operator can fix them all in one
    // redeploy.
    expect(result.reason).toMatch(/shipbubble/);
    expect(result.reason).toMatch(/SHIPBUBBLE_API_KEY/);
    expect(result.reason).toMatch(/gig/);
    expect(result.reason).toMatch(/GIG_API_KEY/);
    expect(result.reason).toMatch(/GIG_USERNAME/);
    expect(result.reason).toMatch(/okhi/);
    expect(result.reason).toMatch(/OKHI_API_KEY/);
    expect(result.reason).toMatch(/OKHI_BRANCH_ID/);
    expect(result.reason).toMatch(/NODE_ENV=production/);
    expect(result.reason).toMatch(/staging-only-endpoints/i);
    // Mention the opt-out env vars so the runbook isn't the only
    // place the operator can find them.
    expect(result.reason).toMatch(/DISABLE_CARRIER_/);

    expect(log.calls).toHaveLength(1);
    const [obj, msg] = log.calls[0]!;
    expect(msg).toMatch(/carrier_credentials_missing_for_production/);
    expect(obj).toMatchObject({
      node_env: "production",
      production_signals: ["node_env"],
      carriers_misconfigured: [
        {
          carrier: "shipbubble",
          missing: ["SHIPBUBBLE_API_KEY"],
          opt_out_env_var: "DISABLE_CARRIER_SHIPBUBBLE",
        },
        {
          carrier: "gig",
          missing: ["GIG_API_KEY", "GIG_USERNAME"],
          opt_out_env_var: "DISABLE_CARRIER_GIG",
        },
        {
          carrier: "okhi",
          missing: ["OKHI_API_KEY", "OKHI_BRANCH_ID"],
          opt_out_env_var: "DISABLE_CARRIER_OKHI",
        },
      ],
    });
  });

  it("REJECTS boot when only GIG_USERNAME is missing (partial-cred misconfig — isConfigured() still returns false)", () => {
    // GIG's isConfigured() requires BOTH GIG_API_KEY AND GIG_USERNAME.
    // A deploy with only the API key set still short-circuits to the
    // stub path, so the guard must fire even on a partial cred set.
    const log = buildLogSink();
    const result = assertCarrierCredentialsConfiguredForProduction(
      {
        NODE_ENV: "production",
        SHIPBUBBLE_API_KEY: "shp_xxx",
        GIG_API_KEY: "gig_xxx",
        // GIG_USERNAME deliberately missing
        OKHI_API_KEY: "ok_test_xxx",
        OKHI_BRANCH_ID: "branch_xxx",
      },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/gig/);
    expect(result.reason).toMatch(/GIG_USERNAME/);
    // The other two carriers must NOT appear in the reason — they're
    // fully configured.
    expect(result.reason).not.toMatch(/SHIPBUBBLE_API_KEY/);
    expect(result.reason).not.toMatch(/OKHI_API_KEY/);

    const [obj] = log.calls[0]!;
    expect(obj).toMatchObject({
      carriers_misconfigured: [
        {
          carrier: "gig",
          missing: ["GIG_USERNAME"],
        },
      ],
    });
  });

  it("REJECTS boot when REPLIT_DEPLOYMENT=1 alone trips the production-signal helper", () => {
    // Replit production deploys set REPLIT_DEPLOYMENT=1 independently
    // of NODE_ENV. The guard must fire on that signal alone.
    const log = buildLogSink();
    const result = assertCarrierCredentialsConfiguredForProduction(
      { REPLIT_DEPLOYMENT: "1" },
      log,
    );
    expect(result.ok).toBe(false);
    expect(log.calls).toHaveLength(1);
    const [obj] = log.calls[0]!;
    expect(obj).toMatchObject({
      replit_deployment: "1",
      production_signals: ["replit_deployment"],
    });
  });

  it("REJECTS boot when DEPLOYMENT_ENVIRONMENT=production alone trips the helper", () => {
    const log = buildLogSink();
    const result = assertCarrierCredentialsConfiguredForProduction(
      { DEPLOYMENT_ENVIRONMENT: "production" },
      log,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/DEPLOYMENT_ENVIRONMENT=production/);
  });

  it("REJECTS boot when HOSTNAME matches PRODUCTION_HOSTNAME_PATTERN even with NODE_ENV unset", () => {
    // The hostname backstop is the strongest signal against a
    // copy-pasted staging env that left NODE_ENV unset on a host
    // serving the production URL.
    const log = buildLogSink();
    const result = assertCarrierCredentialsConfiguredForProduction(
      {
        HOSTNAME: "api.epplaa.com",
        PRODUCTION_HOSTNAME_PATTERN: "^api\\.epplaa\\.com$",
      },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/HOSTNAME=api\.epplaa\.com/);
    const [obj] = log.calls[0]!;
    expect(obj).toMatchObject({
      hostname: "api.epplaa.com",
      production_signals: ["hostname"],
    });
  });

  it("REJECTS when an env var is set to whitespace-only (treated as missing)", () => {
    // A copy-paste that leaves a trailing newline / leading space
    // would otherwise pass a naive `Boolean(env.X)` check while still
    // being unusable as a real credential. Mirror the trim() check
    // that `assertOkHiConfiguredForProduction` already does.
    const log = buildLogSink();
    const result = assertCarrierCredentialsConfiguredForProduction(
      {
        NODE_ENV: "production",
        SHIPBUBBLE_API_KEY: "   ",
        GIG_API_KEY: "gig_xxx",
        GIG_USERNAME: "gig_user",
        OKHI_API_KEY: "ok_test_xxx",
        OKHI_BRANCH_ID: "ok_branch",
      },
      log,
    );
    expect(result.ok).toBe(false);
    const [obj] = log.calls[0]!;
    expect(obj).toMatchObject({
      carriers_misconfigured: [
        { carrier: "shipbubble", missing: ["SHIPBUBBLE_API_KEY"] },
      ],
    });
  });

  it("treats DISABLE_CARRIER_X values other than the literal '1' as NOT opted out (typo defence)", () => {
    // Mirrors the strictness of REPLIT_DEPLOYMENT / STUB_FULFILLMENT
    // gating: anything other than "1" must not silently bypass the
    // boot failure. A copy-paste that wrote `=true` / `=yes` is
    // still a misconfiguration.
    const log = buildLogSink();
    for (const bogus of ["0", "true", "yes", "on", " 1 ", ""]) {
      log.calls.length = 0;
      const result = assertCarrierCredentialsConfiguredForProduction(
        {
          NODE_ENV: "production",
          GIG_API_KEY: "gig_xxx",
          GIG_USERNAME: "gig_user",
          OKHI_API_KEY: "ok_test_xxx",
          OKHI_BRANCH_ID: "ok_branch",
          // Shipbubble missing AND opt-out-typo'd → must still fail.
          DISABLE_CARRIER_SHIPBUBBLE: bogus,
        },
        log,
      );
      expect(result.ok, `bogus=${JSON.stringify(bogus)}`).toBe(false);
    }
  });

  it("does NOT echo secret values into the structured log payload", () => {
    // Even on the partial-misconfig path where some creds ARE set,
    // the log must never carry the secret material — that's the
    // discipline every other assertXxx helper holds to.
    const log = buildLogSink();
    const sentinel = "shp_SECRETxxxxxxxxxxxxxxxxxxxxxx";
    const result = assertCarrierCredentialsConfiguredForProduction(
      {
        NODE_ENV: "production",
        SHIPBUBBLE_API_KEY: sentinel,
        // GIG + OkHi missing → guard fires, log payload is built
      },
      log,
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(log.calls)).not.toContain(sentinel);
  });
});
