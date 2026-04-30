import { describe, it, expect } from "vitest";
import { assertOkHiConfiguredForProduction } from "./okhi";

describe("assertOkHiConfiguredForProduction — production OkHi credential presence check", () => {
  // Without OKHI_API_KEY + OKHI_BRANCH_ID the runtime
  // allowStubFallback() guard fails the next address-verification
  // call closed (5xx), but boot looks healthy until then. Boot-time
  // warning surfaces the misconfiguration to log aggregators / Sentry
  // before the first buyer hits the address-verification step.

  type WarnCall = [obj: unknown, msg: string];
  function buildWarnSink(): {
    warn: (obj: unknown, msg: string) => void;
    calls: WarnCall[];
  } {
    const calls: WarnCall[] = [];
    return { warn: (obj, msg) => calls.push([obj, msg]), calls };
  }

  it("does nothing on a non-production deploy (staging) with no creds set", () => {
    const log = buildWarnSink();
    const result = assertOkHiConfiguredForProduction(
      { NODE_ENV: "staging" },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("WARNS when production-shape detected and BOTH creds are missing", () => {
    const log = buildWarnSink();
    const result = assertOkHiConfiguredForProduction(
      { NODE_ENV: "production" },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/OKHI_API_KEY/);
    expect(result.reason).toMatch(/OKHI_BRANCH_ID/);
    expect(log.calls).toHaveLength(1);
    const [obj, msg] = log.calls[0]!;
    expect(obj).toMatchObject({
      missing: ["OKHI_API_KEY", "OKHI_BRANCH_ID"],
    });
    expect(msg).toMatch(/okhi_credentials_missing_for_production/);
  });

  it("WARNS when only OKHI_API_KEY is set (BRANCH_ID still missing)", () => {
    const log = buildWarnSink();
    const result = assertOkHiConfiguredForProduction(
      { NODE_ENV: "production", OKHI_API_KEY: "ok_test_xxx" },
      log,
    );
    expect(result.ok).toBe(false);
    const [obj] = log.calls[0]!;
    expect(obj).toMatchObject({
      missing: ["OKHI_BRANCH_ID"],
      okhi_api_key: "[set]",
      okhi_branch_id: null,
    });
  });

  it("WARNS when only OKHI_BRANCH_ID is set (API_KEY still missing)", () => {
    const log = buildWarnSink();
    const result = assertOkHiConfiguredForProduction(
      { NODE_ENV: "production", OKHI_BRANCH_ID: "branch_xxx" },
      log,
    );
    expect(result.ok).toBe(false);
    const [obj] = log.calls[0]!;
    expect(obj).toMatchObject({
      missing: ["OKHI_API_KEY"],
      okhi_api_key: null,
      okhi_branch_id: "[set]",
    });
  });

  it("does NOT echo secret values on warn", () => {
    const log = buildWarnSink();
    const sentinelKey = "ok_live_SECRETxxxxxxxxxxxxxxxx";
    const sentinelBranch = "branch_SECRETxxxxxxxxxxxxxxxx";
    const result = assertOkHiConfiguredForProduction(
      {
        NODE_ENV: "production",
        OKHI_API_KEY: sentinelKey,
        OKHI_BRANCH_ID: " ",
      },
      log,
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(log.calls[0])).not.toContain(sentinelKey);
    expect(JSON.stringify(log.calls[0])).not.toContain(sentinelBranch);
  });

  it("does NOT warn when both creds are configured on a production deploy", () => {
    const log = buildWarnSink();
    const result = assertOkHiConfiguredForProduction(
      {
        NODE_ENV: "production",
        OKHI_API_KEY: "ok_live_abc",
        OKHI_BRANCH_ID: "branch_abc",
      },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });
});
