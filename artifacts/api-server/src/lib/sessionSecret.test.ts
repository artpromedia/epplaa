import { describe, it, expect } from "vitest";
import {
  SESSION_SECRET_MIN_LENGTH,
  assertSessionSecretConfiguredForProduction,
} from "./sessionSecret";

describe("assertSessionSecretConfiguredForProduction — production SESSION_SECRET presence check", () => {
  // SESSION_SECRET signs shipping-quote tokens, address-verification
  // tokens, and encrypts KYC documents at rest. Each consumer fails
  // closed at first use (the secret is required at runtime), so the
  // misconfiguration is not silently exploitable, but the failure
  // mode is per-request 5xx storms rather than a clean operator-
  // facing alert. This boot-time check converts the silent-then-loud
  // failure mode into a single boot-time signal.

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

  it("does nothing on a non-production deploy (staging) with no secret set", () => {
    // Dev / staging legitimately rely on the per-consumer fallbacks
    // (e.g. mfa.ts's `dev-mfa-pepper`). The check must not warn or
    // every staging boot would emit production-only noise.
    const log = buildWarnSink();
    const result = assertSessionSecretConfiguredForProduction(
      { NODE_ENV: "staging" },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("does nothing on a development deploy", () => {
    const log = buildWarnSink();
    const result = assertSessionSecretConfiguredForProduction(
      { NODE_ENV: "development" },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("does nothing on a Replit dev workspace (REPLIT_DEPLOYMENT unset/0) with no secret", () => {
    const log = buildWarnSink();
    for (const value of [undefined, "", "0", "true"]) {
      const env: NodeJS.ProcessEnv = { NODE_ENV: "development" };
      if (value !== undefined) env.REPLIT_DEPLOYMENT = value;
      const result = assertSessionSecretConfiguredForProduction(env, log);
      expect(result.ok, `value=${String(value)}`).toBe(true);
    }
    expect(log.calls).toEqual([]);
  });

  it("WARNS when NODE_ENV=production and SESSION_SECRET is unset", () => {
    // The original task case: a production-shaped deploy ships
    // without SESSION_SECRET. Boot looks healthy, then the next
    // checkout / KYC upload 5xxs. The check must surface a loud
    // structured warning naming the consumers that will throw on
    // first use.
    const log = buildWarnSink();
    const result = assertSessionSecretConfiguredForProduction(
      { NODE_ENV: "production" },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/SESSION_SECRET is unset/);
    expect(result.reason).toMatch(/NODE_ENV=production/);
    expect(result.reason).toMatch(/runbook|production-secrets/i);
    // Reason must enumerate the affected consumers — operator
    // shouldn't have to grep the source to know what's broken.
    expect(result.reason).toMatch(/quoteToken|shipping/i);
    expect(result.reason).toMatch(/verifyToken|address/i);
    expect(result.reason).toMatch(/kyc/i);
    expect(log.calls).toHaveLength(1);
    const [obj, msg] = log.calls[0]!;
    expect(obj).toMatchObject({
      node_env: "production",
      session_secret_condition: "unset",
      session_secret_length: 0,
      production_signals: ["node_env"],
    });
    // Dedicated message identifier so log aggregators / Sentry
    // alerts can be wired up exactly to this event.
    expect(msg).toMatch(/session_secret_missing_for_production/);
  });

  it("WARNS when SESSION_SECRET is empty/whitespace-only on a production deploy", () => {
    // Same misconfiguration as unset — kyc.ts and verifyToken.ts
    // both throw on `s.length < 16` after trimming, so the check
    // must agree.
    const log = buildWarnSink();
    const result = assertSessionSecretConfiguredForProduction(
      { NODE_ENV: "production", SESSION_SECRET: "   " },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(log.calls).toHaveLength(1);
    const [obj] = log.calls[0]!;
    expect(obj).toMatchObject({
      session_secret_condition: "empty",
      session_secret_length: 0,
    });
  });

  it("WARNS when SESSION_SECRET is shorter than the minimum on a production deploy", () => {
    // The 16-character minimum mirrors the runtime guards in
    // kyc.ts and fulfillment/verifyToken.ts. A 15-character secret
    // would pass the unset/empty check but still throw on first KYC
    // upload — the boot-time check must catch it.
    expect(SESSION_SECRET_MIN_LENGTH).toBe(16);
    const tooShort = "a".repeat(SESSION_SECRET_MIN_LENGTH - 1);
    const log = buildWarnSink();
    const result = assertSessionSecretConfiguredForProduction(
      { NODE_ENV: "production", SESSION_SECRET: tooShort },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/length=15/);
    expect(result.reason).toMatch(/< 16/);
    expect(log.calls).toHaveLength(1);
    const [obj] = log.calls[0]!;
    expect(obj).toMatchObject({
      session_secret_condition: "too_short",
      session_secret_length: 15,
    });
  });

  it("does NOT echo the secret value into the log payload on warn", () => {
    // We must never leak the actual secret — only its length and a
    // condition tag are safe to log.
    const log = buildWarnSink();
    const sentinel = "secretsecretXXX"; // 15 chars — too short
    const result = assertSessionSecretConfiguredForProduction(
      { NODE_ENV: "production", SESSION_SECRET: sentinel },
      log,
    );
    expect(result.ok).toBe(false);
    const [obj] = log.calls[0]!;
    expect(JSON.stringify(obj)).not.toContain(sentinel);
    // Reason string is also surfaced into log aggregators via the
    // message body — must not echo the secret either.
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).not.toContain(sentinel);
  });

  it("WARNS when REPLIT_DEPLOYMENT=1 alone triggers production-shape detection", () => {
    const log = buildWarnSink();
    const result = assertSessionSecretConfiguredForProduction(
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
    const result = assertSessionSecretConfiguredForProduction(
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
    const result = assertSessionSecretConfiguredForProduction(
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

  it("does NOT warn when SESSION_SECRET is configured (>=16 chars) on a production deploy", () => {
    const log = buildWarnSink();
    const result = assertSessionSecretConfiguredForProduction(
      {
        NODE_ENV: "production",
        SESSION_SECRET: "a".repeat(SESSION_SECRET_MIN_LENGTH),
      },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("does NOT warn for a long, healthy SESSION_SECRET on a production deploy", () => {
    const log = buildWarnSink();
    const result = assertSessionSecretConfiguredForProduction(
      {
        NODE_ENV: "production",
        SESSION_SECRET:
          "a-real-strong-secret-with-plenty-of-entropy-1234567890abcdef",
      },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });
});
