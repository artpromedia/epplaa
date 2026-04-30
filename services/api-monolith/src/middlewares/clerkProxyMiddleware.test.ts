import { describe, it, expect } from "vitest";
import { assertClerkSecretKeyConfiguredForProduction } from "./clerkProxyMiddleware";

describe("assertClerkSecretKeyConfiguredForProduction — production CLERK_SECRET_KEY presence check", () => {
  // CLERK_SECRET_KEY is read in three places that all silently fall
  // back to a less-secure path: the /api/__clerk proxy passthrough,
  // the /auth/otp/verify noClerk-stub branch, and the Socket.IO
  // anonymous-socket fallback. The check turns the runbook
  // recommendation that "production must set CLERK_SECRET_KEY" into
  // an automated boot-time signal so the misconfiguration shows up
  // in log aggregators / Sentry within minutes instead of as a
  // dropped session somewhere in production.

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

  it("does nothing on a non-production deploy (staging) with no key set", () => {
    // Auth fallbacks are intentional on staging — the OTP loop is
    // tested without Clerk and anonymous sockets are useful for
    // local preview. The check must not warn or every staging boot
    // would emit production-only noise.
    const log = buildWarnSink();
    const result = assertClerkSecretKeyConfiguredForProduction(
      { NODE_ENV: "staging" },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("does nothing on a development deploy", () => {
    const log = buildWarnSink();
    const result = assertClerkSecretKeyConfiguredForProduction(
      { NODE_ENV: "development" },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("does nothing on a Replit dev workspace (REPLIT_DEPLOYMENT unset/0) with no key", () => {
    const log = buildWarnSink();
    for (const value of [undefined, "", "0", "true"]) {
      const env: NodeJS.ProcessEnv = { NODE_ENV: "development" };
      if (value !== undefined) env.REPLIT_DEPLOYMENT = value;
      const result = assertClerkSecretKeyConfiguredForProduction(env, log);
      expect(result.ok, `value=${String(value)}`).toBe(true);
    }
    expect(log.calls).toEqual([]);
  });

  it("WARNS when NODE_ENV=production and CLERK_SECRET_KEY is unset", () => {
    // The original task case: a production-shaped deploy ships
    // without Clerk's server key. The check must surface a loud
    // structured warning naming all three silently-degraded code
    // paths so triage can immediately confirm the auth regression.
    const log = buildWarnSink();
    const result = assertClerkSecretKeyConfiguredForProduction(
      { NODE_ENV: "production" },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/CLERK_SECRET_KEY/);
    expect(result.reason).toMatch(/NODE_ENV=production/);
    expect(result.reason).toMatch(/runbook|production-secrets/i);
    // The reason string must enumerate the three failure modes —
    // an operator should not have to grep the source to know what
    // is broken.
    expect(result.reason).toMatch(/proxy/);
    expect(result.reason).toMatch(/otp/i);
    expect(result.reason).toMatch(/socket/i);
    expect(log.calls).toHaveLength(1);
    const [obj, msg] = log.calls[0]!;
    expect(obj).toMatchObject({
      node_env: "production",
      clerk_secret_key: null,
      production_signals: ["node_env"],
    });
    // Dedicated message identifier so log aggregators / Sentry
    // alerts can be wired up exactly to this event.
    expect(msg).toMatch(/clerk_secret_key_missing_for_production/);
  });

  it("WARNS when CLERK_SECRET_KEY is whitespace-only on a production deploy", () => {
    // A `CLERK_SECRET_KEY=   ` env value would let the three code
    // paths take their fallback branches just like the unset case.
    // The check must treat both the same.
    const log = buildWarnSink();
    const result = assertClerkSecretKeyConfiguredForProduction(
      { NODE_ENV: "production", CLERK_SECRET_KEY: "   " },
      log,
    );
    expect(result.ok).toBe(false);
    expect(log.calls).toHaveLength(1);
  });

  it("does NOT echo the secret key value into the log payload on warn", () => {
    // We must never leak the actual key — even a whitespace value
    // must be reported as a sentinel ("[set-but-empty]") rather
    // than copied into the log.
    const log = buildWarnSink();
    const result = assertClerkSecretKeyConfiguredForProduction(
      { NODE_ENV: "production", CLERK_SECRET_KEY: "   " },
      log,
    );
    expect(result.ok).toBe(false);
    const [obj] = log.calls[0]!;
    const objJson = JSON.stringify(obj);
    expect(objJson).not.toMatch(/sk_live_/);
    expect(objJson).not.toMatch(/sk_test_/);
    expect(obj).toMatchObject({ clerk_secret_key: "[set-but-empty]" });
  });

  it("WARNS when REPLIT_DEPLOYMENT=1 alone triggers production-shape detection", () => {
    const log = buildWarnSink();
    const result = assertClerkSecretKeyConfiguredForProduction(
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
    const result = assertClerkSecretKeyConfiguredForProduction(
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
    const result = assertClerkSecretKeyConfiguredForProduction(
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

  it("does NOT warn when CLERK_SECRET_KEY is configured on a production deploy (the healthy path)", () => {
    const log = buildWarnSink();
    const result = assertClerkSecretKeyConfiguredForProduction(
      { NODE_ENV: "production", CLERK_SECRET_KEY: "sk_live_abc123def456" },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });
});
