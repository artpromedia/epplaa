import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  api,
  setApiCsrfToken,
  setApiCsrfRefresher,
  setApiTokenGetter,
} from "./api";

/**
 * Verifies the manufacturer portal's bespoke `api.ts` fetch wrapper attaches
 * the `X-CSRF-Token` header on every mutating verb when a token is stashed,
 * and that a stale token recovers via the registered refresher. See
 * `artifacts/api-server/src/middlewares/csrf.ts` for the server contract.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("manufacturer-portal CSRF interceptor", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setApiCsrfToken(null);
    setApiCsrfRefresher(null);
    setApiTokenGetter(null);
  });

  afterEach(() => {
    setApiCsrfToken(null);
    setApiCsrfRefresher(null);
    setApiTokenGetter(null);
    vi.unstubAllGlobals();
  });

  const cases: Array<[
    "POST" | "PUT" | "PATCH" | "DELETE",
    () => Promise<unknown>,
  ]> = [
    ["POST", () => api.post("/foo", { hello: "world" })],
    ["PUT", () => api.put("/foo", { hello: "world" })],
    ["PATCH", () => api.patch("/foo", { hello: "world" })],
    ["DELETE", () => api.delete("/foo")],
  ];

  it.each(cases)("attaches X-CSRF-Token on %s", async (method, run) => {
    setApiCsrfToken("mfr-token");
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await run();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>)["X-CSRF-Token"]).toBe(
      "mfr-token",
    );
    expect(init.method).toBe(method);
  });

  it("does not attach X-CSRF-Token on GET", async () => {
    setApiCsrfToken("mfr-token");
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await api.get("/foo");

    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>)["X-CSRF-Token"]).toBeUndefined();
  });

  it("does not attach the header when no token is stashed", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await api.post("/foo", {});

    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>)["X-CSRF-Token"]).toBeUndefined();
  });

  it("refreshes and retries once on 403 csrf_failed", async () => {
    setApiCsrfToken("stale");
    setApiCsrfRefresher(async () => {
      setApiCsrfToken("fresh");
      return "fresh";
    });
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, { error: "csrf_failed", detail: "stale" }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const result = await api.post<{ ok: boolean }>("/foo", {});

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryHeaders = fetchMock.mock.calls[1][1].headers as Record<
      string,
      string
    >;
    expect(retryHeaders["X-CSRF-Token"]).toBe("fresh");
  });

  it("does not retry on a non-CSRF 403", async () => {
    setApiCsrfToken("token");
    const refresher = vi.fn(async () => "fresh");
    setApiCsrfRefresher(refresher);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, { error: "forbidden" }),
    );

    await expect(api.post("/foo", {})).rejects.toMatchObject({ status: 403 });
    expect(refresher).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
