import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  customFetch,
  setCsrfToken,
  setCsrfTokenRefresher,
} from "@workspace/api-client-react";
import { fetchCsrfToken } from "./csrf";

/**
 * Verifies the shared API client interceptor (used by epplaa-mobile via
 * `@workspace/api-client-react`) attaches the `X-CSRF-Token` header on every
 * mutating verb when a token is stashed, recovers from a stale token via the
 * registered refresher, and that the mobile-specific `fetchCsrfToken` helper
 * correctly joins an absolute base URL with the `/api/csrf-token` path. See
 * `artifacts/api-server/src/middlewares/csrf.ts` for the server contract.
 *
 * Mobile is bearer-auth today so this wiring is dormant in production
 * (see `useCsrfToken`'s `enabled` flag default), but the interceptor itself
 * must keep working so that flipping the flag for a future cookie-session
 * surface is a one-liner.
 */

const MUTATING = ["POST", "PUT", "PATCH", "DELETE"] as const;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("epplaa-mobile CSRF interceptor", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setCsrfToken(null);
    setCsrfTokenRefresher(null);
  });

  afterEach(() => {
    setCsrfToken(null);
    setCsrfTokenRefresher(null);
    vi.unstubAllGlobals();
  });

  it.each(MUTATING)("attaches X-CSRF-Token on %s", async (method) => {
    setCsrfToken("mobile-token");
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await customFetch("/api/foo", { method });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init.headers);
    expect(headers.get("x-csrf-token")).toBe("mobile-token");
  });

  it("does not attach X-CSRF-Token on GET", async () => {
    setCsrfToken("mobile-token");
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await customFetch("/api/foo", { method: "GET" });

    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init.headers);
    expect(headers.get("x-csrf-token")).toBeNull();
  });

  it("does not attach the header when no token is stashed", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await customFetch("/api/foo", { method: "POST", body: "{}" });

    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init.headers);
    expect(headers.get("x-csrf-token")).toBeNull();
  });

  it("refreshes and retries once on 403 csrf_failed", async () => {
    setCsrfToken("stale");
    setCsrfTokenRefresher(async () => {
      setCsrfToken("fresh");
      return "fresh";
    });
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, { error: "csrf_failed", detail: "stale" }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const result = await customFetch<{ ok: boolean }>("/api/foo", {
      method: "POST",
      body: "{}",
    });

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryHeaders = new Headers(fetchMock.mock.calls[1][1].headers);
    expect(retryHeaders.get("x-csrf-token")).toBe("fresh");
  });

  it("does not retry on a non-CSRF 403", async () => {
    setCsrfToken("token");
    const refresher = vi.fn(async () => "fresh");
    setCsrfTokenRefresher(refresher);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, { error: "forbidden", detail: "nope" }),
    );

    await expect(
      customFetch("/api/foo", { method: "POST", body: "{}" }),
    ).rejects.toMatchObject({ status: 403 });

    expect(refresher).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("epplaa-mobile fetchCsrfToken", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setCsrfToken(null);
  });

  afterEach(() => {
    setCsrfToken(null);
    vi.unstubAllGlobals();
  });

  it("prepends the absolute base URL when calling the token endpoint", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { csrfToken: "tok-1" }));

    const token = await fetchCsrfToken("https://api.example.com");

    expect(token).toBe("tok-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example.com/api/csrf-token");
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("include");
  });

  it("trims a trailing slash from the base URL", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { csrfToken: "tok-2" }));

    await fetchCsrfToken("https://api.example.com/");

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.example.com/api/csrf-token",
    );
  });

  it("falls back to the bare path when no base URL is provided", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { csrfToken: "tok-3" }));

    await fetchCsrfToken();

    expect(fetchMock.mock.calls[0][0]).toBe("/api/csrf-token");
  });

  it("returns null and does not stash a token on a non-OK response", async () => {
    setCsrfToken("previous");
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: "boom" }));

    const token = await fetchCsrfToken("https://api.example.com");

    expect(token).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    const token = await fetchCsrfToken("https://api.example.com");

    expect(token).toBeNull();
  });

  it("returns null when the response body is missing the token field", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { somethingElse: true }));

    const token = await fetchCsrfToken("https://api.example.com");

    expect(token).toBeNull();
  });
});
