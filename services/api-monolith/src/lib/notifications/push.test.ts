import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FcmChannel } from "./push";

/**
 * The FCM adapter must distinguish three states cleanly so the outbox
 * can do the right thing:
 *
 *   1. env unset           -> dev-mode success  (ok:true, fake message id)
 *   2. env set but bogus   -> hard failure      (ok:false, fcm_invalid_credentials)
 *   3. env set + valid     -> real send attempt (mocked here at the fetch boundary)
 *
 * Previously case (2) collapsed into case (1), so a misconfigured
 * production deploy would silently report 100% delivery while no push
 * ever left the server. These tests lock that regression down.
 */
describe("FcmChannel", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    delete process.env.FCM_SERVICE_ACCOUNT_JSON;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("send() returns ok:true (dev-mode) when FCM_SERVICE_ACCOUNT_JSON is unset", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await new FcmChannel().send({
      to: "device-token-1",
      title: "Order placed",
      body: "Your order #123 is confirmed.",
    });
    expect(r.ok).toBe(true);
    expect(r.providerMessageId).toMatch(/^fcm_dev_/);
    // No network traffic — confirms we did not try to talk to Google
    // when no credentials are configured.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("send() returns ok:false with fcm_invalid_credentials when the JSON is unparseable", async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = "not-valid-json-or-base64-of-json";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await new FcmChannel().send({
      to: "device-token-1",
      title: "t",
      body: "b",
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toBe("fcm_invalid_credentials");
    // Critical: the outbox relies on this failing closed so it can
    // reschedule with backoff. A network call here would mean we leaked
    // bad credentials to FCM (or worse, treated the row as delivered).
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("send() returns ok:false with fcm_invalid_credentials when required fields are missing", async () => {
    // Parses fine as JSON but is missing client_email / private_key /
    // project_id — exactly the shape we'd see if someone pasted the
    // wrong file (e.g. a Firebase web config instead of an Admin SDK
    // service account).
    process.env.FCM_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: "epplaa-prod" });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await new FcmChannel().send({
      to: "device-token-1",
      title: "t",
      body: "b",
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toBe("fcm_invalid_credentials");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("send() accepts base64-encoded service account JSON", async () => {
    // The deploy pipeline base64-encodes the SA JSON to dodge shell
    // escaping issues. Make sure that path still validates and reaches
    // the OAuth + send flow (mocked here so we don't actually hit the
    // network).
    const sa = {
      client_email: "fcm@epplaa-test.iam.gserviceaccount.com",
      // A throwaway PEM is enough — the OAuth token call is mocked
      // before we ever try to actually sign with it would be wrong, so
      // we mock fetch BEFORE constructing the channel.
      private_key:
        "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\nKUpRKfFLfRYC9AIKjbJTWit+CqvjWYzvQwECAwEAAQJAIJLixBy2qpFoS4DSmoEm\no3qGy0t6z09AIJtH+5OeRV1be+N4cDYJKffGzDa88vQENZiRm0GRq6a+HPGQMd2k\nTQIhAKMSvzIBnni7ot/OSie2TmJLY4SwTQAevXysE2RbFDYdAiEBCUEaRQnMnbp7\n9mxDXDf6AU0cN/RPBjb9qSHDcWZHGzUCIG2Es59z8ugGrDY+pxLQnwfotadxd+Uy\nv/Ow5T0q5gIJAiEAyS4RaI9YG8EWx/2w0T67ZUVAw8eOMB6BIUg0Xcu+3okCIBOs\n/5OiPgoTdSy7bcF9IGpSE8ZgGKzgYQVZeN97YE00\n-----END RSA PRIVATE KEY-----\n",
      project_id: "epplaa-test",
    };
    process.env.FCM_SERVICE_ACCOUNT_JSON = Buffer.from(JSON.stringify(sa)).toString("base64");

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      // 1) OAuth token exchange.
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      // 2) FCM send.
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ name: "projects/epplaa-test/messages/0:abc" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const r = await new FcmChannel().send({
      to: "device-token-1",
      title: "Order placed",
      body: "Your order #123 is confirmed.",
    });
    expect(r.ok).toBe(true);
    expect(r.providerMessageId).toBe("projects/epplaa-test/messages/0:abc");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [sendUrl] = fetchMock.mock.calls[1]!;
    expect(String(sendUrl)).toBe(
      "https://fcm.googleapis.com/v1/projects/epplaa-test/messages:send",
    );
  });
});
