import { describe, it, expect } from "vitest";
import { assertTermiiConfiguredForProduction } from "./termii";

describe("assertTermiiConfiguredForProduction — production TERMII_API_KEY presence check", () => {
  // Without TERMII_API_KEY the OTP issuer flips into devEcho mode
  // (the OTP code is returned in the API response) — every phone OTP
  // becomes trivially bypassable on a misconfigured production deploy.
  // The check turns the runbook recommendation into an automated boot-
  // time signal so on-call sees the misconfiguration in log
  // aggregators / Sentry within minutes instead of as a fraud spike.

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
    const result = assertTermiiConfiguredForProduction(
      { NODE_ENV: "staging" },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("does nothing on a development deploy", () => {
    const log = buildWarnSink();
    const result = assertTermiiConfiguredForProduction(
      { NODE_ENV: "development" },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("WARNS when NODE_ENV=production and TERMII_API_KEY is unset", () => {
    const log = buildWarnSink();
    const result = assertTermiiConfiguredForProduction(
      { NODE_ENV: "production" },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/TERMII_API_KEY/);
    expect(result.reason).toMatch(/NODE_ENV=production/);
    expect(result.reason).toMatch(/devEcho|trivially bypassable/);
    expect(log.calls).toHaveLength(1);
    const [obj, msg] = log.calls[0]!;
    expect(obj).toMatchObject({
      node_env: "production",
      termii_api_key: null,
      production_signals: ["node_env"],
    });
    expect(msg).toMatch(/termii_api_key_missing_for_production/);
  });

  it("WARNS when REPLIT_DEPLOYMENT=1 alone triggers production-shape detection", () => {
    const log = buildWarnSink();
    const result = assertTermiiConfiguredForProduction(
      { REPLIT_DEPLOYMENT: "1" },
      log,
    );
    expect(result.ok).toBe(false);
    expect(log.calls).toHaveLength(1);
  });

  it("WARNS when DEPLOYMENT_ENVIRONMENT=production alone triggers production-shape detection", () => {
    const log = buildWarnSink();
    const result = assertTermiiConfiguredForProduction(
      { DEPLOYMENT_ENVIRONMENT: "production" },
      log,
    );
    expect(result.ok).toBe(false);
    expect(log.calls).toHaveLength(1);
  });

  it("aggregates every production signal into a single warning", () => {
    const log = buildWarnSink();
    const result = assertTermiiConfiguredForProduction(
      {
        NODE_ENV: "production",
        REPLIT_DEPLOYMENT: "1",
        DEPLOYMENT_ENVIRONMENT: "production",
      },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const [obj] = log.calls[0]!;
    expect(obj).toMatchObject({
      production_signals: [
        "node_env",
        "replit_deployment",
        "deployment_environment",
      ],
    });
  });

  it("does NOT echo the secret value on warn", () => {
    const log = buildWarnSink();
    const sentinel = "TLPv1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const result = assertTermiiConfiguredForProduction(
      { NODE_ENV: "production", TERMII_API_KEY: " " },
      log,
    );
    // Secret-looking value is whitespace here; just confirm the
    // sentinel pattern is never echoed even when the slot is filled.
    expect(result.ok).toBe(false);
    expect(JSON.stringify(log.calls[0])).not.toContain(sentinel);
    const [obj] = log.calls[0]!;
    expect(obj).toMatchObject({ termii_api_key: "[set-but-empty]" });
  });

  it("does NOT warn when TERMII_API_KEY is configured on a production deploy", () => {
    const log = buildWarnSink();
    const result = assertTermiiConfiguredForProduction(
      { NODE_ENV: "production", TERMII_API_KEY: "TLPv1abcdef" },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });
});
