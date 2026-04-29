import { describe, it, expect, beforeEach } from "vitest";
import {
  detectProductionSignals,
  isProductionEnvironment,
  __resetProductionEnvCacheForTests,
  type ProductionSignalLogSink,
} from "./productionSignals";

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
  // The hostname-pattern compile result is cached at module level so a
  // bad pattern only logs once per unique value across the lifetime of
  // the process. Reset between tests so each test sees a fresh cache
  // and "did this call log?" assertions are deterministic.
  __resetProductionEnvCacheForTests();
});

describe("detectProductionSignals — empty cases", () => {
  it("returns no signals on a development env (NODE_ENV unset)", () => {
    const log = buildLogSink();
    expect(detectProductionSignals({}, log)).toEqual([]);
    expect(log.calls).toEqual([]);
  });

  it("returns no signals on staging / preview / qa envs", () => {
    const log = buildLogSink();
    for (const env of ["staging", "preview", "qa", "development", ""]) {
      expect(
        detectProductionSignals({ NODE_ENV: env }, log),
        `env=${env}`,
      ).toEqual([]);
    }
    expect(log.calls).toEqual([]);
  });
});

describe("detectProductionSignals — NODE_ENV signal", () => {
  it("flags NODE_ENV=production", () => {
    const log = buildLogSink();
    const signals = detectProductionSignals({ NODE_ENV: "production" }, log);
    expect(signals).toEqual([
      { signal: "node_env", detail: "NODE_ENV=production" },
    ]);
  });

  it("does NOT flag bogus NODE_ENV values that aren't literal 'production'", () => {
    // Strict literal match: a typo ("Production", "PROD") must not
    // trip the signal because the rest of the system also gates on
    // NODE_ENV === "production" exactly. Soft-matching here would
    // diverge from the real production identity and create false
    // positives in dev.
    const log = buildLogSink();
    for (const v of ["Production", "PROD", "prod", "prd", "prodution"]) {
      expect(
        detectProductionSignals({ NODE_ENV: v }, log),
        `value=${v}`,
      ).toEqual([]);
    }
  });
});

describe("detectProductionSignals — REPLIT_DEPLOYMENT signal", () => {
  it("flags REPLIT_DEPLOYMENT=1 even with NODE_ENV unset", () => {
    const log = buildLogSink();
    const signals = detectProductionSignals({ REPLIT_DEPLOYMENT: "1" }, log);
    expect(signals).toEqual([
      {
        signal: "replit_deployment",
        detail: "REPLIT_DEPLOYMENT=1 (Replit production deployment)",
      },
    ]);
  });

  it("does NOT flag REPLIT_DEPLOYMENT values other than '1' (dev workspace)", () => {
    const log = buildLogSink();
    for (const v of [undefined, "", "0", "true", "false", "yes"]) {
      const env: NodeJS.ProcessEnv = {};
      if (v !== undefined) env.REPLIT_DEPLOYMENT = v;
      expect(detectProductionSignals(env, log), `value=${String(v)}`).toEqual(
        [],
      );
    }
  });
});

describe("detectProductionSignals — DEPLOYMENT_ENVIRONMENT signal", () => {
  it("flags DEPLOYMENT_ENVIRONMENT=production", () => {
    const log = buildLogSink();
    const signals = detectProductionSignals(
      { DEPLOYMENT_ENVIRONMENT: "production" },
      log,
    );
    expect(signals).toEqual([
      {
        signal: "deployment_environment",
        detail: "DEPLOYMENT_ENVIRONMENT=production",
      },
    ]);
  });

  it("does NOT flag staging / preview / qa values", () => {
    const log = buildLogSink();
    for (const v of ["staging", "preview", "qa", "development", ""]) {
      expect(
        detectProductionSignals({ DEPLOYMENT_ENVIRONMENT: v }, log),
        `value=${v}`,
      ).toEqual([]);
    }
  });
});

describe("detectProductionSignals — hostname signal", () => {
  it("flags HOSTNAME matching PRODUCTION_HOSTNAME_PATTERN", () => {
    const log = buildLogSink();
    const signals = detectProductionSignals(
      {
        HOSTNAME: "api.epplaa.com",
        PRODUCTION_HOSTNAME_PATTERN: "^api\\.epplaa\\.com$",
      },
      log,
    );
    expect(signals).toEqual([
      {
        signal: "hostname",
        detail:
          "HOSTNAME=api.epplaa.com matches PRODUCTION_HOSTNAME_PATTERN=^api\\.epplaa\\.com$",
      },
    ]);
  });

  it("does not flag staging hostnames against a production-only pattern", () => {
    const log = buildLogSink();
    const signals = detectProductionSignals(
      {
        HOSTNAME: "api.staging.epplaa.com",
        PRODUCTION_HOSTNAME_PATTERN: "^api\\.epplaa\\.com$",
      },
      log,
    );
    expect(signals).toEqual([]);
  });

  it("hostname check is a no-op when PRODUCTION_HOSTNAME_PATTERN is unset", () => {
    // Backwards-compat: a deploy that hasn't (yet) configured the
    // pattern must keep working; the hostname signal only opts in
    // by setting the env var.
    const log = buildLogSink();
    expect(
      detectProductionSignals({ HOSTNAME: "api.epplaa.com" }, log),
    ).toEqual([]);
    expect(log.calls).toEqual([]);
  });

  it("hostname check tolerates a missing HOSTNAME env var", () => {
    const log = buildLogSink();
    expect(
      detectProductionSignals(
        { PRODUCTION_HOSTNAME_PATTERN: "^api\\.epplaa\\.com$" },
        log,
      ),
    ).toEqual([]);
  });

  it("hostname check tolerates an empty PRODUCTION_HOSTNAME_PATTERN (treated as unset)", () => {
    const log = buildLogSink();
    expect(
      detectProductionSignals(
        {
          HOSTNAME: "api.epplaa.com",
          PRODUCTION_HOSTNAME_PATTERN: "   ",
        },
        log,
      ),
    ).toEqual([]);
    expect(log.calls).toEqual([]);
  });

  it("logs an error and disables the hostname check when PRODUCTION_HOSTNAME_PATTERN is invalid regex", () => {
    // A typo (unbalanced bracket) shouldn't crash an otherwise-correct
    // boot — but we MUST surface the misconfiguration because it
    // silently disables a defense-in-depth layer the operator thought
    // they had configured.
    const log = buildLogSink();
    const signals = detectProductionSignals(
      {
        NODE_ENV: "staging",
        HOSTNAME: "api.epplaa.com",
        PRODUCTION_HOSTNAME_PATTERN: "[invalid(regex",
      },
      log,
    );
    expect(signals).toEqual([]);
    expect(log.calls).toHaveLength(1);
    const [obj, msg] = log.calls[0]!;
    expect(msg).toMatch(/production_hostname_pattern_invalid/);
    expect(obj).toMatchObject({ production_hostname_pattern: "[invalid(regex" });
  });
});

describe("detectProductionSignals — multiple signals", () => {
  it("aggregates every triggered signal in one call", () => {
    // If more than one signal is true, every one of them is returned
    // so callers (boot guards, audit logs) can name every offender
    // in a single error and avoid a re-deploy-and-re-fail loop.
    const log = buildLogSink();
    const signals = detectProductionSignals(
      {
        NODE_ENV: "production",
        REPLIT_DEPLOYMENT: "1",
        DEPLOYMENT_ENVIRONMENT: "production",
        HOSTNAME: "api.epplaa.com",
        PRODUCTION_HOSTNAME_PATTERN: "^api\\.epplaa\\.com$",
      },
      log,
    );
    expect(signals.map((s) => s.signal)).toEqual([
      "node_env",
      "replit_deployment",
      "deployment_environment",
      "hostname",
    ]);
  });
});

describe("isProductionEnvironment", () => {
  it("returns false on a clean dev env", () => {
    const log = buildLogSink();
    expect(isProductionEnvironment({}, log)).toBe(false);
  });

  it("returns true if any signal fires", () => {
    const log = buildLogSink();
    expect(isProductionEnvironment({ NODE_ENV: "production" }, log)).toBe(true);
    expect(isProductionEnvironment({ REPLIT_DEPLOYMENT: "1" }, log)).toBe(true);
    expect(
      isProductionEnvironment({ DEPLOYMENT_ENVIRONMENT: "production" }, log),
    ).toBe(true);
    expect(
      isProductionEnvironment(
        {
          HOSTNAME: "api.epplaa.com",
          PRODUCTION_HOSTNAME_PATTERN: "^api\\.epplaa\\.com$",
        },
        log,
      ),
    ).toBe(true);
  });

  it("returns false when every flag is in its non-production state", () => {
    const log = buildLogSink();
    expect(
      isProductionEnvironment(
        {
          NODE_ENV: "staging",
          REPLIT_DEPLOYMENT: "0",
          DEPLOYMENT_ENVIRONMENT: "staging",
          HOSTNAME: "api.staging.epplaa.com",
          PRODUCTION_HOSTNAME_PATTERN: "^api\\.epplaa\\.com$",
        },
        log,
      ),
    ).toBe(false);
  });
});

describe("hostname-pattern compile cache (perf + log noise)", () => {
  it("does not re-log the same invalid pattern across repeated calls (hot-path safety)", () => {
    // The fulfillment carriers call isProductionEnvironment on every
    // dispatch failure. If a bad PRODUCTION_HOSTNAME_PATTERN logged
    // once per request the operator's logs would be flooded. The
    // cache must collapse repeat invalid-value calls to a single log.
    const log = buildLogSink();
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "staging",
      HOSTNAME: "api.epplaa.com",
      PRODUCTION_HOSTNAME_PATTERN: "[invalid(regex",
    };
    for (let i = 0; i < 50; i++) {
      detectProductionSignals(env, log);
    }
    expect(log.calls).toHaveLength(1);
  });

  it("recompiles when PRODUCTION_HOSTNAME_PATTERN value changes (operator fix is picked up live)", () => {
    // If an operator notices the bad-pattern error and rotates the
    // env var to a valid value (or vice versa), the next call must
    // see the new value rather than the cached compile result.
    const log: ProductionSignalLogSink = { error: () => {} };
    const before = detectProductionSignals(
      {
        HOSTNAME: "api.epplaa.com",
        PRODUCTION_HOSTNAME_PATTERN: "^something-else$",
      },
      log,
    );
    expect(before).toEqual([]);
    const after = detectProductionSignals(
      {
        HOSTNAME: "api.epplaa.com",
        PRODUCTION_HOSTNAME_PATTERN: "^api\\.epplaa\\.com$",
      },
      log,
    );
    expect(after.map((s) => s.signal)).toEqual(["hostname"]);
  });
});
