import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../custom-fetch";
import {
  formatRetryAtClockTime,
  parseRateLimitedError,
} from "./use-rate-limited-error";

/**
 * Locks in the contract `parseRateLimitedError` exposes to every UI
 * caller (seller account-settings, admin MFA panel, future mobile MFA
 * flow). The MFA mutation routes return 429 + `{error:"rate_limited"}`
 * with a delta-seconds `Retry-After` header, and both web SPAs render a
 * friendly inline alert based on the parsed `retryAt` Date — see
 * `artifacts/api-server/src/middlewares/apiRateLimit.ts` for the server
 * contract these tests mirror.
 */

function rateLimitError(opts: {
  status?: number;
  body?: unknown;
  retryAfter?: string | null;
  errorCode?: string;
}): ApiError {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.retryAfter !== null && opts.retryAfter !== undefined) {
    headers.set("retry-after", opts.retryAfter);
  }
  const data =
    opts.body !== undefined
      ? opts.body
      : { error: opts.errorCode ?? "rate_limited", detail: "too many" };
  const response = new Response(typeof data === "string" ? data : JSON.stringify(data), {
    status: opts.status ?? 429,
    statusText: "Too Many Requests",
    headers,
  });
  return new ApiError(response, data as unknown, {
    method: "POST",
    url: "/api/account/mfa/setup",
  });
}

describe("parseRateLimitedError", () => {
  beforeEach(() => {
    // Pin "now" so retry-at math is deterministic. We use a fixed
    // wall-clock so the resulting Date can be compared by exact value
    // rather than fuzzy ranges.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null for non-ApiError values (network failure, thrown strings, undefined)", () => {
    // The MFA mutation onError handlers receive `unknown` — including
    // network-layer failures that never reach the server. Those must
    // fall through to the generic toast, not silently surface a stale
    // rate-limit alert.
    expect(parseRateLimitedError(null)).toBeNull();
    expect(parseRateLimitedError(undefined)).toBeNull();
    expect(parseRateLimitedError("boom")).toBeNull();
    expect(parseRateLimitedError(new Error("network down"))).toBeNull();
    expect(parseRateLimitedError({ status: 429 })).toBeNull();
  });

  it("returns null for non-429 ApiError responses", () => {
    // A 400 / 401 / 500 with the same body shape must NOT trip the
    // rate-limit branch — the friendly alert would mislead the user
    // into waiting for a retry window that doesn't exist.
    const e = rateLimitError({ status: 400 });
    expect(parseRateLimitedError(e)).toBeNull();
  });

  it("returns null when the 429 body uses an unrelated error code", () => {
    // 429 can in principle be raised for other reasons; only the two
    // well-known rate-limit codes hydrate the alert.
    const e = rateLimitError({ errorCode: "csrf_invalid" });
    expect(parseRateLimitedError(e)).toBeNull();
  });

  it("returns null when the 429 body is malformed (not an object, missing error)", () => {
    expect(parseRateLimitedError(rateLimitError({ body: null }))).toBeNull();
    expect(parseRateLimitedError(rateLimitError({ body: "rate_limited" }))).toBeNull();
    expect(parseRateLimitedError(rateLimitError({ body: { detail: "x" } }))).toBeNull();
  });

  it("parses the canonical `rate_limited` 429 with a numeric Retry-After header", () => {
    const e = rateLimitError({ retryAfter: "120" });
    const info = parseRateLimitedError(e);
    expect(info).not.toBeNull();
    expect(info?.retryAfterSeconds).toBe(120);
    // 12:00:00 + 120s == 12:02:00. Pinned by fake timers above.
    expect(info?.retryAt.toISOString()).toBe("2026-04-29T12:02:00.000Z");
  });

  it("also parses the NDPR-specific `export_rate_limited` code", () => {
    const e = rateLimitError({ errorCode: "export_rate_limited", retryAfter: "60" });
    const info = parseRateLimitedError(e);
    expect(info?.retryAfterSeconds).toBe(60);
  });

  it("falls back to a 60s window when Retry-After is missing", () => {
    // The middleware always emits the header, but a misbehaving proxy
    // could strip it. The UI still needs a sensible "try again at"
    // time rather than rendering an alert with an empty timestamp.
    const e = rateLimitError({ retryAfter: null });
    const info = parseRateLimitedError(e);
    expect(info?.retryAfterSeconds).toBe(60);
    expect(info?.retryAt.toISOString()).toBe("2026-04-29T12:01:00.000Z");
  });

  it("falls back to a 60s window when Retry-After is unparseable or non-positive", () => {
    expect(parseRateLimitedError(rateLimitError({ retryAfter: "not-a-number" }))?.retryAfterSeconds).toBe(60);
    expect(parseRateLimitedError(rateLimitError({ retryAfter: "0" }))?.retryAfterSeconds).toBe(60);
    expect(parseRateLimitedError(rateLimitError({ retryAfter: "-30" }))?.retryAfterSeconds).toBe(60);
  });
});

describe("formatRetryAtClockTime", () => {
  it("renders a short, locale-aware clock time (hour + minute, no seconds)", () => {
    // Don't assert the exact locale string — CI runs may differ — but
    // do confirm the formatter produced a non-empty hour:minute shape
    // and excluded seconds (which would be too noisy for a "try again
    // at" affordance).
    const out = formatRetryAtClockTime(new Date("2026-04-29T15:42:09.000Z"));
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain("09");
  });
});
