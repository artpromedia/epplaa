import { describe, expect, it } from "vitest";
import { decideSecurityEmail } from "./securityEmail";

/**
 * decideSecurityEmail is the single source of truth for which event
 * types render with the branded "Security alert" template — both the
 * Postmark and SendGrid adapters consult it. These tests pin the
 * mapping so that:
 *   - the two MFA security events opt in with the correct CTA + sig
 *   - the existing nudge event (`mfa_backup_codes_low`) does NOT
 *   - meta lines come through verbatim from the payload, with a
 *     pretty-printed UTC timestamp and missing fields dropped (so
 *     we never render "IP: unknown" into a recipient's inbox)
 */
describe("decideSecurityEmail", () => {
  it("flags mfa_activated with the security CTA + Epplaa Security Team signature", () => {
    const out = decideSecurityEmail({
      to: "buyer@example.com",
      title: "Two-factor sign-in is now on for your account",
      body: "You've enabled an authenticator app.",
      url: "/account/security",
      eventType: "mfa_activated",
    });
    expect(out.isSecurity).toBe(true);
    expect(out.ctaLabel).toBe("Review your security settings");
    expect(out.signature).toBe("— The Epplaa Security Team");
    expect(out.metaLines).toEqual([]);
  });

  it("flags mfa_backup_codes_regenerated and composes meta lines from payload", () => {
    const out = decideSecurityEmail({
      to: "buyer@example.com",
      title: "Your MFA backup codes were regenerated",
      body: "A fresh set of backup codes was generated.",
      url: "/account/security",
      eventType: "mfa_backup_codes_regenerated",
      payload: {
        ipAddress: "203.0.113.10",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
        occurredAt: "2026-04-29T14:32:10.000Z",
      },
    });
    expect(out.isSecurity).toBe(true);
    expect(out.metaLines).toEqual([
      { label: "When", value: "2026-04-29 14:32:10 UTC" },
      { label: "IP", value: "203.0.113.10" },
      { label: "Device", value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)" },
    ]);
  });

  it("drops meta lines whose payload field is missing/empty (no 'unknown' placeholders)", () => {
    const out = decideSecurityEmail({
      to: "buyer@example.com",
      title: "t",
      body: "b",
      eventType: "mfa_backup_codes_regenerated",
      payload: { ipAddress: "", userAgent: undefined, occurredAt: "" },
    });
    expect(out.isSecurity).toBe(true);
    expect(out.metaLines).toEqual([]);
  });

  it("falls back to the raw timestamp when occurredAt does not parse", () => {
    const out = decideSecurityEmail({
      to: "buyer@example.com",
      title: "t",
      body: "b",
      eventType: "mfa_backup_codes_regenerated",
      payload: { occurredAt: "not-a-date" },
    });
    expect(out.metaLines).toEqual([{ label: "When", value: "not-a-date" }]);
  });

  it("does NOT flag mfa_backup_codes_low (the nudge keeps the default template)", () => {
    const out = decideSecurityEmail({
      to: "buyer@example.com",
      title: "Your MFA backup codes are running low",
      body: "You have 2 backup codes left.",
      url: "/account/security",
      eventType: "mfa_backup_codes_low",
    });
    expect(out.isSecurity).toBe(false);
  });

  it("does NOT flag a missing eventType (back-compat for direct adapter callers)", () => {
    const out = decideSecurityEmail({
      to: "buyer@example.com",
      title: "t",
      body: "b",
    });
    expect(out.isSecurity).toBe(false);
  });
});
