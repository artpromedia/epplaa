import { describe, it, expect } from "vitest";
import { assertSentryDsnConfiguredForProduction } from "./sentry";

describe("assertSentryDsnConfiguredForProduction — production SENTRY_DSN presence check", () => {
  // SENTRY_DSN is read by `initSentryServer`; if it's unset on a
  // production deploy the SDK is silently swapped for a no-op shim
  // and every alert layered on top of Sentry stops firing. The
  // runbook (`docs/runbooks/production-secrets.md`) recommends
  // setting it on every production deploy; this check turns that
  // recommendation into an automated boot-time signal so the
  // misconfiguration shows up in log aggregators within minutes
  // instead of the next real outage.

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

  it("does nothing on a non-production deploy (staging) with no DSN set", () => {
    // Sentry is optional on staging — the check must not warn,
    // otherwise every staging boot would emit noise about a
    // production-only configuration.
    const log = buildWarnSink();
    const result = assertSentryDsnConfiguredForProduction(
      { NODE_ENV: "staging" },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("does nothing on a development deploy", () => {
    const log = buildWarnSink();
    const result = assertSentryDsnConfiguredForProduction(
      { NODE_ENV: "development" },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("does nothing on a Replit dev workspace (REPLIT_DEPLOYMENT unset/0) with no DSN", () => {
    const log = buildWarnSink();
    for (const value of [undefined, "", "0", "true"]) {
      const env: NodeJS.ProcessEnv = { NODE_ENV: "development" };
      if (value !== undefined) env.REPLIT_DEPLOYMENT = value;
      const result = assertSentryDsnConfiguredForProduction(env, log);
      expect(result.ok, `value=${String(value)}`).toBe(true);
    }
    expect(log.calls).toEqual([]);
  });

  it("WARNS when NODE_ENV=production and SENTRY_DSN is unset", () => {
    // The original task case: a production-shaped deploy ships
    // without Sentry configured. The check must surface a loud
    // structured warning — the `sentry_disabled_no_dsn` info log
    // from initSentryServer is too quiet to notice in normal boot
    // chatter.
    const log = buildWarnSink();
    const result = assertSentryDsnConfiguredForProduction(
      { NODE_ENV: "production" },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/SENTRY_DSN/);
    expect(result.reason).toMatch(/NODE_ENV=production/);
    expect(result.reason).toMatch(/runbook|production-secrets/i);
    expect(log.calls).toHaveLength(1);
    const [obj, msg] = log.calls[0]!;
    expect(obj).toMatchObject({
      node_env: "production",
      sentry_dsn: null,
      production_signals: ["node_env"],
    });
    // Dedicated message identifier so log aggregators / Sentry
    // alerts can be wired up exactly to this event.
    expect(msg).toMatch(/sentry_dsn_missing_for_production/);
  });

  it("WARNS when SENTRY_DSN is whitespace-only on a production deploy", () => {
    // A `SENTRY_DSN=   ` env value is the same misconfiguration as
    // unset — the SDK's `init` would also reject it. The check must
    // treat both the same.
    const log = buildWarnSink();
    const result = assertSentryDsnConfiguredForProduction(
      { NODE_ENV: "production", SENTRY_DSN: "   " },
      log,
    );
    expect(result.ok).toBe(false);
    expect(log.calls).toHaveLength(1);
  });

  it("WARNS when REPLIT_DEPLOYMENT=1 alone triggers production-shape detection", () => {
    const log = buildWarnSink();
    const result = assertSentryDsnConfiguredForProduction(
      { REPLIT_DEPLOYMENT: "1" },
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

  it("WARNS when DEPLOYMENT_ENVIRONMENT=production alone triggers production-shape detection", () => {
    const log = buildWarnSink();
    const result = assertSentryDsnConfiguredForProduction(
      { DEPLOYMENT_ENVIRONMENT: "production" },
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

  it("aggregates every production signal into a single warning so on-call sees them all at once", () => {
    const log = buildWarnSink();
    const result = assertSentryDsnConfiguredForProduction(
      {
        NODE_ENV: "production",
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
    expect(log.calls).toHaveLength(1);
    const [obj] = log.calls[0]!;
    expect(obj).toMatchObject({
      production_signals: [
        "node_env",
        "replit_deployment",
        "deployment_environment",
      ],
    });
  });

  it("does NOT warn when SENTRY_DSN is configured on a production deploy (the healthy path)", () => {
    // The common, correct case: a real production deploy with
    // Sentry configured. Must return ok with zero log output —
    // the check is meant to be silent on a healthy boot.
    const log = buildWarnSink();
    const result = assertSentryDsnConfiguredForProduction(
      {
        NODE_ENV: "production",
        SENTRY_DSN: "https://abcdef@o123.ingest.sentry.io/456",
      },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });
});
