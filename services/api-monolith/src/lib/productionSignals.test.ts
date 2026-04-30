import { describe, it, expect, beforeEach } from "vitest";
import {
  detectProductionSignals,
  isProductionEnvironment,
  __resetProductionEnvCacheForTests,
  getRehearsalInjectorEnabledStatus,
  getStubFulfillmentEnabledStatus,
  getSentryDsnStatus,
  getMfaEncryptionKeyStatus,
  getClerkSecretKeyStatus,
  getTermiiApiKeyStatus,
  getModerationProviderStatus,
  getSanctionsProviderStatus,
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

// =====================================================================
// Tri-state status helpers (task #101).
//
// Each helper is a pure function over the env, returning a closed
// union the /readyz config block surfaces verbatim. The route-level
// composition is tested in `routes/health.test.ts`; these tests pin
// down the per-helper branch matrix so a future regression in the
// non-hostname production-signal detection (e.g. adding a new signal
// or relaxing one) is caught at the unit boundary.
//
// Critically, all three helpers MUST ignore the hostname-pattern
// signal (they call `detectNonHostnameProductionSignals`) — the
// hostname signal exists specifically to harden the rehearsal-
// injector hostname backstop and is intentionally excluded from
// these checks to avoid double-pinging when the operator forgot to
// set BOTH the hostname pattern and unset the staging-only flag.
// =====================================================================

describe("getRehearsalInjectorEnabledStatus — tri-state /readyz status", () => {
  it("returns 'disabled' when HEALTHZ_REHEARSAL_ENABLED is unset, regardless of deploy shape", () => {
    expect(getRehearsalInjectorEnabledStatus({})).toBe("disabled");
    expect(
      getRehearsalInjectorEnabledStatus({ NODE_ENV: "production" }),
    ).toBe("disabled");
  });

  it("returns 'disabled' when HEALTHZ_REHEARSAL_ENABLED is any value other than literal '1'", () => {
    // Match the boot-time predicate: "true", "yes", "on", "1 " all
    // mean *not* enabled. A typo'd flag should not arm the injector.
    for (const v of ["", "0", "true", "yes", "on", " 1", "1\n"]) {
      expect(
        getRehearsalInjectorEnabledStatus({
          HEALTHZ_REHEARSAL_ENABLED: v,
        }),
        `value=${JSON.stringify(v)}`,
      ).toBe("disabled");
    }
  });

  it("returns 'enabled_non_production' when the flag is set on a non-prod deploy (intended for staging rehearsals)", () => {
    expect(
      getRehearsalInjectorEnabledStatus({
        HEALTHZ_REHEARSAL_ENABLED: "1",
      }),
    ).toBe("enabled_non_production");
    expect(
      getRehearsalInjectorEnabledStatus({
        HEALTHZ_REHEARSAL_ENABLED: "1",
        NODE_ENV: "staging",
      }),
    ).toBe("enabled_non_production");
  });

  it("returns 'enabled_in_production' for every non-hostname production signal", () => {
    // Each non-hostname signal is independently sufficient — a probe
    // that only checked NODE_ENV would silently exempt a Replit-
    // platform-marked production deploy whose NODE_ENV is unset.
    for (const env of [
      { NODE_ENV: "production" },
      { REPLIT_DEPLOYMENT: "1" },
      { DEPLOYMENT_ENVIRONMENT: "production" },
    ]) {
      expect(
        getRehearsalInjectorEnabledStatus({
          HEALTHZ_REHEARSAL_ENABLED: "1",
          ...env,
        }),
        `env=${JSON.stringify(env)}`,
      ).toBe("enabled_in_production");
    }
  });

  it("ignores the hostname production signal — that signal exists for the hostname backstop, not for arming the injector page", () => {
    // A staging deploy whose HOSTNAME happens to match the
    // PRODUCTION_HOSTNAME_PATTERN is the case the hostname-signal
    // backstop guards (assertRehearsalKillSwitchSafe crash-loops on
    // boot). We deliberately do not double-page from the readyz
    // probe on the same case, so the helper should report
    // 'enabled_non_production'.
    expect(
      getRehearsalInjectorEnabledStatus({
        HEALTHZ_REHEARSAL_ENABLED: "1",
        HOSTNAME: "api.epplaa.com",
        PRODUCTION_HOSTNAME_PATTERN: "^api\\.epplaa\\.com$",
      }),
    ).toBe("enabled_non_production");
  });
});

describe("getStubFulfillmentEnabledStatus — tri-state /readyz status", () => {
  it("returns 'disabled' when STUB_FULFILLMENT is unset", () => {
    expect(getStubFulfillmentEnabledStatus({})).toBe("disabled");
    expect(
      getStubFulfillmentEnabledStatus({ NODE_ENV: "production" }),
    ).toBe("disabled");
  });

  it("returns 'disabled' when STUB_FULFILLMENT is any non-'1' value", () => {
    for (const v of ["", "0", "true", "false", "yes"]) {
      expect(
        getStubFulfillmentEnabledStatus({ STUB_FULFILLMENT: v }),
      ).toBe("disabled");
    }
  });

  it("returns 'enabled_non_production' on a dev/CI env (the intended state — keeps tests offline)", () => {
    expect(
      getStubFulfillmentEnabledStatus({ STUB_FULFILLMENT: "1" }),
    ).toBe("enabled_non_production");
  });

  it("returns 'enabled_in_production' for every non-hostname production signal — the carrier guard already blocks the fallback at runtime, but the env var itself is wrong (task #83)", () => {
    for (const env of [
      { NODE_ENV: "production" },
      { REPLIT_DEPLOYMENT: "1" },
      { DEPLOYMENT_ENVIRONMENT: "production" },
    ]) {
      expect(
        getStubFulfillmentEnabledStatus({ STUB_FULFILLMENT: "1", ...env }),
        `env=${JSON.stringify(env)}`,
      ).toBe("enabled_in_production");
    }
  });
});

describe("getSentryDsnStatus — tri-state /readyz status", () => {
  it("returns 'configured' whenever SENTRY_DSN is non-empty, regardless of deploy shape (dev observability is welcome)", () => {
    expect(
      getSentryDsnStatus({
        SENTRY_DSN: "https://abc@o123.ingest.sentry.io/456",
      }),
    ).toBe("configured");
    expect(
      getSentryDsnStatus({
        NODE_ENV: "production",
        SENTRY_DSN: "https://abc@o123.ingest.sentry.io/456",
      }),
    ).toBe("configured");
    expect(
      getSentryDsnStatus({
        NODE_ENV: "development",
        SENTRY_DSN: "https://abc@o123.ingest.sentry.io/456",
      }),
    ).toBe("configured");
  });

  it("treats whitespace-only SENTRY_DSN as unset — initSentryServer's no-op shim activates on falsy too", () => {
    // `lib/sentry.ts` checks for a truthy DSN; "   " would install the
    // no-op shim and silently swallow alerts. The probe must surface
    // that the same way as a missing var.
    expect(
      getSentryDsnStatus({
        NODE_ENV: "production",
        SENTRY_DSN: "   ",
      }),
    ).toBe("missing");
  });

  it("returns 'not_required' when DSN is unset on a non-production deploy (dev/CI/preview)", () => {
    expect(getSentryDsnStatus({})).toBe("not_required");
    expect(getSentryDsnStatus({ NODE_ENV: "staging" })).toBe(
      "not_required",
    );
  });

  it("returns 'missing' for every non-hostname production signal — the no-op Sentry shim silently drops every captureException", () => {
    for (const env of [
      { NODE_ENV: "production" },
      { REPLIT_DEPLOYMENT: "1" },
      { DEPLOYMENT_ENVIRONMENT: "production" },
    ]) {
      expect(getSentryDsnStatus(env), `env=${JSON.stringify(env)}`).toBe(
        "missing",
      );
    }
  });
});

// =====================================================================
// Task #103 — five additional tri-state status helpers covering the
// secrets and providers /readyz already inspects via the same
// non-hostname production-signal predicate. Each helper's branch
// matrix is pinned here so a future tweak to the boot-time guards
// can be cross-checked against the operator-facing readyz contract.
// =====================================================================

describe("getMfaEncryptionKeyStatus — tri-state /readyz status", () => {
  it("returns 'configured' whenever MFA_ENCRYPTION_KEY is non-empty, regardless of deploy shape", () => {
    expect(
      getMfaEncryptionKeyStatus({ MFA_ENCRYPTION_KEY: "0".repeat(64) }),
    ).toBe("configured");
    expect(
      getMfaEncryptionKeyStatus({
        NODE_ENV: "production",
        MFA_ENCRYPTION_KEY: "0".repeat(64),
      }),
    ).toBe("configured");
  });

  it("treats whitespace-only MFA_ENCRYPTION_KEY as unset — the boot helper falls back to a no-op cipher on falsy too", () => {
    expect(
      getMfaEncryptionKeyStatus({
        NODE_ENV: "production",
        MFA_ENCRYPTION_KEY: "   ",
      }),
    ).toBe("missing");
  });

  it("returns 'not_required' on a clean dev/staging env", () => {
    expect(getMfaEncryptionKeyStatus({})).toBe("not_required");
    expect(getMfaEncryptionKeyStatus({ NODE_ENV: "staging" })).toBe(
      "not_required",
    );
  });

  it("returns 'missing' for every non-hostname production signal — every TOTP secret would otherwise persist as plaintext", () => {
    for (const env of [
      { NODE_ENV: "production" },
      { REPLIT_DEPLOYMENT: "1" },
      { DEPLOYMENT_ENVIRONMENT: "production" },
    ]) {
      expect(
        getMfaEncryptionKeyStatus(env),
        `env=${JSON.stringify(env)}`,
      ).toBe("missing");
    }
  });
});

describe("getClerkSecretKeyStatus — tri-state /readyz status", () => {
  it("returns 'configured' whenever CLERK_SECRET_KEY is non-empty, regardless of deploy shape", () => {
    expect(
      getClerkSecretKeyStatus({ CLERK_SECRET_KEY: "sk_live_dummy" }),
    ).toBe("configured");
  });

  it("treats whitespace-only CLERK_SECRET_KEY as unset", () => {
    expect(
      getClerkSecretKeyStatus({
        NODE_ENV: "production",
        CLERK_SECRET_KEY: "   ",
      }),
    ).toBe("missing");
  });

  it("returns 'not_required' on a clean dev/staging env (OTP-only / anonymous-socket fallbacks are legitimate there)", () => {
    expect(getClerkSecretKeyStatus({})).toBe("not_required");
    expect(getClerkSecretKeyStatus({ NODE_ENV: "staging" })).toBe(
      "not_required",
    );
  });

  it("returns 'missing' for every non-hostname production signal", () => {
    for (const env of [
      { NODE_ENV: "production" },
      { REPLIT_DEPLOYMENT: "1" },
      { DEPLOYMENT_ENVIRONMENT: "production" },
    ]) {
      expect(getClerkSecretKeyStatus(env), `env=${JSON.stringify(env)}`).toBe(
        "missing",
      );
    }
  });
});

describe("getTermiiApiKeyStatus — tri-state /readyz status", () => {
  it("returns 'configured' whenever TERMII_API_KEY is non-empty, regardless of deploy shape", () => {
    expect(getTermiiApiKeyStatus({ TERMII_API_KEY: "termii-key" })).toBe(
      "configured",
    );
  });

  it("treats whitespace-only TERMII_API_KEY as unset — devEcho fallback would silently mint OTP codes", () => {
    expect(
      getTermiiApiKeyStatus({
        NODE_ENV: "production",
        TERMII_API_KEY: "   ",
      }),
    ).toBe("missing");
  });

  it("returns 'not_required' on a clean dev/staging env (devEcho is the intended dev workflow)", () => {
    expect(getTermiiApiKeyStatus({})).toBe("not_required");
    expect(getTermiiApiKeyStatus({ NODE_ENV: "staging" })).toBe(
      "not_required",
    );
  });

  it("returns 'missing' for every non-hostname production signal", () => {
    for (const env of [
      { NODE_ENV: "production" },
      { REPLIT_DEPLOYMENT: "1" },
      { DEPLOYMENT_ENVIRONMENT: "production" },
    ]) {
      expect(getTermiiApiKeyStatus(env), `env=${JSON.stringify(env)}`).toBe(
        "missing",
      );
    }
  });
});

describe("getModerationProviderStatus — tri-state /readyz status", () => {
  it("returns 'not_required' on a clean dev/staging env (the substring stub is the intended behaviour)", () => {
    expect(getModerationProviderStatus({})).toBe("not_required");
    expect(getModerationProviderStatus({ NODE_ENV: "staging" })).toBe(
      "not_required",
    );
    // Even an explicitly-stub provider on dev is "not_required" so a
    // local override doesn't fire a probe page operators can't act on.
    expect(
      getModerationProviderStatus({ MODERATION_PROVIDER: "stub" }),
    ).toBe("not_required");
  });

  it("returns 'missing' on a prod-shaped deploy when the provider is unset / 'stub'", () => {
    expect(getModerationProviderStatus({ NODE_ENV: "production" })).toBe(
      "missing",
    );
    expect(
      getModerationProviderStatus({
        NODE_ENV: "production",
        MODERATION_PROVIDER: "stub",
      }),
    ).toBe("missing");
  });

  it("returns 'configured' on a prod-shaped deploy with hive + HIVE_API_KEY", () => {
    expect(
      getModerationProviderStatus({
        NODE_ENV: "production",
        MODERATION_PROVIDER: "hive",
        HIVE_API_KEY: "hive-key",
      }),
    ).toBe("configured");
  });

  it("returns 'missing' on a prod-shaped deploy with hive but HIVE_API_KEY unset", () => {
    expect(
      getModerationProviderStatus({
        NODE_ENV: "production",
        MODERATION_PROVIDER: "hive",
      }),
    ).toBe("missing");
  });

  it("returns 'configured' on a prod-shaped deploy with sightengine + creds + PHOTODNA_API_KEY", () => {
    expect(
      getModerationProviderStatus({
        NODE_ENV: "production",
        MODERATION_PROVIDER: "sightengine",
        SIGHTENGINE_API_USER: "user",
        SIGHTENGINE_API_SECRET: "secret",
        PHOTODNA_API_KEY: "photodna-key",
      }),
    ).toBe("configured");
  });

  it("returns 'missing' on a prod-shaped deploy with sightengine but missing creds", () => {
    expect(
      getModerationProviderStatus({
        NODE_ENV: "production",
        MODERATION_PROVIDER: "sightengine",
        SIGHTENGINE_API_SECRET: "secret",
      }),
    ).toBe("missing");
  });

  it("returns 'missing' on a prod-shaped deploy with sightengine + creds but PHOTODNA_API_KEY unset — the CSAM regulatory gate", () => {
    // Sightengine carries general moderation but has no NCMEC hash
    // list. PhotoDNA is the ONLY CSAM-grade signal in this combo and
    // the boot guard's matching `assert` helper is the one that
    // crash-loops on the same case. The probe folds it into "missing"
    // so the page body names the gap.
    expect(
      getModerationProviderStatus({
        NODE_ENV: "production",
        MODERATION_PROVIDER: "sightengine",
        SIGHTENGINE_API_USER: "user",
        SIGHTENGINE_API_SECRET: "secret",
      }),
    ).toBe("missing");
  });

  it("returns 'missing' on a prod-shaped deploy with an unknown provider value (typo / future provider not yet wired)", () => {
    expect(
      getModerationProviderStatus({
        NODE_ENV: "production",
        MODERATION_PROVIDER: "complyadvantage",
      }),
    ).toBe("missing");
  });

  it("ignores the hostname production signal — same exclusion as the other helpers (no double-page with the hostname backstop)", () => {
    expect(
      getModerationProviderStatus({
        HOSTNAME: "api.epplaa.com",
        PRODUCTION_HOSTNAME_PATTERN: "^api\\.epplaa\\.com$",
      }),
    ).toBe("not_required");
  });
});

describe("getSanctionsProviderStatus — tri-state /readyz status", () => {
  it("returns 'not_required' on a clean dev/staging env (synthetic stub hits are the intended dev/CI workflow)", () => {
    expect(getSanctionsProviderStatus({})).toBe("not_required");
    expect(getSanctionsProviderStatus({ NODE_ENV: "staging" })).toBe(
      "not_required",
    );
    // Even an explicit stub on dev is "not_required" — the same
    // shape as the moderation helper above.
    expect(
      getSanctionsProviderStatus({ SANCTIONS_PROVIDER: "stub" }),
    ).toBe("not_required");
  });

  it("returns 'missing' on a prod-shaped deploy when the provider is unset — every payout fail-closes", () => {
    expect(getSanctionsProviderStatus({ NODE_ENV: "production" })).toBe(
      "missing",
    );
  });

  it("returns 'missing' on a prod-shaped deploy when the provider is explicitly 'stub' (case-insensitive)", () => {
    for (const v of ["stub", "STUB", "Stub", " stub "]) {
      expect(
        getSanctionsProviderStatus({
          NODE_ENV: "production",
          SANCTIONS_PROVIDER: v,
        }),
        `value=${JSON.stringify(v)}`,
      ).toBe("missing");
    }
  });

  it("returns 'configured' on a prod-shaped deploy when the env var names a real provider", () => {
    // The helper does NOT validate that the integration actually
    // exists — that lives in the integration task. A non-stub value
    // being set is necessary even if not yet sufficient.
    expect(
      getSanctionsProviderStatus({
        NODE_ENV: "production",
        SANCTIONS_PROVIDER: "complyadvantage",
      }),
    ).toBe("configured");
  });

  it("returns 'missing' for every non-hostname production signal (mirrors the rest of the helper family)", () => {
    for (const env of [
      { NODE_ENV: "production" },
      { REPLIT_DEPLOYMENT: "1" },
      { DEPLOYMENT_ENVIRONMENT: "production" },
    ]) {
      expect(
        getSanctionsProviderStatus(env),
        `env=${JSON.stringify(env)}`,
      ).toBe("missing");
    }
  });
});
