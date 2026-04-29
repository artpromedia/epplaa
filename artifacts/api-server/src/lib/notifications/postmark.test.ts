import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PostmarkEmailChannel } from "./postmark";

/**
 * Postmark adapter unit tests. We mock global `fetch` so the test
 * stays hermetic — these are the contract guarantees that protect
 * the outbox from re-introducing the no-op stub regression (task
 * #72): the adapter must (1) treat a missing token as NOT configured,
 * (2) fail on a non-2xx with an error code so the FailoverChannel
 * rolls over, and (3) post the branded HTML + text body the renderer
 * produces.
 */
describe("PostmarkEmailChannel", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    delete process.env.POSTMARK_API_TOKEN;
    delete process.env.EMAIL_FROM;
    delete process.env.EMAIL_REPLY_TO;
    delete process.env.EMAIL_LINK_BASE_URL;
    delete process.env.EMAIL_SUPPORT_ADDRESS;
    delete process.env.POSTMARK_MESSAGE_STREAM;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("isConfigured() is false when POSTMARK_API_TOKEN is unset", () => {
    expect(new PostmarkEmailChannel().isConfigured()).toBe(false);
  });

  it("isConfigured() is true when POSTMARK_API_TOKEN is set (EMAIL_FROM defaulted)", () => {
    process.env.POSTMARK_API_TOKEN = "pm-token";
    expect(new PostmarkEmailChannel().isConfigured()).toBe(true);
  });

  it("send() returns ok:false (not_configured) when called without a token", async () => {
    const ch = new PostmarkEmailChannel();
    const r = await ch.send({ to: "buyer@example.com", title: "t", body: "b" });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("not_configured");
  });

  it("send() POSTs the branded template to Postmark with token + From + Subject + bodies", async () => {
    process.env.POSTMARK_API_TOKEN = "pm-token";
    process.env.EMAIL_LINK_BASE_URL = "https://epplaa.com";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ MessageID: "abc-123", ErrorCode: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const ch = new PostmarkEmailChannel();
    const r = await ch.send({
      to: "buyer@example.com",
      title: "Your MFA backup codes are running low",
      body: "You have 2 backup codes left.",
      url: "/account/security",
    });
    expect(r.ok).toBe(true);
    expect(r.providerMessageId).toBe("abc-123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.postmarkapp.com/email");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["X-Postmark-Server-Token"]).toBe("pm-token");
    const body = JSON.parse(String(init?.body ?? "{}"));
    expect(body.From).toBe("Epplaa <noreply@epplaa.com>");
    expect(body.To).toBe("buyer@example.com");
    expect(body.Subject).toBe("Your MFA backup codes are running low");
    expect(body.MessageStream).toBe("outbound");
    // The template renders the absolute CTA URL in the HTML body and
    // the MFA-specific label on the button.
    expect(body.HtmlBody).toContain("https://epplaa.com/account/security");
    expect(body.HtmlBody).toContain("Manage backup codes");
    // Plain-text fallback included for deliverability.
    expect(body.TextBody).toContain("Your MFA backup codes are running low");
    expect(body.TextBody).toContain("You have 2 backup codes left.");
  });

  it("send() returns ok:false with the Postmark ErrorCode when the API rejects the request", async () => {
    process.env.POSTMARK_API_TOKEN = "pm-token";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ ErrorCode: 406, Message: "You tried to send to a recipient that has been marked as inactive." }),
        { status: 422, headers: { "content-type": "application/json" } },
      ),
    );
    const r = await new PostmarkEmailChannel().send({
      to: "buyer@example.com",
      title: "t",
      body: "b",
    });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("406");
    expect(r.errorMessage).toMatch(/inactive/);
  });

  it("send() returns ok:false (exception) when fetch throws — failover chain takes over", async () => {
    process.env.POSTMARK_API_TOKEN = "pm-token";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));
    const r = await new PostmarkEmailChannel().send({
      to: "buyer@example.com",
      title: "t",
      body: "b",
    });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("exception");
    expect(r.errorMessage).toBe("ECONNRESET");
  });

  it("send() renders mfa_activated with the security variant (ribbon, signature, support contact, security CTA)", async () => {
    process.env.POSTMARK_API_TOKEN = "pm-token";
    process.env.EMAIL_LINK_BASE_URL = "https://epplaa.com";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ MessageID: "abc-1", ErrorCode: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const r = await new PostmarkEmailChannel().send({
      to: "buyer@example.com",
      title: "Two-factor sign-in is now on for your account",
      body: "You've enabled an authenticator app for two-factor sign-in.",
      url: "/account/security",
      eventType: "mfa_activated",
    });
    expect(r.ok).toBe(true);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body ?? "{}"));
    // Branded security chrome.
    expect(body.HtmlBody).toContain("Security alert");
    expect(body.HtmlBody).toContain("— The Epplaa Security Team");
    // Default support address rendered as a mailto: in the footer.
    expect(body.HtmlBody).toContain('href="mailto:support@epplaa.com"');
    // Security-specific CTA label (NOT the nudge's "Manage backup codes").
    expect(body.HtmlBody).toContain("Review your security settings");
    expect(body.HtmlBody).not.toContain("Manage backup codes");
    expect(body.HtmlBody).toContain("https://epplaa.com/account/security");
    // Plain-text fallback mirrors the security framing.
    expect(body.TextBody).toContain("[ SECURITY ALERT ]");
    expect(body.TextBody).toContain("— The Epplaa Security Team");
    expect(body.TextBody).toContain(
      "Review your security settings: https://epplaa.com/account/security",
    );
    expect(body.TextBody).toContain("Need help? Contact support@epplaa.com.");
  });

  it("send() renders mfa_backup_codes_regenerated with the When/IP/Device meta-table", async () => {
    process.env.POSTMARK_API_TOKEN = "pm-token";
    process.env.EMAIL_LINK_BASE_URL = "https://epplaa.com";
    process.env.EMAIL_SUPPORT_ADDRESS = "security@epplaa.com";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ MessageID: "abc-2", ErrorCode: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const r = await new PostmarkEmailChannel().send({
      to: "buyer@example.com",
      title: "Your MFA backup codes were regenerated",
      body: "A fresh set of two-factor backup codes was just generated for your account.",
      url: "/account/security",
      eventType: "mfa_backup_codes_regenerated",
      payload: {
        ipAddress: "203.0.113.10",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
        occurredAt: "2026-04-29T14:32:10.000Z",
      },
    });
    expect(r.ok).toBe(true);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body ?? "{}"));
    // Forensic context surfaced via the meta-table.
    expect(body.HtmlBody).toContain("2026-04-29 14:32:10 UTC");
    expect(body.HtmlBody).toContain("203.0.113.10");
    expect(body.HtmlBody).toContain("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)");
    // Operator-overridden support address makes it through to the footer.
    expect(body.HtmlBody).toContain('href="mailto:security@epplaa.com"');
    // Plain-text fallback carries the same meta lines.
    expect(body.TextBody).toContain("When: 2026-04-29 14:32:10 UTC");
    expect(body.TextBody).toContain("IP: 203.0.113.10");
    expect(body.TextBody).toContain("Device: Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)");
  });

  it("send() leaves the mfa_backup_codes_low nudge on the default template (no Security alert ribbon)", async () => {
    // Regression guard: only `mfa_activated` and
    // `mfa_backup_codes_regenerated` opt into the security variant.
    // The low-codes nudge MUST stay on the original transactional
    // shell with the "Manage backup codes" CTA.
    process.env.POSTMARK_API_TOKEN = "pm-token";
    process.env.EMAIL_LINK_BASE_URL = "https://epplaa.com";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ MessageID: "abc-3", ErrorCode: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await new PostmarkEmailChannel().send({
      to: "buyer@example.com",
      title: "Your MFA backup codes are running low",
      body: "You have 2 backup codes left.",
      url: "/account/security",
      eventType: "mfa_backup_codes_low",
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body ?? "{}"));
    expect(body.HtmlBody).not.toContain("Security alert");
    expect(body.HtmlBody).not.toContain("— The Epplaa Security Team");
    expect(body.HtmlBody).toContain("Manage backup codes");
  });

  it("send() respects EMAIL_FROM and EMAIL_REPLY_TO overrides", async () => {
    process.env.POSTMARK_API_TOKEN = "pm-token";
    process.env.EMAIL_FROM = "Epplaa Security <security@epplaa.com>";
    process.env.EMAIL_REPLY_TO = "support@epplaa.com";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ MessageID: "x", ErrorCode: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await new PostmarkEmailChannel().send({
      to: "buyer@example.com",
      title: "t",
      body: "b",
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body ?? "{}"));
    expect(body.From).toBe("Epplaa Security <security@epplaa.com>");
    expect(body.ReplyTo).toBe("support@epplaa.com");
  });
});
