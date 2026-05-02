import { describe, it, expect, vi } from "vitest";
import { HttpToolDispatcher } from "../runtime/ToolDispatcher.js";
import {
  TOOL_CATALOG_SEARCH,
  TOOL_ORDER_READ,
  TOOL_PAYMENT_REFUND_REQUEST,
} from "../registry/ToolRegistry.js";

function buildFetch(handler: (url: string, init: RequestInit) => Promise<Response>): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) =>
    handler(typeof url === "string" ? url : url.toString(), init ?? {})) as typeof fetch;
}

describe("HttpToolDispatcher", () => {
  const ctx = { agentId: "buyer-concierge", sessionId: "s1", authToken: undefined };

  it("dispatches catalog.search by GETting /api/products and shaping output", async () => {
    const calls: string[] = [];
    const fetchImpl = buildFetch(async (url) => {
      calls.push(url);
      return new Response(
        JSON.stringify({
          listings: [
            { id: "l1", title: "Red shoe" },
            { id: "l2", title: "Blue shoe" },
          ],
          total: 2,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const d = new HttpToolDispatcher({
      monolithBaseUrl: "http://m.test",
      serviceToken: "tok",
      fetchImpl,
    });
    const out = await d.dispatch(
      { name: "catalog.search", args: { query: "shoe" }, callId: "c1" },
      TOOL_CATALOG_SEARCH,
      ctx,
    );
    expect(out.error).toBeUndefined();
    expect(out.output).toEqual({
      results: [
        { listingId: "l1", title: "Red shoe" },
        { listingId: "l2", title: "Blue shoe" },
      ],
      total: 2,
    });
    expect(calls[0]).toBe("http://m.test/api/products?search=shoe");
  });

  it("dispatches order.read converting minor units", async () => {
    const fetchImpl = buildFetch(
      async () =>
        new Response(
          JSON.stringify({
            id: "o1",
            status: "paid",
            totalMinor: 1234500,
            currencyCode: "NGN",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const d = new HttpToolDispatcher({
      monolithBaseUrl: "http://m.test",
      serviceToken: undefined,
      fetchImpl,
    });
    const out = await d.dispatch(
      {
        name: "order.read",
        args: { orderId: "11111111-1111-1111-1111-111111111111" },
        callId: "c2",
      },
      TOOL_ORDER_READ,
      ctx,
    );
    expect(out.error).toBeUndefined();
    expect(out.output).toEqual({
      orderId: "o1",
      status: "paid",
      total: 12345,
      currency: "NGN",
    });
  });

  it("returns tool-not-implemented for tools without a registered handler", async () => {
    const d = new HttpToolDispatcher({
      monolithBaseUrl: "http://m.test",
      serviceToken: undefined,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    const out = await d.dispatch(
      {
        name: "payment.refund_request",
        args: {
          paymentId: "11111111-1111-1111-1111-111111111111",
          amountNgn: 100,
          reason: "x",
        },
        callId: "c3",
      },
      TOOL_PAYMENT_REFUND_REQUEST,
      ctx,
    );
    expect(out.error).toMatch(/tool-not-implemented/);
    expect(out.output).toBeNull();
  });

  it("surfaces upstream errors as tool-dispatch-error", async () => {
    const fetchImpl = buildFetch(
      async () => new Response("oops", { status: 503, statusText: "down" }),
    );
    const d = new HttpToolDispatcher({
      monolithBaseUrl: "http://m.test",
      serviceToken: undefined,
      fetchImpl,
    });
    const out = await d.dispatch(
      { name: "catalog.search", args: { query: "x" }, callId: "c4" },
      TOOL_CATALOG_SEARCH,
      ctx,
    );
    expect(out.error).toMatch(/tool-dispatch-error.*upstream 503/);
  });

  it("surfaces output schema violations explicitly", async () => {
    const fetchImpl = buildFetch(
      async () =>
        new Response(JSON.stringify({ listings: [{ id: 1, title: 2 }], total: "nope" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const d = new HttpToolDispatcher({
      monolithBaseUrl: "http://m.test",
      serviceToken: undefined,
      fetchImpl,
    });
    const out = await d.dispatch(
      { name: "catalog.search", args: { query: "x" }, callId: "c5" },
      TOOL_CATALOG_SEARCH,
      ctx,
    );
    expect(out.error).toMatch(/output-schema-violation/);
  });

  it("forwards Authorization + correlation headers", async () => {
    let captured: Headers | null = null;
    const fetchImpl = buildFetch(async (_url, init) => {
      captured = new Headers(init.headers as Record<string, string>);
      return new Response(JSON.stringify({ listings: [], total: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const d = new HttpToolDispatcher({
      monolithBaseUrl: "http://m.test",
      serviceToken: "svc-tok",
      fetchImpl,
    });
    await d.dispatch(
      { name: "catalog.search", args: { query: "x" }, callId: "c6" },
      TOOL_CATALOG_SEARCH,
      ctx,
    );
    expect(captured).not.toBeNull();
    const h = captured as unknown as Headers;
    expect(h.get("authorization")).toBe("Bearer svc-tok");
    expect(h.get("x-agent-service-id")).toBe("buyer-concierge");
    expect(h.get("x-agent-session-id")).toBe("s1");
  });

  it("supports extra handlers", async () => {
    const handler = vi.fn(async () => ({
      results: [{ listingId: "x", title: "x" }],
      total: 1,
    }));
    const d = new HttpToolDispatcher({
      monolithBaseUrl: "http://m.test",
      serviceToken: undefined,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      extraHandlers: new Map([["catalog.search", handler]]),
    });
    const out = await d.dispatch(
      { name: "catalog.search", args: { query: "y" }, callId: "c7" },
      TOOL_CATALOG_SEARCH,
      ctx,
    );
    expect(handler).toHaveBeenCalledOnce();
    expect(out.error).toBeUndefined();
    expect(out.output).toEqual({ results: [{ listingId: "x", title: "x" }], total: 1 });
  });
});
