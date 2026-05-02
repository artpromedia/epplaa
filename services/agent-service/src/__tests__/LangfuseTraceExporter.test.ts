import { describe, it, expect } from "vitest";
import { LangfuseTraceExporter } from "../lib/LangfuseTraceExporter.js";
import type { TraceEvent } from "../runtime/AgentRuntime.js";

const baseEvent: TraceEvent = {
  agentId: "buyer-concierge",
  sessionId: "sess-7",
  modelResponse: {
    text: "Hello",
    toolCalls: [],
    model: "claude-sonnet-4",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    latencyMs: 200,
  },
  toolResults: [
    { callId: "t1", name: "catalog.search", output: { results: [], total: 0 } },
    { callId: "t2", name: "order.read", output: null, error: "boom" },
  ],
  durationMs: 250,
};

describe("LangfuseTraceExporter", () => {
  it("posts a batch with trace + generation + spans and returns the trace id", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const exporter = new LangfuseTraceExporter({
      baseUrl: "https://lf.test",
      publicKey: "pk",
      secretKey: "sk",
      fetchImpl,
    });
    const traceId = await exporter.emit(baseEvent);
    expect(traceId).toMatch(/^trace_/);

    expect(captured).not.toBeNull();
    const c = captured as unknown as { url: string; init: RequestInit };
    expect(c.url).toBe("https://lf.test/api/public/ingestion");
    const headers = new Headers(c.init.headers as Record<string, string>);
    expect(headers.get("authorization")).toMatch(/^Basic /);
    const body = JSON.parse(c.init.body as string) as { batch: Array<{ type: string }> };
    const types = body.batch.map((e) => e.type).sort();
    // 1 trace + 1 generation + 2 spans (one per tool result)
    expect(types).toEqual([
      "generation-create",
      "span-create",
      "span-create",
      "trace-create",
    ]);
  });

  it("falls back to a local trace id when the upstream POST fails", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 500, statusText: "boom" })) as typeof fetch;
    const exporter = new LangfuseTraceExporter({
      baseUrl: "https://lf.test",
      publicKey: "pk",
      secretKey: "sk",
      fetchImpl,
    });
    const traceId = await exporter.emit(baseEvent);
    expect(traceId).toMatch(/^local-trace-buyer-concierge-sess-7-/);
  });

  it("falls back to a local trace id when fetch throws", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const exporter = new LangfuseTraceExporter({
      baseUrl: "https://lf.test",
      publicKey: "pk",
      secretKey: "sk",
      fetchImpl,
    });
    const traceId = await exporter.emit(baseEvent);
    expect(traceId).toMatch(/^local-trace-/);
  });
});
