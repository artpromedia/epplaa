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
