import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  customFetch,
  setCsrfToken,
  setCsrfTokenRefresher,
} from "@workspace/api-client-react";

/**
 * Verifies the shared API client interceptor (used by epplaa-app via
 * `@workspace/api-client-react`) attaches the `X-CSRF-Token` header on every
 * mutating verb when a token is stashed, and that a stale token recovers via
 * the registered refresher. See `artifacts/api-server/src/middlewares/csrf.ts`
 * for the corresponding server contract.
 */

const MUTATING = ["POST", "PUT", "PATCH", "DELETE"] as const;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("epplaa-app CSRF interceptor", () => {
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
    setCsrfToken("token-abc");
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await customFetch("/api/foo", { method });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init.headers);
    expect(headers.get("x-csrf-token")).toBe("token-abc");
  });

  it("does not attach X-CSRF-Token on GET", async () => {
    setCsrfToken("token-abc");
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
