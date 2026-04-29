import { describe, it, expect } from "vitest";
import { assertShipbubbleConfiguredForProduction } from "./shipbubble";

describe("assertShipbubbleConfiguredForProduction — production Shipbubble credential presence check", () => {
  // Without SHIPBUBBLE_API_KEY the carrier returns deterministic
  // stub rates and orders ship under fake tracking numbers; without
  // SHIPBUBBLE_SENDER_CODE real dispatches 4xx; without
  // SHIPBUBBLE_WEBHOOK_SECRET inbound tracking events fail signature
  // verification and are silently dropped.

  type WarnCall = [obj: unknown, msg: string];
  function buildWarnSink(): {
    warn: (obj: unknown, msg: string) => void;
    calls: WarnCall[];
  } {
    const calls: WarnCall[] = [];
    return { warn: (obj, msg) => calls.push([obj, msg]), calls };
  }

  it("does nothing on a non-production deploy (staging) with no creds set", () => {
    const log = buildWarnSink();
    const result = assertShipbubbleConfiguredForProduction(
      { NODE_ENV: "staging" },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("WARNS when production-shape detected and ALL three creds are missing", () => {
    const log = buildWarnSink();
    const result = assertShipbubbleConfiguredForProduction(
      { NODE_ENV: "production" },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/SHIPBUBBLE_API_KEY/);
    expect(result.reason).toMatch(/SHIPBUBBLE_SENDER_CODE/);
    expect(result.reason).toMatch(/SHIPBUBBLE_WEBHOOK_SECRET/);
    expect(log.calls).toHaveLength(1);
    const [obj, msg] = log.calls[0]!;
    expect(obj).toMatchObject({
      missing: [
        "SHIPBUBBLE_API_KEY",
        "SHIPBUBBLE_SENDER_CODE",
        "SHIPBUBBLE_WEBHOOK_SECRET",
      ],
    });
    expect(msg).toMatch(/shipbubble_credentials_missing_for_production/);
  });

  it("WARNS when only SHIPBUBBLE_API_KEY is set (sender code + webhook still missing)", () => {
    const log = buildWarnSink();
    const result = assertShipbubbleConfiguredForProduction(
      { NODE_ENV: "production", SHIPBUBBLE_API_KEY: "shp_xxx" },
      log,
    );
    expect(result.ok).toBe(false);
    const [obj] = log.calls[0]!;
    expect(obj).toMatchObject({
      missing: ["SHIPBUBBLE_SENDER_CODE", "SHIPBUBBLE_WEBHOOK_SECRET"],
      shipbubble_api_key: "[set]",
      shipbubble_sender_code: null,
      shipbubble_webhook_secret: null,
    });
  });

  it("WARNS when only SHIPBUBBLE_WEBHOOK_SECRET is missing (carrier works but webhooks unverified)", () => {
    const log = buildWarnSink();
    const result = assertShipbubbleConfiguredForProduction(
      {
        NODE_ENV: "production",
        SHIPBUBBLE_API_KEY: "shp_xxx",
        SHIPBUBBLE_SENDER_CODE: "snd_xxx",
      },
      log,
    );
    expect(result.ok).toBe(false);
    const [obj] = log.calls[0]!;
    expect(obj).toMatchObject({
      missing: ["SHIPBUBBLE_WEBHOOK_SECRET"],
    });
  });

  it("WARNS when REPLIT_DEPLOYMENT=1 alone triggers production-shape detection", () => {
    const log = buildWarnSink();
    const result = assertShipbubbleConfiguredForProduction(
      { REPLIT_DEPLOYMENT: "1" },
      log,
    );
    expect(result.ok).toBe(false);
    expect(log.calls).toHaveLength(1);
  });

  it("does NOT echo secret values on warn", () => {
    const log = buildWarnSink();
    const sentinelKey = "shp_SECRETxxxxxxxxxxxxxxxxxxxxxx";
    const sentinelSender = "snd_SECRETxxxxxxxxxxxxxxxxxxxxxx";
    const sentinelWebhook = "whk_SECRETxxxxxxxxxxxxxxxxxxxxxx";
    const result = assertShipbubbleConfiguredForProduction(
      {
        NODE_ENV: "production",
        SHIPBUBBLE_API_KEY: sentinelKey,
        SHIPBUBBLE_SENDER_CODE: sentinelSender,
        // webhook secret missing
      },
      log,
    );
    expect(result.ok).toBe(false);
    const serialized = JSON.stringify(log.calls[0]);
    expect(serialized).not.toContain(sentinelKey);
    expect(serialized).not.toContain(sentinelSender);
    expect(serialized).not.toContain(sentinelWebhook);
  });

  it("does NOT warn when all three creds are configured on a production deploy", () => {
    const log = buildWarnSink();
    const result = assertShipbubbleConfiguredForProduction(
      {
        NODE_ENV: "production",
        SHIPBUBBLE_API_KEY: "shp_xxx",
        SHIPBUBBLE_SENDER_CODE: "snd_xxx",
        SHIPBUBBLE_WEBHOOK_SECRET: "whk_xxx",
      },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });
});
