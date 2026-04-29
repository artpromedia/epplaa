import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SendGridEmailChannel } from "./sendgrid";

/**
 * SendGrid is the failover provider behind Postmark. Same contract
 * tests as PostmarkEmailChannel: not_configured when no key set,
 * a real POST to v3/mail/send when configured, and a clean ok:false
 * with an error code on a non-2xx so the FailoverChannel falls
 * through cleanly.
 */
describe("SendGridEmailChannel", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    delete process.env.SENDGRID_API_KEY;
    delete process.env.EMAIL_FROM;
    delete process.env.EMAIL_REPLY_TO;
    delete process.env.EMAIL_LINK_BASE_URL;
    delete process.env.EMAIL_SUPPORT_ADDRESS;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("isConfigured() is false when SENDGRID_API_KEY is unset", () => {
    expect(new SendGridEmailChannel().isConfigured()).toBe(false);
  });

  it("isConfigured() is true when SENDGRID_API_KEY is set", () => {
    process.env.SENDGRID_API_KEY = "SG.xxx";
    expect(new SendGridEmailChannel().isConfigured()).toBe(true);
  });

  it("send() returns ok:false (not_configured) when called without a key", async () => {
    const r = await new SendGridEmailChannel().send({
      to: "buyer@example.com",
      title: "t",
      body: "b",
    });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("not_configured");
  });

  it("send() POSTs the v3 envelope with bearer token, parsed From mailbox, and both content parts", async () => {
    process.env.SENDGRID_API_KEY = "SG.test-key";
    process.env.EMAIL_LINK_BASE_URL = "https://epplaa.com";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", {
        status: 202,
        headers: { "x-message-id": "sg-msg-1" },
      }),
    );
    const r = await new SendGridEmailChannel().send({
      to: "buyer@example.com",
      title: "Your MFA backup codes are running low",
      body: "You have 2 backup codes left.",
      url: "/account/security",
    });
    expect(r.ok).toBe(true);
    expect(r.providerMessageId).toBe("sg-msg-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.sendgrid.com/v3/mail/send");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe("Bearer SG.test-key");
    const body = JSON.parse(String(init?.body ?? "{}"));
    expect(body.personalizations[0].to[0].email).toBe("buyer@example.com");
    expect(body.personalizations[0].subject).toBe(
      "Your MFA backup codes are running low",
    );
    expect(body.from).toEqual({ name: "Epplaa", email: "noreply@epplaa.com" });
    // Plain text BEFORE html — SendGrid requires content parts in
    // ascending MIME-richness order (RFC 2046).
    expect(body.content[0].type).toBe("text/plain");
    expect(body.content[1].type).toBe("text/html");
    expect(body.content[1].value).toContain("https://epplaa.com/account/security");
    expect(body.content[1].value).toContain("Manage backup codes");
  });

  it("send() renders mfa_activated with the security variant (alert ribbon, signature, support contact)", async () => {
    process.env.SENDGRID_API_KEY = "SG.test-key";
    process.env.EMAIL_LINK_BASE_URL = "https://epplaa.com";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 202, headers: { "x-message-id": "sg-sec-1" } }),
    );
    const r = await new SendGridEmailChannel().send({
      to: "buyer@example.com",
      title: "Two-factor sign-in is now on for your account",
      body: "You've enabled an authenticator app for two-factor sign-in.",
      url: "/account/security",
      eventType: "mfa_activated",
    });
    expect(r.ok).toBe(true);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body ?? "{}"));
    const html = body.content[1].value as string;
    const text = body.content[0].value as string;
    expect(html).toContain("Security alert");
    expect(html).toContain("— The Epplaa Security Team");
    expect(html).toContain('href="mailto:support@epplaa.com"');
    expect(html).toContain("Review your security settings");
    expect(html).not.toContain("Manage backup codes");
    expect(text).toContain("[ SECURITY ALERT ]");
    expect(text).toContain("— The Epplaa Security Team");
  });

  it("send() renders mfa_backup_codes_regenerated with the When/IP/Device meta-table", async () => {
    process.env.SENDGRID_API_KEY = "SG.test-key";
    process.env.EMAIL_LINK_BASE_URL = "https://epplaa.com";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 202, headers: { "x-message-id": "sg-sec-2" } }),
    );
    const r = await new SendGridEmailChannel().send({
      to: "buyer@example.com",
      title: "Your MFA backup codes were regenerated",
      body: "A fresh set of two-factor backup codes was just generated for your account.",
      url: "/account/security",
      eventType: "mfa_backup_codes_regenerated",
      payload: {
        ipAddress: "203.0.113.10",
        userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
        occurredAt: "2026-04-29T14:32:10.000Z",
      },
    });
    expect(r.ok).toBe(true);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body ?? "{}"));
    const html = body.content[1].value as string;
    const text = body.content[0].value as string;
    expect(html).toContain("2026-04-29 14:32:10 UTC");
    expect(html).toContain("203.0.113.10");
    expect(html).toContain("Mozilla/5.0 (X11; Linux x86_64)");
    expect(text).toContain("When: 2026-04-29 14:32:10 UTC");
    expect(text).toContain("IP: 203.0.113.10");
    expect(text).toContain("Device: Mozilla/5.0 (X11; Linux x86_64)");
  });

  it("send() returns ok:false with the SendGrid status + first error message on non-2xx", async () => {
    process.env.SENDGRID_API_KEY = "SG.test-key";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ errors: [{ message: "The from address does not match a verified Sender Identity." }] }),
        { status: 403, headers: { "content-type": "application/json" } },
      ),
    );
    const r = await new SendGridEmailChannel().send({
      to: "buyer@example.com",
      title: "t",
      body: "b",
    });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("403");
    expect(r.errorMessage).toMatch(/Sender Identity/);
  });

  it("send() returns ok:false (exception) when fetch throws", async () => {
    process.env.SENDGRID_API_KEY = "SG.test-key";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ETIMEDOUT"));
    const r = await new SendGridEmailChannel().send({
      to: "buyer@example.com",
      title: "t",
      body: "b",
    });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("exception");
    expect(r.errorMessage).toBe("ETIMEDOUT");
  });

  it("send() fails closed (bad_from) when EMAIL_FROM cannot be parsed", async () => {
    process.env.SENDGRID_API_KEY = "SG.test-key";
    process.env.EMAIL_FROM = "not-an-email";
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const r = await new SendGridEmailChannel().send({
      to: "buyer@example.com",
      title: "t",
      body: "b",
    });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("bad_from");
    // Most importantly: no network call was made — the adapter
    // refused to send a message under a malformed From identity.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("send() accepts a bare-email EMAIL_FROM without a display name", async () => {
    process.env.SENDGRID_API_KEY = "SG.test-key";
    process.env.EMAIL_FROM = "noreply@epplaa.com";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 202, headers: { "x-message-id": "sg-2" } }),
    );
    const r = await new SendGridEmailChannel().send({
      to: "buyer@example.com",
      title: "t",
      body: "b",
    });
    expect(r.ok).toBe(true);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body ?? "{}"));
    expect(body.from).toEqual({ email: "noreply@epplaa.com" });
  });
});
