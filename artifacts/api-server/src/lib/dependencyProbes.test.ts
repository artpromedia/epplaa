import { describe, it, expect, vi } from "vitest";
import {
  getDependencyProbeConfig,
  getDependencyProbeConfigBlock,
  pingDependency,
  pingHttpEndpoint,
} from "./dependencyProbes";

describe("getDependencyProbeConfig — env parsing", () => {
  // The route layer treats a `null` ping result as "skipped", which is
  // the entire wire contract for opt-in probes. These tests pin down
  // the strict-match-on-"1" semantics, the URL/timeout overrides, and
  // the malformed-input fallbacks so a future env-var schema drift
  // can't silently re-enable a probe an operator turned off during an
  // incident.

  it("defaults to disabled with the documented base URL and 2000ms timeout", () => {
    expect(getDependencyProbeConfig("clerk", {})).toEqual({
      enabled: false,
      url: "https://api.clerk.com",
      timeoutMs: 2000,
    });
    expect(getDependencyProbeConfig("paystack", {})).toEqual({
      enabled: false,
      url: "https://api.paystack.co",
      timeoutMs: 2000,
    });
    expect(getDependencyProbeConfig("flutterwave", {})).toEqual({
      enabled: false,
      url: "https://api.flutterwave.com",
      timeoutMs: 2000,
    });
  });

  it("enables ONLY on the literal '1' — strict match prevents accidental opt-in via casing drift", () => {
    // Same strictness as REPLIT_DEPLOYMENT=1 and
    // RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION=1 elsewhere in the
    // boot sequence. A typo'd value MUST keep the probe disabled —
    // the in-incident escape hatch in the runbook documents
    // `READYZ_PROBE_CLERK=0` to disable, so any non-"1" value
    // disables and that's the contract operators rely on.
    for (const v of ["true", "yes", "0", "01", " 1 ", "1 ", " 1", ""]) {
      expect(
        getDependencyProbeConfig("clerk", { READYZ_PROBE_CLERK: v }),
        `value=${JSON.stringify(v)}`,
      ).toMatchObject({ enabled: false });
    }
    expect(
      getDependencyProbeConfig("clerk", { READYZ_PROBE_CLERK: "1" }),
    ).toMatchObject({ enabled: true });
  });

  it("honours URL overrides and trims whitespace; a whitespace-only value falls back to the default", () => {
    expect(
      getDependencyProbeConfig("paystack", {
        READYZ_PROBE_PAYSTACK: "1",
        READYZ_PAYSTACK_URL: "https://eu.paystack.example/probe",
      }).url,
    ).toBe("https://eu.paystack.example/probe");
    expect(
      getDependencyProbeConfig("paystack", {
        READYZ_PROBE_PAYSTACK: "1",
        READYZ_PAYSTACK_URL: "   ",
      }).url,
    ).toBe("https://api.paystack.co");
  });

  it("sanitises malformed timeouts (NaN / zero / negative) and falls back to 2000ms", () => {
    // Without sanitisation, Number("not-a-number") -> NaN -> setTimeout
    // fires immediately on every probe and turns every readyz call
    // into a 503. Mirrors `parseTimeoutMs` in health.ts.
    for (const v of ["not-a-number", "0", "-5", "", "  "]) {
      expect(
        getDependencyProbeConfig("clerk", {
          READYZ_PROBE_CLERK: "1",
          READYZ_CLERK_TIMEOUT_MS: v,
        }).timeoutMs,
        `value=${JSON.stringify(v)}`,
      ).toBe(2000);
    }
    expect(
      getDependencyProbeConfig("clerk", {
        READYZ_PROBE_CLERK: "1",
        READYZ_CLERK_TIMEOUT_MS: "750",
      }).timeoutMs,
    ).toBe(750);
    expect(
      getDependencyProbeConfig("clerk", {
        READYZ_PROBE_CLERK: "1",
        READYZ_CLERK_TIMEOUT_MS: "1500.9",
      }).timeoutMs,
    ).toBe(1500);
  });

  it("getDependencyProbeConfigBlock returns all three probes under stable keys", () => {
    const block = getDependencyProbeConfigBlock({});
    expect(Object.keys(block).sort()).toEqual([
      "clerk",
      "flutterwave",
      "paystack",
    ]);
    expect(block.clerk.enabled).toBe(false);
    expect(block.paystack.enabled).toBe(false);
    expect(block.flutterwave.enabled).toBe(false);
  });
});

describe("pingHttpEndpoint — fetch outcome translation", () => {
  it("returns ok when fetch resolves with any HTTP status — 200, 401, 404 all count as 'reachable'", async () => {
    for (const status of [200, 301, 401, 404, 500]) {
      const fetchImpl = vi.fn(
        async () => new Response("", { status }),
      ) as unknown as typeof fetch;
      const r = await pingHttpEndpoint("https://example/x", 100, fetchImpl);
      expect(r, `status=${status}`).toEqual({ ok: true });
    }
  });

  it("returns failed with the underlying message when fetch throws (DNS / TCP refused)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND api.example.com");
    }) as unknown as typeof fetch;
    const r = await pingHttpEndpoint("https://example/x", 100, fetchImpl);
    expect(r).toEqual({ ok: false, error: expect.stringContaining("ENOTFOUND") });
  });

  it("translates an AbortError into the http_probe_timeout_after_<n>ms marker so log queries stay uniform with the redis probe", async () => {
    // Mirrors `redis_ping_timeout_after_<n>ms` in
    // pingRateLimitRedis. Aggregator queries on the marker prefix
    // `*_timeout_after_*ms` work uniformly across probe types.
    const fetchImpl = vi.fn(
      (_input: string | URL, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            (err as Error & { name: string }).name = "AbortError";
            reject(err);
          });
        }),
    ) as unknown as typeof fetch;
    const r = await pingHttpEndpoint("https://example/x", 25, fetchImpl);
    expect(r).toEqual({
      ok: false,
      error: "http_probe_timeout_after_25ms",
    });
  });

  it("uses GET, manual redirects, and no-store cache so a CDN can't mask an outage and a regional redirect is not silently followed", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("", { status: 200 }),
    ) as unknown as typeof fetch;
    await pingHttpEndpoint("https://example/x", 100, fetchImpl);
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(call?.[0]).toBe("https://example/x");
    expect(call?.[1]).toMatchObject({
      method: "GET",
      redirect: "manual",
      cache: "no-store",
    });
    // The signal must be wired through so AbortController can fire.
    expect(call?.[1]?.signal).toBeDefined();
  });
});

describe("pingDependency — opt-in gating", () => {
  it("returns null (route reports 'skipped') when the probe is disabled", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("", { status: 200 }),
    ) as unknown as typeof fetch;
    expect(await pingDependency("clerk", {}, fetchImpl)).toBeNull();
    // And does NOT make a network call — the gating is BEFORE the
    // fetch invocation, not after, so a disabled probe has zero
    // latency cost.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("issues a real HTTP probe when the env flag is set", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("", { status: 200 }),
    ) as unknown as typeof fetch;
    const r = await pingDependency(
      "paystack",
      {
        READYZ_PROBE_PAYSTACK: "1",
        READYZ_PAYSTACK_URL: "https://example/paystack-probe",
        READYZ_PAYSTACK_TIMEOUT_MS: "500",
      },
      fetchImpl,
    );
    expect(r).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://example/paystack-probe",
      expect.objectContaining({ method: "GET" }),
    );
  });
});
