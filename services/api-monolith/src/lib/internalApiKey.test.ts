import { describe, it, expect } from "vitest";
import { assertInternalApiKeyConfiguredForProduction } from "./internalApiKey";

describe("assertInternalApiKeyConfiguredForProduction — production INTERNAL_API_KEY presence check", () => {
  // Without INTERNAL_API_KEY the /pudo, /promos, and
  // /referrals/payout cross-service webhooks return 503
  // not_configured to every caller. Fail-closed (no auth bypass) but
  // partner integrations stop working until the key is set.

  type WarnCall = [obj: unknown, msg: string];
  function buildWarnSink(): {
    warn: (obj: unknown, msg: string) => void;
    calls: WarnCall[];
  } {
    const calls: WarnCall[] = [];
    return { warn: (obj, msg) => calls.push([obj, msg]), calls };
  }

  it("does nothing on a non-production deploy (staging) with no key set", () => {
    const log = buildWarnSink();
    const result = assertInternalApiKeyConfiguredForProduction(
      { NODE_ENV: "staging" },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("WARNS when NODE_ENV=production and INTERNAL_API_KEY is unset", () => {
    const log = buildWarnSink();
    const result = assertInternalApiKeyConfiguredForProduction(
      { NODE_ENV: "production" },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/INTERNAL_API_KEY/);
    expect(result.reason).toMatch(/503 not_configured/);
    expect(log.calls).toHaveLength(1);
    const [obj, msg] = log.calls[0]!;
    expect(obj).toMatchObject({
      internal_api_key: null,
      production_signals: ["node_env"],
    });
    expect(msg).toMatch(/internal_api_key_missing_for_production/);
  });

  it("WARNS when REPLIT_DEPLOYMENT=1 alone triggers production-shape detection", () => {
    const log = buildWarnSink();
    const result = assertInternalApiKeyConfiguredForProduction(
      { REPLIT_DEPLOYMENT: "1" },
      log,
    );
    expect(result.ok).toBe(false);
    expect(log.calls).toHaveLength(1);
  });

  it("WARNS when DEPLOYMENT_ENVIRONMENT=production alone triggers production-shape detection", () => {
    const log = buildWarnSink();
    const result = assertInternalApiKeyConfiguredForProduction(
      { DEPLOYMENT_ENVIRONMENT: "production" },
      log,
    );
    expect(result.ok).toBe(false);
    expect(log.calls).toHaveLength(1);
  });

  it("does NOT echo the secret value on warn", () => {
    const log = buildWarnSink();
    const sentinel = "internal_SECRETxxxxxxxxxxxxxxxx";
    const result = assertInternalApiKeyConfiguredForProduction(
      { NODE_ENV: "production", INTERNAL_API_KEY: " " },
      log,
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(log.calls[0])).not.toContain(sentinel);
    const [obj] = log.calls[0]!;
    expect(obj).toMatchObject({ internal_api_key: "[set-but-empty]" });
  });

  it("does NOT warn when INTERNAL_API_KEY is configured on a production deploy", () => {
    const log = buildWarnSink();
    const result = assertInternalApiKeyConfiguredForProduction(
      { NODE_ENV: "production", INTERNAL_API_KEY: "internal_abc" },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });
});
