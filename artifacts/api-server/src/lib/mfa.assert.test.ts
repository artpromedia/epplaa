import { describe, it, expect } from "vitest";
import { assertMfaEncryptionKeyConfiguredForProduction } from "./mfa";

describe("assertMfaEncryptionKeyConfiguredForProduction — production MFA_ENCRYPTION_KEY presence check", () => {
  // The lib/mfa.ts encryptionKey() lazy throw is gated on
  // NODE_ENV=production ONLY, so a deploy that uses
  // REPLIT_DEPLOYMENT=1 / DEPLOYMENT_ENVIRONMENT=production without
  // NODE_ENV=production would silently encrypt TOTP secrets under a
  // SESSION_SECRET-derived key. The boot-time check covers all three
  // production signals.

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
    const result = assertMfaEncryptionKeyConfiguredForProduction(
      { NODE_ENV: "staging" },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("WARNS when NODE_ENV=production and MFA_ENCRYPTION_KEY is unset", () => {
    const log = buildWarnSink();
    const result = assertMfaEncryptionKeyConfiguredForProduction(
      { NODE_ENV: "production" },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/MFA_ENCRYPTION_KEY/);
    expect(result.reason).toMatch(/SESSION_SECRET-derived key/);
    expect(log.calls).toHaveLength(1);
    const [obj, msg] = log.calls[0]!;
    expect(obj).toMatchObject({
      mfa_encryption_key: null,
      production_signals: ["node_env"],
    });
    expect(msg).toMatch(/mfa_encryption_key_missing_for_production/);
  });

  it("WARNS when REPLIT_DEPLOYMENT=1 alone triggers production-shape detection (NODE_ENV unset)", () => {
    // Crucially: this is the case the encryptionKey() lazy throw
    // would MISS — boot-time check catches it.
    const log = buildWarnSink();
    const result = assertMfaEncryptionKeyConfiguredForProduction(
      { REPLIT_DEPLOYMENT: "1" },
      log,
    );
    expect(result.ok).toBe(false);
    expect(log.calls).toHaveLength(1);
  });

  it("WARNS when DEPLOYMENT_ENVIRONMENT=production alone triggers production-shape detection (NODE_ENV unset)", () => {
    const log = buildWarnSink();
    const result = assertMfaEncryptionKeyConfiguredForProduction(
      { DEPLOYMENT_ENVIRONMENT: "production" },
      log,
    );
    expect(result.ok).toBe(false);
    expect(log.calls).toHaveLength(1);
  });

  it("does NOT echo the secret value on warn", () => {
    const log = buildWarnSink();
    const sentinel = "11112222333344445555666677778888";
    // Whitespace value triggers [set-but-empty] path — sentinel
    // never appears anywhere because we never read the secret value.
    const result = assertMfaEncryptionKeyConfiguredForProduction(
      { NODE_ENV: "production", MFA_ENCRYPTION_KEY: " " },
      log,
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(log.calls[0])).not.toContain(sentinel);
    const [obj] = log.calls[0]!;
    expect(obj).toMatchObject({ mfa_encryption_key: "[set-but-empty]" });
  });

  it("does NOT warn when MFA_ENCRYPTION_KEY is configured on a production deploy", () => {
    const log = buildWarnSink();
    const result = assertMfaEncryptionKeyConfiguredForProduction(
      {
        NODE_ENV: "production",
        MFA_ENCRYPTION_KEY: "11112222333344445555666677778888",
      },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });
});
