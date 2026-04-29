import { describe, it, expect, beforeEach } from "vitest";
import {
  assertModerationProviderConfiguredForProduction,
  classifyPhotoDnaHealthError,
  getModerationProviderInfo,
  __resetModerationProviderForTests,
  runModerationProviderHealthCheck,
} from "./moderation";

/**
 * Boot-time sanity checks for the moderation provider, mirroring the
 * `assertSentryDsnConfiguredForProduction` test layout.
 *
 * The check is a WARNING (not a hard failure) because (a) every real
 * provider has a per-call fail-closed/-open at the consumer site,
 * (b) crash-looping every existing deploy that hasn't yet wired a
 * provider would be more disruptive than the marginal observability
 * gain, and (c) the operator-facing controls (dashboard banner,
 * audit-log row, warn-tag log filter) are designed to surface the
 * misconfiguration within minutes of the next deploy.
 *
 * These tests deliberately exercise the pure-function variant so we
 * don't have to poison `process.env` or spin up the real fetch path.
 */
describe("assertModerationProviderConfiguredForProduction — production MODERATION_PROVIDER presence check", () => {
  type WarnCall = [obj: unknown, msg: string];
  function buildWarnSink(): {
    warn: (obj: unknown, msg: string) => void;
    calls: WarnCall[];
  } {
    const calls: WarnCall[] = [];
    return {
      warn: (obj, msg) => {
        calls.push([obj, msg]);
      },
      calls,
    };
  }

  it("does nothing on a non-production deploy (staging) with no provider set", () => {
    // The substring stub is the intended behaviour on staging / dev /
    // preview — the check must be silent there or every non-production
    // boot would emit a misleading "moderation off in production" alert.
    const log = buildWarnSink();
    const result = assertModerationProviderConfiguredForProduction(
      { NODE_ENV: "staging" },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("WARNS when MODERATION_PROVIDER is unset on a production deploy", () => {
    const log = buildWarnSink();
    const result = assertModerationProviderConfiguredForProduction(
      { NODE_ENV: "production" },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/MODERATION_PROVIDER is not set/);
    expect(result.reason).toMatch(/NODE_ENV=production/);
    expect(log.calls).toHaveLength(1);
    const [obj, msg] = log.calls[0]!;
    expect(msg).toMatch(/moderation_provider_missing_for_production/);
    expect(obj).toMatchObject({
      node_env: "production",
      moderation_provider: null,
      hive_api_key_set: false,
      sightengine_api_user_set: false,
      sightengine_api_secret_set: false,
      photodna_api_key_set: false,
      production_signals: ["node_env"],
    });
  });

  it("WARNS when MODERATION_PROVIDER is the literal 'stub' on a production deploy", () => {
    // `stub` is treated identically to "unset" — operators may set it
    // explicitly while wiring the real provider; the warn ensures that
    // explicit choice is still surfaced as misconfigured for production.
    const log = buildWarnSink();
    const result = assertModerationProviderConfiguredForProduction(
      { NODE_ENV: "production", MODERATION_PROVIDER: "stub" },
      log,
    );
    expect(result.ok).toBe(false);
    expect(log.calls).toHaveLength(1);
  });

  it("WARNS when MODERATION_PROVIDER=hive but HIVE_API_KEY is unset", () => {
    // Without HIVE_API_KEY the selector falls back to the stub —
    // exact same blast radius as `MODERATION_PROVIDER=stub`.
    const log = buildWarnSink();
    const result = assertModerationProviderConfiguredForProduction(
      { NODE_ENV: "production", MODERATION_PROVIDER: "hive" },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/MODERATION_PROVIDER=hive but HIVE_API_KEY is unset/);
    expect(log.calls).toHaveLength(1);
    const [obj] = log.calls[0]!;
    expect(obj).toMatchObject({
      moderation_provider: "hive",
      hive_api_key_set: false,
    });
  });

  it("WARNS when MODERATION_PROVIDER=sightengine but the credential pair is missing", () => {
    // Sightengine requires BOTH api_user and api_secret. Missing either
    // half means the check.json call would 401 — same fall-through
    // to stub as the unset case.
    const log = buildWarnSink();
    const result = assertModerationProviderConfiguredForProduction(
      {
        NODE_ENV: "production",
        MODERATION_PROVIDER: "sightengine",
        SIGHTENGINE_API_USER: "u",
        // PHOTODNA_API_KEY set so the missing-PhotoDNA branch doesn't
        // shadow the missing-credentials branch we're exercising here.
        PHOTODNA_API_KEY: "p",
      },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/SIGHTENGINE_API_USER and\/or SIGHTENGINE_API_SECRET is unset/);
    expect(log.calls).toHaveLength(1);
    const [obj] = log.calls[0]!;
    expect(obj).toMatchObject({
      moderation_provider: "sightengine",
      sightengine_api_user_set: true,
      sightengine_api_secret_set: false,
    });
  });

  it("WARNS when MODERATION_PROVIDER=sightengine + creds OK but PHOTODNA_API_KEY is unset", () => {
    // Sightengine has no NCMEC hash list — so a Sightengine-only
    // production deploy has zero CSAM coverage even though general
    // moderation looks healthy. The boot guard surfaces the gap
    // distinctly so on-call sees it before the next CSAM upload.
    const log = buildWarnSink();
    const result = assertModerationProviderConfiguredForProduction(
      {
        NODE_ENV: "production",
        MODERATION_PROVIDER: "sightengine",
        SIGHTENGINE_API_USER: "user_xyz",
        SIGHTENGINE_API_SECRET: "secret_xyz",
      },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/PHOTODNA_API_KEY is unset/);
    expect(result.reason).toMatch(/Sightengine does not expose the NCMEC hash list/);
    expect(log.calls).toHaveLength(1);
    const [obj] = log.calls[0]!;
    expect(obj).toMatchObject({
      moderation_provider: "sightengine",
      sightengine_api_user_set: true,
      sightengine_api_secret_set: true,
      photodna_api_key_set: false,
    });
  });

  it("WARNS when MODERATION_PROVIDER is a typo / unimplemented value", () => {
    // Selector falls through to the stub and logs `not_implemented`.
    // The boot-time guard mirrors that — operators see the typo
    // before the next CSAM upload silently slips through.
    const log = buildWarnSink();
    const result = assertModerationProviderConfiguredForProduction(
      { NODE_ENV: "production", MODERATION_PROVIDER: "rekognition" },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/rekognition is not implemented/);
    expect(log.calls).toHaveLength(1);
  });

  it("does NOT warn when MODERATION_PROVIDER=hive and HIVE_API_KEY is set (the healthy path)", () => {
    // The check must be silent on a correctly-configured production
    // boot — otherwise log aggregators ignore the warn after the
    // first false positive.
    const log = buildWarnSink();
    const result = assertModerationProviderConfiguredForProduction(
      { NODE_ENV: "production", MODERATION_PROVIDER: "hive", HIVE_API_KEY: "hk_live_xyz" },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("does NOT warn when MODERATION_PROVIDER=sightengine + creds + PHOTODNA_API_KEY are all set", () => {
    // Healthy Sightengine deploy requires all THREE: api user,
    // api secret, AND PhotoDNA. PhotoDNA is the only NCMEC-grade
    // CSAM signal when Sightengine is the general provider.
    const log = buildWarnSink();
    const result = assertModerationProviderConfiguredForProduction(
      {
        NODE_ENV: "production",
        MODERATION_PROVIDER: "sightengine",
        SIGHTENGINE_API_USER: "user_xyz",
        SIGHTENGINE_API_SECRET: "secret_xyz",
        PHOTODNA_API_KEY: "photodna_xyz",
      },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("triggers on REPLIT_DEPLOYMENT=1 alone (Replit deploy without NODE_ENV=production)", () => {
    // The non-hostname production-signal helper accepts any of three
    // signals. A Replit Deployment that doesn't set NODE_ENV would
    // otherwise silently dodge the check.
    const log = buildWarnSink();
    const result = assertModerationProviderConfiguredForProduction(
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

  it("triggers on DEPLOYMENT_ENVIRONMENT=production alone (IaC deploys that skip NODE_ENV)", () => {
    const log = buildWarnSink();
    const result = assertModerationProviderConfiguredForProduction(
      { DEPLOYMENT_ENVIRONMENT: "production" },
      log,
    );
    expect(result.ok).toBe(false);
    expect(log.calls).toHaveLength(1);
    const [obj] = log.calls[0]!;
    expect(obj).toMatchObject({
      deployment_environment: "production",
      production_signals: ["deployment_environment"],
    });
  });
});

describe("getModerationProviderInfo — provider selection + degraded reporting", () => {
  beforeEach(() => {
    __resetModerationProviderForTests();
    delete process.env.MODERATION_PROVIDER;
    delete process.env.HIVE_API_KEY;
    delete process.env.SIGHTENGINE_API_USER;
    delete process.env.SIGHTENGINE_API_SECRET;
    delete process.env.PHOTODNA_API_KEY;
  });

  it("returns the stub provider with csamProvider='stub' on a non-production deploy with no env set", () => {
    // The stub's CSAM "match" is just the substring `csam-test` URL
    // marker — useful for tests, NOT a real signal. The dashboard
    // already won't flip degraded for the stub on non-production
    // shapes, so the row stays informational.
    const info = getModerationProviderInfo();
    expect(info.provider).toBe("stub");
    expect(info.degraded).toBe(false);
    expect(info.csamProvider).toBe("stub");
  });

  it("upgrades csamProvider to 'photodna' when PHOTODNA_API_KEY is set, even on the stub provider", () => {
    process.env.PHOTODNA_API_KEY = "abcd";
    __resetModerationProviderForTests();
    const info = getModerationProviderInfo();
    expect(info.csamProvider).toBe("photodna");
  });

  it("reports the hive provider when MODERATION_PROVIDER=hive and HIVE_API_KEY is set", () => {
    // Hive exposes the NCMEC-aligned `csam_hash_match` model natively,
    // so a Hive-only deploy reports `csamProvider: "provider_native"`
    // without requiring PhotoDNA on top.
    process.env.MODERATION_PROVIDER = "hive";
    process.env.HIVE_API_KEY = "hk_live_xyz";
    __resetModerationProviderForTests();
    const info = getModerationProviderInfo();
    expect(info.provider).toBe("hive");
    expect(info.degraded).toBe(false);
    expect(info.csamProvider).toBe("provider_native");
  });

  it("reports csamProvider='none' AND degraded=true when sightengine is configured without PhotoDNA", () => {
    // Sightengine has no NCMEC hash list; without PhotoDNA there's
    // zero CSAM coverage. The dashboard banner reads from `degraded`,
    // so the operator sees the gap even though general moderation
    // looks healthy.
    process.env.MODERATION_PROVIDER = "sightengine";
    process.env.SIGHTENGINE_API_USER = "u";
    process.env.SIGHTENGINE_API_SECRET = "s";
    __resetModerationProviderForTests();
    const info = getModerationProviderInfo();
    expect(info.provider).toBe("sightengine");
    expect(info.csamProvider).toBe("none");
    expect(info.degraded).toBe(true);
    expect(info.degradedReason).toMatch(/photodna_required_for_sightengine/);
  });

  it("reports csamProvider='photodna' AND degraded=false when sightengine is paired with PhotoDNA", () => {
    process.env.MODERATION_PROVIDER = "sightengine";
    process.env.SIGHTENGINE_API_USER = "u";
    process.env.SIGHTENGINE_API_SECRET = "s";
    process.env.PHOTODNA_API_KEY = "p";
    __resetModerationProviderForTests();
    const info = getModerationProviderInfo();
    expect(info.provider).toBe("sightengine");
    expect(info.csamProvider).toBe("photodna");
    expect(info.degraded).toBe(false);
    expect(info.degradedReason).toBeNull();
  });
});

describe("classifyPhotoDnaHealthError — boot probe HTTP status classification", () => {
  // The PhotoDNA health probe POSTs a synthetic example.com URL,
  // which always errors with a non-200. The classifier decides whether
  // the failure is "credentials work, image rejected" (healthy) vs
  // "credentials rejected" (unhealthy) vs "server / network down"
  // (unhealthy). Misclassifying a 401 as healthy would silently mask
  // a bad PHOTODNA_API_KEY — the entire point of this probe.

  it("treats HTTP 400 (bad image content) as ok=true", () => {
    // 400 means the request reached PhotoDNA, the credentials
    // validated, and the image was rejected for content reasons —
    // the network path + key are good.
    const result = classifyPhotoDnaHealthError("photodna_http_400", 42);
    expect(result.ok).toBe(true);
    expect(result.detail).toBe("photodna_http_400");
    expect(result.latencyMs).toBe(42);
  });

  it("treats HTTP 404 / 415 / 422 (other 4xx that aren't auth) as ok=true", () => {
    for (const code of [404, 415, 422]) {
      const result = classifyPhotoDnaHealthError(`photodna_http_${code}`, 10);
      expect(result.ok).toBe(true);
    }
  });

  it("treats HTTP 401 as ok=false (credentials rejected — bad PHOTODNA_API_KEY)", () => {
    // The exact failure mode the boot probe must catch: a deploy
    // shipped with an invalid PHOTODNA_API_KEY but a successful-
    // looking general moderation provider. The probe is the ONLY
    // place this gets surfaced before a real CSAM upload.
    const result = classifyPhotoDnaHealthError("photodna_http_401", 17);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/credentials rejected/);
    expect(result.detail).toMatch(/PHOTODNA_API_KEY/);
  });

  it("treats HTTP 403 as ok=false (subscription suspended / blocked)", () => {
    const result = classifyPhotoDnaHealthError("photodna_http_403", 17);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/credentials rejected/);
  });

  it("treats HTTP 500 / 502 / 503 (PhotoDNA outage) as ok=false", () => {
    for (const code of [500, 502, 503, 504]) {
      const result = classifyPhotoDnaHealthError(`photodna_http_${code}`, 100);
      expect(result.ok).toBe(false);
      // No false credential-rejected message for server-side failures
      // — operators reading the audit log can distinguish "PhotoDNA
      // is down" from "your key is bad".
      expect(result.detail).not.toMatch(/credentials rejected/);
    }
  });

  it("treats network-level errors (no HTTP status) as ok=false", () => {
    // AbortError on timeout, ENETUNREACH on offline, etc.
    const result = classifyPhotoDnaHealthError("AbortError: aborted", 15000);
    expect(result.ok).toBe(false);
    expect(result.detail).toBe("AbortError: aborted");
  });
});

describe("runModerationProviderHealthCheck — boot probe", () => {
  beforeEach(() => {
    __resetModerationProviderForTests();
    delete process.env.MODERATION_PROVIDER;
    delete process.env.HIVE_API_KEY;
    delete process.env.SIGHTENGINE_API_USER;
    delete process.env.SIGHTENGINE_API_SECRET;
    delete process.env.PHOTODNA_API_KEY;
  });

  it("does not throw on the stub-provider happy path (NODE_ENV=test → recordAudit no-op surface)", async () => {
    // The stub provider's getHealth() is synchronous-ish and always
    // returns ok=true. The audit-log write is skipped by recordAudit
    // when DATABASE_URL isn't a real Postgres (test env), and any
    // failure is swallowed via the inner try/catch — so the function
    // must complete without throwing regardless of the surrounding
    // environment.
    await expect(runModerationProviderHealthCheck()).resolves.toBeUndefined();
  });
});
