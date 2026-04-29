import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  customFetch,
  setAuthTokenGetter,
  setCsrfToken,
  setCsrfTokenRefresher,
} from "./custom-fetch";

/**
 * Verifies the shared `customFetch` wrapper attaches the `X-CSRF-Token`
 * header on every mutating verb when a token is stashed, and that a stale
 * token recovers via the registered refresher. See
 * `artifacts/api-server/src/middlewares/csrf.ts` for the server contract.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("customFetch CSRF wiring", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setCsrfToken(null);
    setCsrfTokenRefresher(null);
    setAuthTokenGetter(null);
  });

  afterEach(() => {
    setCsrfToken(null);
    setCsrfTokenRefresher(null);
    setAuthTokenGetter(null);
    vi.unstubAllGlobals();
  });

  const mutatingCases: Array<["POST" | "PUT" | "PATCH" | "DELETE"]> = [
    ["POST"],
    ["PUT"],
    ["PATCH"],
    ["DELETE"],
  ];

  it.each(mutatingCases)("attaches X-CSRF-Token on %s", async (method) => {
    setCsrfToken("mfr-token");
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await customFetch("/foo", {
      method,
      body: method === "DELETE" ? undefined : JSON.stringify({ hello: "world" }),
      headers: { "content-type": "application/json" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Headers;
    expect(headers.get("x-csrf-token")).toBe("mfr-token");
    expect(init.method).toBe(method);
  });

  it("does not attach X-CSRF-Token on GET", async () => {
    setCsrfToken("mfr-token");
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await customFetch("/foo");

    const [, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Headers;
    expect(headers.get("x-csrf-token")).toBeNull();
  });

  it("does not attach the header when no token is stashed", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await customFetch("/foo", { method: "POST", body: JSON.stringify({}) });

    const [, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Headers;
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

    const result = await customFetch<{ ok: boolean }>("/foo", {
      method: "POST",
      body: JSON.stringify({}),
    });

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryHeaders = fetchMock.mock.calls[1][1].headers as Headers;
    expect(retryHeaders.get("x-csrf-token")).toBe("fresh");
  });

  it("does not retry on a non-CSRF 403", async () => {
    setCsrfToken("token");
    const refresher = vi.fn(async () => "fresh");
    setCsrfTokenRefresher(refresher);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, { error: "forbidden" }),
    );

    await expect(
      customFetch("/foo", { method: "POST", body: JSON.stringify({}) }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(refresher).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
