import { describe, it, expect, vi } from "vitest";
import {
  evaluateField,
  evaluateReadyz,
  exitCodeFor,
  main,
  parseTimeoutMs,
  type ReadyzBody,
} from "./checkReadyzConfig";

// =====================================================================
// `checkReadyzConfig` is the generalised successor to
// `checkProductionHostnamePattern` (task #101). It evaluates EVERY
// high-risk operator-set boot-time setting surfaced by /readyz's
// `config` block and pages on-call when ANY of them is in a
// dangerous state. The tests below mirror the structure of the
// hostname-only probe's tests so an operator reading both files
// sees the same overall shape — easy to compare and to spot the
// new aggregation behaviour.
// =====================================================================

describe("parseTimeoutMs", () => {
  // Same sanitisation contract as the hostname probe — keep both in
  // lockstep so a typo'd env var doesn't silently degrade either.
  it("returns the parsed integer when the env var is a positive number", () => {
    expect(parseTimeoutMs("12345", 999)).toBe(12345);
    expect(parseTimeoutMs("123.9", 999)).toBe(123);
  });

  it("falls back when the env var is missing, NaN, zero, or negative", () => {
    for (const bogus of [undefined, "", "abc", "0", "-1", "-1000"]) {
      expect(parseTimeoutMs(bogus, 5000), `bogus=${String(bogus)}`).toBe(
        5000,
      );
    }
  });
});

describe("exitCodeFor", () => {
  it("maps each aggregate outcome to the documented exit code", () => {
    expect(exitCodeFor("ok")).toBe(0);
    expect(exitCodeFor("page")).toBe(2);
    expect(exitCodeFor("probe_error")).toBe(1);
  });
});

describe("evaluateField — per-field rule matrix", () => {
  // Every rule entry is exercised here so a regression that
  // accidentally drops a status from `okValues` / `pageValues` (or
  // adds a typo'd new value) is caught at the unit boundary.

  describe("productionHostnamePattern", () => {
    it("treats 'configured' and 'not_required' as ok", () => {
      expect(
        evaluateField("productionHostnamePattern", "configured").outcome,
      ).toBe("ok");
      expect(
        evaluateField("productionHostnamePattern", "not_required").outcome,
      ).toBe("ok");
    });

    it("pages on 'missing' and explains which env var to set + where the runbook lives", () => {
      const r = evaluateField("productionHostnamePattern", "missing");
      expect(r.outcome).toBe("page");
      expect(r.reason).toContain("PRODUCTION_HOSTNAME_PATTERN");
      expect(r.reason).toContain("staging-only-endpoints.md");
    });
  });

  describe("rehearsalInjectorEnabled", () => {
    it("treats 'disabled' and 'enabled_non_production' as ok (intended states)", () => {
      expect(
        evaluateField("rehearsalInjectorEnabled", "disabled").outcome,
      ).toBe("ok");
      expect(
        evaluateField("rehearsalInjectorEnabled", "enabled_non_production")
          .outcome,
      ).toBe("ok");
    });

    it("pages on 'enabled_in_production' and names the offending env var", () => {
      const r = evaluateField(
        "rehearsalInjectorEnabled",
        "enabled_in_production",
      );
      expect(r.outcome).toBe("page");
      expect(r.reason).toContain("HEALTHZ_REHEARSAL_ENABLED");
      expect(r.reason).toContain("staging-only-endpoints.md");
    });
  });

  describe("stubFulfillmentEnabled", () => {
    it("treats 'disabled' and 'enabled_non_production' as ok", () => {
      expect(
        evaluateField("stubFulfillmentEnabled", "disabled").outcome,
      ).toBe("ok");
      expect(
        evaluateField("stubFulfillmentEnabled", "enabled_non_production")
          .outcome,
      ).toBe("ok");
    });

    it("pages on 'enabled_in_production' and references the carrier hardening backstop", () => {
      const r = evaluateField(
        "stubFulfillmentEnabled",
        "enabled_in_production",
      );
      expect(r.outcome).toBe("page");
      expect(r.reason).toContain("STUB_FULFILLMENT");
      // Mention the runtime guard (task #83) so the on-call knows
      // this is a deploy-hygiene issue, not an in-flight money loss.
      expect(r.reason).toContain("task #83");
    });
  });

  describe("rateLimitStore", () => {
    it("treats 'redis', 'memory_not_required', and 'memory_opt_out_acknowledged' as ok", () => {
      // The opt-out value is intentionally NOT a page condition —
      // single-replica production canaries explicitly choose memory.
      // Mirrors the boot-time warn-vs-error distinction.
      for (const v of [
        "redis",
        "memory_not_required",
        "memory_opt_out_acknowledged",
      ]) {
        expect(
          evaluateField("rateLimitStore", v).outcome,
          `value=${v}`,
        ).toBe("ok");
      }
    });

    it("pages on 'memory_misconfigured' and offers BOTH remediation paths (set redis OR set the opt-out)", () => {
      const r = evaluateField("rateLimitStore", "memory_misconfigured");
      expect(r.outcome).toBe("page");
      expect(r.reason).toContain("RATE_LIMIT_STORE=redis");
      expect(r.reason).toContain(
        "RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION=1",
      );
    });
  });

  describe("sentryDsn", () => {
    it("treats 'configured' and 'not_required' as ok", () => {
      expect(evaluateField("sentryDsn", "configured").outcome).toBe("ok");
      expect(evaluateField("sentryDsn", "not_required").outcome).toBe("ok");
    });

    it("pages on 'missing' and references the alerting consequences", () => {
      const r = evaluateField("sentryDsn", "missing");
      expect(r.outcome).toBe("page");
      expect(r.reason).toContain("SENTRY_DSN");
      // Mention at least one downstream alert that goes silent so the
      // on-call understands why this is page-worthy and not just a
      // dev-tools convenience.
      expect(r.reason).toContain("captureException");
    });
  });

  // -------------------------------------------------------------------
  // Task #103 — five additional secret/provider rules. Each follows
  // the same shape as `sentryDsn` above (configured/not_required = ok,
  // missing = page) so adding a sixth secret in the future is a
  // mechanical extension, not a contract change.
  // -------------------------------------------------------------------

  describe("mfaEncryptionKey", () => {
    it("treats 'configured' and 'not_required' as ok", () => {
      expect(evaluateField("mfaEncryptionKey", "configured").outcome).toBe(
        "ok",
      );
      expect(evaluateField("mfaEncryptionKey", "not_required").outcome).toBe(
        "ok",
      );
    });

    it("pages on 'missing' and names the env var + runbook", () => {
      const r = evaluateField("mfaEncryptionKey", "missing");
      expect(r.outcome).toBe("page");
      expect(r.reason).toContain("MFA_ENCRYPTION_KEY");
      expect(r.reason).toContain("staging-only-endpoints.md");
    });
  });

  describe("clerkSecretKey", () => {
    it("treats 'configured' and 'not_required' as ok", () => {
      expect(evaluateField("clerkSecretKey", "configured").outcome).toBe("ok");
      expect(evaluateField("clerkSecretKey", "not_required").outcome).toBe(
        "ok",
      );
    });

    it("pages on 'missing' and names the env var + runbook", () => {
      const r = evaluateField("clerkSecretKey", "missing");
      expect(r.outcome).toBe("page");
      expect(r.reason).toContain("CLERK_SECRET_KEY");
      expect(r.reason).toContain("staging-only-endpoints.md");
    });
  });

  describe("termiiApiKey", () => {
    it("treats 'configured' and 'not_required' as ok", () => {
      expect(evaluateField("termiiApiKey", "configured").outcome).toBe("ok");
      expect(evaluateField("termiiApiKey", "not_required").outcome).toBe("ok");
    });

    it("pages on 'missing' and names the env var + runbook", () => {
      const r = evaluateField("termiiApiKey", "missing");
      expect(r.outcome).toBe("page");
      expect(r.reason).toContain("TERMII_API_KEY");
      expect(r.reason).toContain("staging-only-endpoints.md");
    });
  });

  describe("moderationProvider", () => {
    it("treats 'configured' and 'not_required' as ok", () => {
      expect(evaluateField("moderationProvider", "configured").outcome).toBe(
        "ok",
      );
      expect(
        evaluateField("moderationProvider", "not_required").outcome,
      ).toBe("ok");
    });

    it("pages on 'missing' and names the env var + runbook", () => {
      const r = evaluateField("moderationProvider", "missing");
      expect(r.outcome).toBe("page");
      expect(r.reason).toContain("MODERATION_PROVIDER");
      expect(r.reason).toContain("staging-only-endpoints.md");
    });
  });

  describe("sanctionsProvider", () => {
    it("treats 'configured' and 'not_required' as ok", () => {
      expect(evaluateField("sanctionsProvider", "configured").outcome).toBe(
        "ok",
      );
      expect(evaluateField("sanctionsProvider", "not_required").outcome).toBe(
        "ok",
      );
    });

    it("pages on 'missing' and names the env var + runbook", () => {
      const r = evaluateField("sanctionsProvider", "missing");
      expect(r.outcome).toBe("page");
      expect(r.reason).toContain("SANCTIONS_PROVIDER");
      expect(r.reason).toContain("staging-only-endpoints.md");
    });
  });

  it("returns 'probe_error' for a string value the rule doesn't recognise (response-shape regression)", () => {
    // An unrecognised value is more dangerous than a known-bad value:
    // the probe can't decide whether it should page, so escalate.
    const r = evaluateField(
      "productionHostnamePattern",
      "some_new_status_we_have_not_handled",
    );
    expect(r.outcome).toBe("probe_error");
    expect(r.reason).toContain("unrecognised value");
  });

  it("returns 'probe_error' for a non-string value (e.g. boolean / number / null)", () => {
    // A non-string at a status field is a wire-shape regression —
    // every readyz status helper returns a string union.
    for (const v of [true, 0, null, undefined, { x: 1 }, []]) {
      expect(
        evaluateField("rehearsalInjectorEnabled", v).outcome,
        `value=${JSON.stringify(v)}`,
      ).toBe("probe_error");
    }
  });
});

describe("evaluateReadyz — aggregate fold across all fields", () => {
  // The healthy-clean-env baseline matches the route-level test in
  // `routes/health.test.ts` so the probe and the producing route
  // stay in lockstep on what "all green" looks like.
  const HEALTHY_BODY: ReadyzBody = {
    config: {
      productionHostnamePattern: "not_required",
      rehearsalInjectorEnabled: "disabled",
      stubFulfillmentEnabled: "disabled",
      rateLimitStore: "redis",
      sentryDsn: "not_required",
      // Task #103 — five additional secret/provider fields. On a
      // dev/staging deploy each helper returns "not_required".
      mfaEncryptionKey: "not_required",
      clerkSecretKey: "not_required",
      termiiApiKey: "not_required",
      moderationProvider: "not_required",
      sanctionsProvider: "not_required",
    },
  };

  it("returns 'ok' when every field is in a non-paging state", () => {
    const r = evaluateReadyz(HEALTHY_BODY);
    expect(r.worstOutcome).toBe("ok");
    expect(r.fields).toHaveLength(10);
    expect(r.fields.every((f) => f.outcome === "ok")).toBe(true);
  });

  it("pages when ONE field is in a paging state — the rest stay ok in the per-field breakdown", () => {
    const r = evaluateReadyz({
      config: {
        ...(HEALTHY_BODY.config as Record<string, unknown>),
        sentryDsn: "missing",
      },
    });
    expect(r.worstOutcome).toBe("page");
    const sentry = r.fields.find((f) => f.field === "sentryDsn")!;
    expect(sentry.outcome).toBe("page");
    // The other fields must still be reported as ok so the page body
    // can show the whole config snapshot, not just the broken row.
    const otherOutcomes = r.fields
      .filter((f) => f.field !== "sentryDsn")
      .map((f) => f.outcome);
    expect(otherOutcomes).toHaveLength(9);
    expect(otherOutcomes.every((o) => o === "ok")).toBe(true);
  });

  it("pages with EVERY paging reason populated when the deploy is misconfigured across the board", () => {
    // The page body must list every misconfigured field so the
    // on-call can fix them in one redeploy, not one-at-a-time after
    // re-running the probe between each restart.
    const r = evaluateReadyz({
      config: {
        productionHostnamePattern: "missing",
        rehearsalInjectorEnabled: "enabled_in_production",
        stubFulfillmentEnabled: "enabled_in_production",
        rateLimitStore: "memory_misconfigured",
        sentryDsn: "missing",
        mfaEncryptionKey: "missing",
        clerkSecretKey: "missing",
        termiiApiKey: "missing",
        moderationProvider: "missing",
        sanctionsProvider: "missing",
      },
    });
    expect(r.worstOutcome).toBe("page");
    expect(r.fields).toHaveLength(10);
    expect(r.fields.every((f) => f.outcome === "page")).toBe(true);
    // Each reason must name its env var so the on-call doesn't have
    // to cross-reference field names to env-var names.
    const reasons = r.fields.map((f) => f.reason).join("\n");
    expect(reasons).toContain("PRODUCTION_HOSTNAME_PATTERN");
    expect(reasons).toContain("HEALTHZ_REHEARSAL_ENABLED");
    expect(reasons).toContain("STUB_FULFILLMENT");
    expect(reasons).toContain("RATE_LIMIT_STORE");
    expect(reasons).toContain("SENTRY_DSN");
    expect(reasons).toContain("MFA_ENCRYPTION_KEY");
    expect(reasons).toContain("CLERK_SECRET_KEY");
    expect(reasons).toContain("TERMII_API_KEY");
    expect(reasons).toContain("MODERATION_PROVIDER");
    expect(reasons).toContain("SANCTIONS_PROVIDER");
  });

  it("escalates to 'probe_error' when ANY field has an unrecognised value (worst-wins severity)", () => {
    // probe_error is ranked above page intentionally — see the
    // helper's TS doc. An unrecognised value means the probe itself
    // can't make a trustworthy decision; surfacing that distinction
    // in the structured stdout line helps log-triage without
    // changing the cron wrapper's any-non-zero alerting behaviour.
    const r = evaluateReadyz({
      config: {
        ...(HEALTHY_BODY.config as Record<string, unknown>),
        sentryDsn: "missing", // would page on its own
        rateLimitStore: "some_brand_new_status", // unrecognised
      },
    });
    expect(r.worstOutcome).toBe("probe_error");
  });

  it("returns 'probe_error' for every field when the config block is missing entirely", () => {
    const r = evaluateReadyz({});
    expect(r.worstOutcome).toBe("probe_error");
    expect(r.fields).toHaveLength(10);
    expect(r.fields.every((f) => f.outcome === "probe_error")).toBe(true);
    expect(r.fields[0]!.reason).toContain("missing the `config` block");
  });

  it("returns 'probe_error' when config is null / array / non-object (defensive against bad responses)", () => {
    expect(evaluateReadyz({ config: null }).worstOutcome).toBe("probe_error");
    expect(evaluateReadyz({ config: [] as unknown }).worstOutcome).toBe(
      "probe_error",
    );
    expect(evaluateReadyz({ config: "string" as unknown }).worstOutcome).toBe(
      "probe_error",
    );
  });

  it("treats a missing field (e.g. older api-server version) as 'probe_error' for that field — version skew should not silently page or silently pass", () => {
    // A rolling deploy where an older replica doesn't yet emit a new
    // status field would have `undefined` at that field; the probe
    // must escalate rather than pretend the field is "ok". This
    // forces the operator to confirm the deploy actually finished
    // rolling out before trusting subsequent probe runs. We omit one
    // of the new task #103 fields here — the version-skew scenario
    // most likely to bite right after this rollout — to pin down the
    // contract that ALL fields, not just the original 5, escalate.
    const r = evaluateReadyz({
      config: {
        productionHostnamePattern: "not_required",
        rehearsalInjectorEnabled: "disabled",
        stubFulfillmentEnabled: "disabled",
        rateLimitStore: "redis",
        sentryDsn: "not_required",
        mfaEncryptionKey: "not_required",
        clerkSecretKey: "not_required",
        termiiApiKey: "not_required",
        // moderationProvider intentionally omitted (older replica)
        sanctionsProvider: "not_required",
      },
    });
    expect(r.worstOutcome).toBe("probe_error");
    const moderation = r.fields.find(
      (f) => f.field === "moderationProvider",
    )!;
    expect(moderation.outcome).toBe("probe_error");
  });
});

describe("main — CLI wiring (env validation, exit code, structured output)", () => {
  it("returns 1 and writes a stderr message when READYZ_URL is missing", async () => {
    const stderr = vi.fn();
    const code = await main({
      env: {},
      fetchImpl: () => {
        throw new Error("should not be called when URL is missing");
      },
      stdout: () => {},
      stderr,
    });
    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("READYZ_URL is required"),
    );
  });

  it("returns 1 and writes a structured stderr line on a network failure", async () => {
    const stderr = vi.fn();
    const code = await main({
      env: { READYZ_URL: "https://example.com/api/readyz" },
      fetchImpl: async () => ({
        ok: false as const,
        error: "ECONNREFUSED",
      }),
      stdout: () => {},
      stderr,
    });
    expect(code).toBe(1);
    const line = JSON.parse(stderr.mock.calls[0]![0] as string) as Record<
      string,
      unknown
    >;
    expect(line.check).toBe("readyz_config");
    expect(line.outcome).toBe("probe_error");
    expect(line.error).toBe("ECONNREFUSED");
    expect(line.url).toBe("https://example.com/api/readyz");
  });

  it("returns 0 and emits an 'ok' structured line for a healthy production deploy", async () => {
    const stdout = vi.fn();
    const code = await main({
      env: { READYZ_URL: "https://example.com/api/readyz" },
      fetchImpl: async () => ({
        ok: true as const,
        body: {
          config: {
            productionHostnamePattern: "configured",
            rehearsalInjectorEnabled: "disabled",
            stubFulfillmentEnabled: "disabled",
            rateLimitStore: "redis",
            sentryDsn: "configured",
            mfaEncryptionKey: "configured",
            clerkSecretKey: "configured",
            termiiApiKey: "configured",
            moderationProvider: "configured",
            sanctionsProvider: "configured",
          },
        },
        httpStatus: 200,
      }),
      stdout,
      stderr: () => {},
    });
    expect(code).toBe(0);
    const line = JSON.parse(stdout.mock.calls[0]![0] as string) as {
      outcome: string;
      fields: { field: string; outcome: string }[];
      httpStatus: number;
    };
    expect(line.outcome).toBe("ok");
    expect(line.httpStatus).toBe(200);
    expect(line.fields).toHaveLength(10);
    expect(line.fields.every((f) => f.outcome === "ok")).toBe(true);
  });

  it("returns 2 (page) and lists every misconfigured field in the structured stdout line", async () => {
    const stdout = vi.fn();
    const code = await main({
      env: { READYZ_URL: "https://example.com/api/readyz" },
      fetchImpl: async () => ({
        ok: true as const,
        body: {
          config: {
            productionHostnamePattern: "missing",
            rehearsalInjectorEnabled: "enabled_in_production",
            stubFulfillmentEnabled: "disabled",
            rateLimitStore: "redis",
            sentryDsn: "missing",
            // Healthy on the new task #103 fields so we can pin down
            // that the paging set is exactly the three legacy
            // misconfigurations — not bleed-over from the new ones.
            mfaEncryptionKey: "configured",
            clerkSecretKey: "configured",
            termiiApiKey: "configured",
            moderationProvider: "configured",
            sanctionsProvider: "configured",
          },
        },
        httpStatus: 200,
      }),
      stdout,
      stderr: () => {},
    });
    expect(code).toBe(2);
    const line = JSON.parse(stdout.mock.calls[0]![0] as string) as {
      outcome: string;
      fields: { field: string; outcome: string; reason: string }[];
    };
    expect(line.outcome).toBe("page");
    const pagingFields = line.fields
      .filter((f) => f.outcome === "page")
      .map((f) => f.field);
    expect(pagingFields).toEqual([
      "productionHostnamePattern",
      "rehearsalInjectorEnabled",
      "sentryDsn",
    ]);
  });

  it("still pages on misconfiguration during a 503 not_ready response — the worst-possible time to lose the page", async () => {
    // The probe must accept BOTH 200 ready and 503 not_ready bodies:
    // /readyz includes the config block on both paths, and gating on
    // 200 here would silently paper over the misconfiguration during
    // a downstream outage.
    const stdout = vi.fn();
    const code = await main({
      env: { READYZ_URL: "https://example.com/api/readyz" },
      fetchImpl: async () => ({
        ok: true as const,
        body: {
          status: "not_ready",
          checks: { db: "failed" },
          failures: { db: "ECONNREFUSED" },
          config: {
            productionHostnamePattern: "missing",
            rehearsalInjectorEnabled: "disabled",
            stubFulfillmentEnabled: "disabled",
            rateLimitStore: "redis",
            sentryDsn: "configured",
            mfaEncryptionKey: "configured",
            clerkSecretKey: "configured",
            termiiApiKey: "configured",
            moderationProvider: "configured",
            sanctionsProvider: "configured",
          },
        },
        httpStatus: 503,
      }),
      stdout,
      stderr: () => {},
    });
    expect(code).toBe(2);
    const line = JSON.parse(stdout.mock.calls[0]![0] as string) as {
      outcome: string;
      httpStatus: number;
    };
    expect(line.outcome).toBe("page");
    expect(line.httpStatus).toBe(503);
  });
});
