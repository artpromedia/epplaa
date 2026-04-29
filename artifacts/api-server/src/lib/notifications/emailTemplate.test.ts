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
