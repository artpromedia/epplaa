import { describe, it, expect } from "vitest";
import { assertCloudflareStreamWebhookConfiguredForProduction } from "./streaming";

describe("assertCloudflareStreamWebhookConfiguredForProduction — production CF Stream webhook secret presence check", () => {
  // Without CF_STREAM_WEBHOOK_SECRET on a CF-enabled production deploy
  // the inbound webhook handler refuses every request with 503 and
  // Cloudflare's "video ready" notifications are dropped silently —
  // replays never get persisted from real broadcasts. The boot-time
  // warn moves the misconfiguration ahead of the first stream.

  type WarnCall = [obj: unknown, msg: string];
  function buildWarnSink(): {
    warn: (obj: unknown, msg: string) => void;
    calls: WarnCall[];
  } {
    const calls: WarnCall[] = [];
    return { warn: (obj, msg) => calls.push([obj, msg]), calls };
  }

  it("does nothing on a non-production deploy (staging) even without any CF env vars", () => {
    const log = buildWarnSink();
    const result = assertCloudflareStreamWebhookConfiguredForProduction(
      { NODE_ENV: "staging" },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("does nothing on a production deploy that hasn't enabled the CF provider yet (stub mode is intentional)", () => {
    // CF_STREAM_API_TOKEN + CF_STREAM_ACCOUNT_ID both missing — the
    // streaming provider is in stub mode, no webhook handler can fire.
    // Warning here would be noise.
    const log = buildWarnSink();
    const result = assertCloudflareStreamWebhookConfiguredForProduction(
      { NODE_ENV: "production" },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("does nothing on a production deploy that has CF provider AND webhook secret configured", () => {
    const log = buildWarnSink();
    const result = assertCloudflareStreamWebhookConfiguredForProduction(
      {
        NODE_ENV: "production",
        CF_STREAM_API_TOKEN: "tok-xxx",
        CF_STREAM_ACCOUNT_ID: "acct-xxx",
        CF_STREAM_WEBHOOK_SECRET: "shared-secret",
      },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("WARNS when production-shape detected and CF provider is enabled but webhook secret is missing", () => {
    const log = buildWarnSink();
    const result = assertCloudflareStreamWebhookConfiguredForProduction(
      {
        NODE_ENV: "production",
        CF_STREAM_API_TOKEN: "tok-xxx",
        CF_STREAM_ACCOUNT_ID: "acct-xxx",
      },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/CF_STREAM_WEBHOOK_SECRET/);
    expect(result.reason).toMatch(/replays never get persisted/);
    expect(log.calls).toHaveLength(1);
    const [obj, msg] = log.calls[0]!;
    expect(obj).toMatchObject({
      cf_stream_api_token: "[set]",
      cf_stream_account_id: "[set]",
      cf_stream_webhook_secret: null,
    });
    expect(msg).toMatch(/cf_stream_webhook_secret_missing_for_production/);
  });

  it("treats whitespace-only env values as unset (defensive trim)", () => {
    const log = buildWarnSink();
    const result = assertCloudflareStreamWebhookConfiguredForProduction(
      {
        NODE_ENV: "production",
        CF_STREAM_API_TOKEN: "tok-xxx",
        CF_STREAM_ACCOUNT_ID: "acct-xxx",
        CF_STREAM_WEBHOOK_SECRET: "   ",
      },
      log,
    );
    expect(result.ok).toBe(false);
    expect(log.calls).toHaveLength(1);
  });

  it("never logs the secret value itself even when it IS set", () => {
    const log = buildWarnSink();
    assertCloudflareStreamWebhookConfiguredForProduction(
      {
        NODE_ENV: "production",
        CF_STREAM_API_TOKEN: "tok-xxx",
        CF_STREAM_ACCOUNT_ID: "acct-xxx",
        CF_STREAM_WEBHOOK_SECRET: "real-secret-do-not-leak",
      },
      log,
    );
    // Configured path returns silently — test that we wouldn't have
    // logged the secret if anything had been logged.
    expect(log.calls).toEqual([]);
  });

  it("triggers under any production signal (REPLIT_DEPLOYMENT or DEPLOYMENT_ENVIRONMENT, not just NODE_ENV)", () => {
    const replitLog = buildWarnSink();
    expect(
      assertCloudflareStreamWebhookConfiguredForProduction(
        {
          REPLIT_DEPLOYMENT: "1",
          CF_STREAM_API_TOKEN: "tok-xxx",
          CF_STREAM_ACCOUNT_ID: "acct-xxx",
        },
        replitLog,
      ).ok,
    ).toBe(false);
    expect(replitLog.calls).toHaveLength(1);

    const depEnvLog = buildWarnSink();
    expect(
      assertCloudflareStreamWebhookConfiguredForProduction(
        {
          DEPLOYMENT_ENVIRONMENT: "production",
          CF_STREAM_API_TOKEN: "tok-xxx",
          CF_STREAM_ACCOUNT_ID: "acct-xxx",
        },
        depEnvLog,
      ).ok,
    ).toBe(false);
    expect(depEnvLog.calls).toHaveLength(1);
  });
});
