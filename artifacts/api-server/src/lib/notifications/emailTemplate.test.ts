import { describe, it, expect } from "vitest";
import { renderEpplaaEmail, resolveCtaUrl } from "./emailTemplate";

describe("renderEpplaaEmail — branded template renderer", () => {
  // The MFA backup-codes nudge enqueues `url: "/account/security"` —
  // these tests pin the contract that the template (a) renders the
  // Epplaa header, (b) resolves the relative CTA against the link
  // base, and (c) escapes user-controlled content so a hostile
  // payload cannot smuggle markup into a recipient's inbox.

  it("uses the title as the subject", () => {
    const out = renderEpplaaEmail({
      title: "Your MFA backup codes are running low",
      body: "You have 2 backup codes left.",
      ctaUrl: "/account/security",
      linkBaseUrl: "https://epplaa.com",
    });
    expect(out.subject).toBe("Your MFA backup codes are running low");
  });

  it("includes the Epplaa wordmark in the HTML header", () => {
    const out = renderEpplaaEmail({
      title: "t",
      body: "b",
      linkBaseUrl: "https://epplaa.com",
    });
    expect(out.html).toContain(">\n                  Epplaa\n                </span>");
  });

  it("renders the title as an h1 and the body as a paragraph", () => {
    const out = renderEpplaaEmail({
      title: "Hello",
      body: "World",
      linkBaseUrl: "https://epplaa.com",
    });
    expect(out.html).toMatch(/<h1[^>]*>\s*Hello\s*<\/h1>/);
    expect(out.html).toMatch(/<p[^>]*>\s*World\s*<\/p>/);
  });

  it("renders an absolute CTA button when ctaUrl is the relative /account/security", () => {
    const out = renderEpplaaEmail({
      title: "t",
      body: "b",
      ctaUrl: "/account/security",
      linkBaseUrl: "https://epplaa.com",
    });
    expect(out.html).toContain('href="https://epplaa.com/account/security"');
    // CTA label defaults to "Open Epplaa" — adapters override it for
    // security-page CTAs, but the template itself must NOT presume
    // any context. The MFA-specific label is set by the adapters
    // (postmark.ts / sendgrid.ts).
    expect(out.html).toContain("Open Epplaa");
  });

  it("renders the operator-supplied CTA label when provided", () => {
    const out = renderEpplaaEmail({
      title: "t",
      body: "b",
      ctaUrl: "/account/security",
      ctaLabel: "Manage backup codes",
      linkBaseUrl: "https://epplaa.com",
    });
    expect(out.html).toContain("Manage backup codes");
  });

  it("does not render a CTA when ctaUrl is null/empty", () => {
    const out = renderEpplaaEmail({
      title: "t",
      body: "b",
      ctaUrl: null,
      linkBaseUrl: "https://epplaa.com",
    });
    // No anchor that links to the placeholder fallback.
    expect(out.html).not.toMatch(/<a[^>]*href=/);
    expect(out.text).not.toContain("Open Epplaa:");
  });

  it("escapes HTML-special characters in title, body, and CTA label", () => {
    const out = renderEpplaaEmail({
      title: 'Hello <script>alert("xss")</script>',
      body: "Body & \"quotes\" 'single'",
      ctaUrl: "/account/security",
      ctaLabel: "<b>Click</b>",
      linkBaseUrl: "https://epplaa.com",
    });
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&lt;script&gt;");
    expect(out.html).toContain("Body &amp; &quot;quotes&quot; &#39;single&#39;");
    expect(out.html).toContain("&lt;b&gt;Click&lt;/b&gt;");
  });

  it("escapes HTML-special characters in the resolved CTA href to prevent attribute breakout", () => {
    // The path portion is user-controlled in the abstract sense
    // (future event types may compose URLs from payload data); the
    // template MUST escape the href value so a payload that contains
    // a quote cannot break out of the attribute.
    const out = renderEpplaaEmail({
      title: "t",
      body: "b",
      ctaUrl: '/account/security?next="evil',
      linkBaseUrl: "https://epplaa.com",
    });
    expect(out.html).not.toContain('next="evil');
    expect(out.html).toContain("next=&quot;evil");
  });

  it("includes a plain-text fallback that mirrors the html (subject, body, CTA, footer)", () => {
    const out = renderEpplaaEmail({
      title: "Title here",
      body: "Body here",
      ctaUrl: "/account/security",
      ctaLabel: "Manage backup codes",
      linkBaseUrl: "https://epplaa.com",
    });
    expect(out.text).toContain("Epplaa");
    expect(out.text).toContain("Title here");
    expect(out.text).toContain("Body here");
    expect(out.text).toContain("Manage backup codes: https://epplaa.com/account/security");
    expect(out.text).toContain("you can safely ignore it.");
  });

  it("strips a trailing slash on the link base before joining the path", () => {
    const out = renderEpplaaEmail({
      title: "t",
      body: "b",
      ctaUrl: "/account/security",
      linkBaseUrl: "https://epplaa.com/",
    });
    expect(out.html).toContain('href="https://epplaa.com/account/security"');
  });

  it("includes the security footer copy on every render", () => {
    const out = renderEpplaaEmail({
      title: "t",
      body: "b",
      linkBaseUrl: "https://epplaa.com",
    });
    expect(out.html).toContain("you can safely ignore it.");
    expect(out.html).toContain("&copy; Epplaa");
  });

  // ---------- security variant ----------
  // The security variant is shared by `mfa_activated` and
  // `mfa_backup_codes_regenerated`. These tests pin the contract that
  // (a) the alert ribbon, meta-table, signature, and support contact
  // are all present when requested, (b) blank meta-line values are
  // dropped (so we never render "IP: unknown"), and (c) recipient-
  // controlled meta-line content is escaped.
  describe("variant: security", () => {
    it("renders the Security alert ribbon and amber accent strip", () => {
      const out = renderEpplaaEmail({
        title: "Two-factor sign-in is now on for your account",
        body: "You've enabled an authenticator app.",
        ctaUrl: "/account/security",
        linkBaseUrl: "https://epplaa.com",
        variant: "security",
        signature: "— The Epplaa Security Team",
        supportEmail: "support@epplaa.com",
      });
      expect(out.html).toContain("Security alert");
      expect(out.html).toContain("background-color:#fff4e0");
      expect(out.text).toContain("[ SECURITY ALERT ]");
    });

    it("renders the security-team signature beneath the CTA", () => {
      const out = renderEpplaaEmail({
        title: "Your MFA backup codes were regenerated",
        body: "A fresh set of backup codes was generated.",
        ctaUrl: "/account/security",
        linkBaseUrl: "https://epplaa.com",
        variant: "security",
        signature: "— The Epplaa Security Team",
      });
      expect(out.html).toContain("— The Epplaa Security Team");
      expect(out.text).toContain("— The Epplaa Security Team");
    });

    it("renders the Need help? support contact line in the footer", () => {
      const out = renderEpplaaEmail({
        title: "t",
        body: "b",
        linkBaseUrl: "https://epplaa.com",
        variant: "security",
        supportEmail: "support@epplaa.com",
      });
      expect(out.html).toContain('href="mailto:support@epplaa.com"');
      expect(out.html).toContain("Need help? Contact");
      expect(out.text).toContain("Need help? Contact support@epplaa.com.");
    });

    it("omits the support line when the address is malformed (fail-closed)", () => {
      const out = renderEpplaaEmail({
        title: "t",
        body: "b",
        linkBaseUrl: "https://epplaa.com",
        variant: "security",
        supportEmail: "not-an-email",
      });
      expect(out.html).not.toContain("Need help? Contact");
      expect(out.html).not.toContain("mailto:not-an-email");
    });

    it("renders meta lines as a key/value table and mirrors them in the text part", () => {
      const out = renderEpplaaEmail({
        title: "Your MFA backup codes were regenerated",
        body: "A fresh set of backup codes was generated.",
        ctaUrl: "/account/security",
        linkBaseUrl: "https://epplaa.com",
        variant: "security",
        metaLines: [
          { label: "When", value: "2026-04-29 14:32:10 UTC" },
          { label: "IP", value: "203.0.113.10" },
          { label: "Device", value: "Mozilla/5.0 (Macintosh)" },
        ],
      });
      expect(out.html).toMatch(/>\s*When\s*<\/td>/);
      expect(out.html).toContain("2026-04-29 14:32:10 UTC");
      expect(out.html).toContain("203.0.113.10");
      expect(out.html).toContain("Mozilla/5.0 (Macintosh)");
      expect(out.text).toContain("When: 2026-04-29 14:32:10 UTC");
      expect(out.text).toContain("IP: 203.0.113.10");
      expect(out.text).toContain("Device: Mozilla/5.0 (Macintosh)");
    });

    it("drops meta lines whose value is empty/whitespace (no 'unknown' leaks)", () => {
      const out = renderEpplaaEmail({
        title: "t",
        body: "b",
        linkBaseUrl: "https://epplaa.com",
        variant: "security",
        metaLines: [
          { label: "When", value: "2026-04-29 14:32:10 UTC" },
          { label: "IP", value: "" },
          { label: "Device", value: "   " },
        ],
      });
      expect(out.html).toContain("2026-04-29 14:32:10 UTC");
      expect(out.html).not.toMatch(/>\s*IP\s*</);
      expect(out.html).not.toMatch(/>\s*Device\s*</);
      expect(out.text).not.toContain("IP:");
      expect(out.text).not.toContain("Device:");
    });

    it("escapes meta-line label/value content (HTML injection through user-agent string)", () => {
      const out = renderEpplaaEmail({
        title: "t",
        body: "b",
        linkBaseUrl: "https://epplaa.com",
        variant: "security",
        metaLines: [
          { label: "Device", value: '<img src=x onerror="alert(1)">' },
        ],
      });
      expect(out.html).not.toContain('<img src=x');
      expect(out.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    });

    it("default variant ignores supportEmail / signature / metaLines (back-compat)", () => {
      // The nudge email (`mfa_backup_codes_low`) renders the default
      // variant. Even if some future caller passes security fields by
      // mistake, the default chrome must not silently start showing
      // them — that would change a contract the existing snapshot
      // tests pin.
      const out = renderEpplaaEmail({
        title: "Your MFA backup codes are running low",
        body: "You have 2 backup codes left.",
        ctaUrl: "/account/security",
        linkBaseUrl: "https://epplaa.com",
        // intentionally NOT setting variant — defaults to "default"
        signature: "should be ignored",
        supportEmail: "support@epplaa.com",
        metaLines: [{ label: "IP", value: "1.2.3.4" }],
      });
      expect(out.html).not.toContain("Security alert");
      expect(out.html).not.toContain("should be ignored");
      expect(out.html).not.toContain("Need help? Contact");
      expect(out.html).not.toContain("1.2.3.4");
    });
  });
});

describe("resolveCtaUrl — link base resolution + scheme allowlist", () => {
  it("joins a relative path onto the base URL", () => {
    expect(resolveCtaUrl("/account/security", "https://epplaa.com")).toBe(
      "https://epplaa.com/account/security",
    );
  });

  it("treats a path without a leading slash as absolute-from-root", () => {
    expect(resolveCtaUrl("account/security", "https://epplaa.com")).toBe(
      "https://epplaa.com/account/security",
    );
  });

  it("passes through an absolute https:// URL unchanged", () => {
    expect(resolveCtaUrl("https://other.example/path", "https://epplaa.com")).toBe(
      "https://other.example/path",
    );
  });

  it("passes through a mailto: URL unchanged", () => {
    expect(resolveCtaUrl("mailto:trust@epplaa.com", "https://epplaa.com")).toBe(
      "mailto:trust@epplaa.com",
    );
  });

  it("refuses non-http(s)/mailto schemes (no javascript: smuggling)", () => {
    expect(resolveCtaUrl("javascript:alert(1)", "https://epplaa.com")).toBeNull();
    expect(resolveCtaUrl("data:text/html,<script>", "https://epplaa.com")).toBeNull();
    expect(resolveCtaUrl("file:///etc/passwd", "https://epplaa.com")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(resolveCtaUrl("", "https://epplaa.com")).toBeNull();
    expect(resolveCtaUrl("   ", "https://epplaa.com")).toBeNull();
  });
});
