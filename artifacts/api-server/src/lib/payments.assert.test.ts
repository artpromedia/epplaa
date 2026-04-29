import { describe, it, expect } from "vitest";
import { assertPaymentProviderConfiguredForProduction } from "./payments";

describe("assertPaymentProviderConfiguredForProduction — production payment gateway presence check", () => {
  // Without PAYSTACK_SECRET_KEY or FLUTTERWAVE_SECRET_KEY,
  // lib/payments.ts falls back to DevMockGateway and buyers cannot
  // actually pay (the checkout returns ok but no real authorization).
  // Also: a Flutterwave-only deploy without FLUTTERWAVE_WEBHOOK_HASH
  // can accept charges but cannot verify webhooks (silent settlement
  // loss).

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
    const result = assertPaymentProviderConfiguredForProduction(
      { NODE_ENV: "staging" },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("WARNS when production-shape detected and NEITHER gateway secret is set", () => {
    const log = buildWarnSink();
    const result = assertPaymentProviderConfiguredForProduction(
      { NODE_ENV: "production" },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/PAYSTACK_SECRET_KEY/);
    expect(result.reason).toMatch(/FLUTTERWAVE_SECRET_KEY/);
    expect(result.reason).toMatch(/DevMockGateway/);
    expect(log.calls).toHaveLength(1);
    const [obj, msg] = log.calls[0]!;
    expect(obj).toMatchObject({
      missing: ["PAYSTACK_SECRET_KEY", "FLUTTERWAVE_SECRET_KEY"],
      paystack_secret_key: null,
      flutterwave_secret_key: null,
    });
    expect(msg).toMatch(/payment_provider_missing_for_production/);
  });

  it("WARNS when only FLUTTERWAVE_SECRET_KEY is set without FLUTTERWAVE_WEBHOOK_HASH", () => {
    const log = buildWarnSink();
    const result = assertPaymentProviderConfiguredForProduction(
      {
        NODE_ENV: "production",
        FLUTTERWAVE_SECRET_KEY: "FLWSECK_TEST-xxx",
      },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/FLUTTERWAVE_WEBHOOK_HASH/);
    const [obj] = log.calls[0]!;
    expect(obj).toMatchObject({
      missing: ["FLUTTERWAVE_WEBHOOK_HASH"],
      flutterwave_secret_key: "[set]",
      flutterwave_webhook_hash: null,
    });
  });

  it("does NOT warn when PAYSTACK_SECRET_KEY alone is configured (Paystack covers webhooks separately)", () => {
    const log = buildWarnSink();
    const result = assertPaymentProviderConfiguredForProduction(
      { NODE_ENV: "production", PAYSTACK_SECRET_KEY: "sk_live_xxx" },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("does NOT warn when both Paystack and Flutterwave (with webhook hash) are configured", () => {
    const log = buildWarnSink();
    const result = assertPaymentProviderConfiguredForProduction(
      {
        NODE_ENV: "production",
        PAYSTACK_SECRET_KEY: "sk_live_xxx",
        FLUTTERWAVE_SECRET_KEY: "FLWSECK-xxx",
        FLUTTERWAVE_WEBHOOK_HASH: "hashvalue",
      },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("does NOT warn when Flutterwave-only with webhook hash IS set", () => {
    const log = buildWarnSink();
    const result = assertPaymentProviderConfiguredForProduction(
      {
        NODE_ENV: "production",
        FLUTTERWAVE_SECRET_KEY: "FLWSECK-xxx",
        FLUTTERWAVE_WEBHOOK_HASH: "hashvalue",
      },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("does NOT echo secret values on warn", () => {
    const log = buildWarnSink();
    const sentinelPaystack = "sk_live_SECRETxxxxxxxxxxxxxxxx";
    const sentinelFlw = "FLWSECK-SECRETxxxxxxxxxxxxxxxx";
    const sentinelHash = "hash_SECRETxxxxxxxxxxxxxxxx";
    const result = assertPaymentProviderConfiguredForProduction(
      {
        NODE_ENV: "production",
        FLUTTERWAVE_SECRET_KEY: sentinelFlw,
      },
      log,
    );
    expect(result.ok).toBe(false);
    const serialized = JSON.stringify(log.calls[0]);
    expect(serialized).not.toContain(sentinelPaystack);
    expect(serialized).not.toContain(sentinelFlw);
    expect(serialized).not.toContain(sentinelHash);
  });
});
