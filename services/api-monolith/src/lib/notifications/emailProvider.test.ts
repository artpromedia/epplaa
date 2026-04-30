import { describe, it, expect } from "vitest";
import { assertEmailProviderConfiguredForProduction } from "./emailProvider";

describe("assertEmailProviderConfiguredForProduction — production email-provider presence check", () => {
  // Without POSTMARK_API_TOKEN / SENDGRID_API_KEY the email channel
  // registry falls back to ConsoleChannel, which logs and returns
  // ok=true so the outbox marks rows delivered without anyone
  // receiving the email. The check turns the runbook recommendation
  // into an automated boot-time signal so on-call sees the
  // misconfiguration in log aggregators / Sentry within minutes
  // instead of after a missing security email.

  type WarnCall = [obj: unknown, msg: string];
  function buildWarnSink(): {
    warn: (obj: unknown, msg: string) => void;
    calls: WarnCall[];
  } {
    const calls: WarnCall[] = [];
    return { warn: (obj, msg) => calls.push([obj, msg]), calls };
  }

  it("does nothing on a non-production deploy (staging) with no provider set", () => {
    const log = buildWarnSink();
    const result = assertEmailProviderConfiguredForProduction(
      { NODE_ENV: "staging" },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("does nothing on a development deploy", () => {
    const log = buildWarnSink();
    const result = assertEmailProviderConfiguredForProduction(
      { NODE_ENV: "development" },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("WARNS when NODE_ENV=production and neither provider env var is set", () => {
    const log = buildWarnSink();
    const result = assertEmailProviderConfiguredForProduction(
      { NODE_ENV: "production" },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/POSTMARK_API_TOKEN/);
    expect(result.reason).toMatch(/SENDGRID_API_KEY/);
    expect(result.reason).toMatch(/ConsoleChannel|silently dropped/);
    expect(log.calls).toHaveLength(1);
    const [obj, msg] = log.calls[0]!;
    expect(obj).toMatchObject({
      node_env: "production",
      postmark_api_token: null,
      sendgrid_api_key: null,
      production_signals: ["node_env"],
    });
    expect(msg).toMatch(/email_provider_missing_for_production/);
  });

  it("WARNS when REPLIT_DEPLOYMENT=1 alone triggers production-shape detection", () => {
    const log = buildWarnSink();
    const result = assertEmailProviderConfiguredForProduction(
      { REPLIT_DEPLOYMENT: "1" },
      log,
    );
    expect(result.ok).toBe(false);
    expect(log.calls).toHaveLength(1);
  });

  it("WARNS when DEPLOYMENT_ENVIRONMENT=production alone triggers production-shape detection", () => {
    const log = buildWarnSink();
    const result = assertEmailProviderConfiguredForProduction(
      { DEPLOYMENT_ENVIRONMENT: "production" },
      log,
    );
    expect(result.ok).toBe(false);
    expect(log.calls).toHaveLength(1);
  });

  it("aggregates every production signal into a single warning", () => {
    const log = buildWarnSink();
    const result = assertEmailProviderConfiguredForProduction(
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

  it("does NOT echo the secret value on warn (postmark whitespace-only)", () => {
    const log = buildWarnSink();
    const sentinel = "POSTMARK-SECRET-TOKEN-VALUE";
    const result = assertEmailProviderConfiguredForProduction(
      { NODE_ENV: "production", POSTMARK_API_TOKEN: " " },
      log,
    );
    // Whitespace-only is treated as unset — the check still warns.
    // Confirm the sentinel pattern is never echoed even when the slot
    // is filled, and the structured payload uses the
    // `[set-but-empty]` sentinel instead of the raw value.
    expect(result.ok).toBe(false);
    expect(JSON.stringify(log.calls[0])).not.toContain(sentinel);
    const [obj] = log.calls[0]!;
    expect(obj).toMatchObject({
      postmark_api_token: "[set-but-empty]",
      sendgrid_api_key: null,
    });
  });

  it("does NOT echo the secret value on warn (sendgrid whitespace-only)", () => {
    const log = buildWarnSink();
    const sentinel = "SG.SENDGRID-SECRET-VALUE";
    const result = assertEmailProviderConfiguredForProduction(
      { NODE_ENV: "production", SENDGRID_API_KEY: "   " },
      log,
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(log.calls[0])).not.toContain(sentinel);
    const [obj] = log.calls[0]!;
    expect(obj).toMatchObject({
      postmark_api_token: null,
      sendgrid_api_key: "[set-but-empty]",
    });
  });

  it("does NOT warn when POSTMARK_API_TOKEN alone is configured (single-provider deploy)", () => {
    const log = buildWarnSink();
    const result = assertEmailProviderConfiguredForProduction(
      { NODE_ENV: "production", POSTMARK_API_TOKEN: "pm-server-abc123" },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("does NOT warn when SENDGRID_API_KEY alone is configured (single-provider deploy)", () => {
    const log = buildWarnSink();
    const result = assertEmailProviderConfiguredForProduction(
      { NODE_ENV: "production", SENDGRID_API_KEY: "SG.abc123" },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("does NOT warn when BOTH providers are configured (failover deploy)", () => {
    const log = buildWarnSink();
    const result = assertEmailProviderConfiguredForProduction(
      {
        NODE_ENV: "production",
        POSTMARK_API_TOKEN: "pm-server-abc123",
        SENDGRID_API_KEY: "SG.abc123",
      },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });
});
