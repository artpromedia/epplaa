/**
 * LangfuseTraceExporter — sinks AgentRuntime trace events into Langfuse.
 *
 * Uses the public ingestion endpoint (`/api/public/ingestion`) with
 * basic-auth (publicKey:secretKey). On failure we log + return a local
 * trace ID so the agent's HTTP response is never blocked by trace export.
 *
 * Event shape:
 *   trace-create  → top-level trace per agent invocation
 *   generation-create → the LLM call (tokens, model, latency)
 *   span-create   → one span per tool result
 *
 * Body buffering / retries are out of scope here; the Langfuse server
 * tolerates per-request POSTs at the volumes the agent service runs at.
 * If volume increases this should move to a queue + batch flush.
 */

import { randomUUID } from "node:crypto";
import type { TraceEvent } from "../runtime/AgentRuntime.js";
import { logger } from "./observability.js";

export interface LangfuseExporterOptions {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface IngestionEvent {
  id: string;
  type: "trace-create" | "generation-create" | "span-create";
  timestamp: string;
  body: Record<string, unknown>;
}

export class LangfuseTraceExporter {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: LangfuseExporterOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.authHeader = `Basic ${Buffer.from(`${opts.publicKey}:${opts.secretKey}`).toString("base64")}`;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? 3_000;
  }

  /**
   * Compatible with `AgentRuntimeOptions.emitTrace`. Always returns a
   * trace id (Langfuse-assigned on success, locally generated on failure).
   */
  async emit(event: TraceEvent): Promise<string> {
    const traceId = `trace_${randomUUID()}`;
    const generationId = `gen_${randomUUID()}`;
    const startedAt = new Date(Date.now() - event.durationMs).toISOString();
    const finishedAt = new Date().toISOString();

    const events: IngestionEvent[] = [
      {
        id: randomUUID(),
        type: "trace-create",
        timestamp: finishedAt,
        body: {
          id: traceId,
          name: `agent.${event.agentId}`,
          userId: event.sessionId,
          metadata: { agentId: event.agentId, sessionId: event.sessionId },
          tags: ["agent", event.agentId],
        },
      },
      {
        id: randomUUID(),
        type: "generation-create",
        timestamp: finishedAt,
        body: {
          id: generationId,
          traceId,
          name: "llm.complete",
          startTime: startedAt,
          endTime: finishedAt,
          model: event.modelResponse.model,
          usage: {
            input: event.modelResponse.usage.promptTokens,
            output: event.modelResponse.usage.completionTokens,
            total: event.modelResponse.usage.totalTokens,
            unit: "TOKENS",
          },
          output: { text: event.modelResponse.text },
        },
      },
    ];

    for (const tr of event.toolResults) {
      events.push({
        id: randomUUID(),
        type: "span-create",
        timestamp: finishedAt,
        body: {
          id: `span_${randomUUID()}`,
          traceId,
          name: `tool.${tr.name}`,
          startTime: startedAt,
          endTime: finishedAt,
          metadata: { callId: tr.callId },
          output: tr.output,
          level: tr.error ? "ERROR" : "DEFAULT",
          statusMessage: tr.error,
        },
      });
    }

    try {
      await this.post(events);
      return traceId;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, agentId: event.agentId },
        "langfuse_export_failed",
      );
      return `local-trace-${event.agentId}-${event.sessionId}-${Date.now()}`;
    }
  }

  private async post(events: IngestionEvent[]): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/public/ingestion`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: this.authHeader,
        },
        body: JSON.stringify({ batch: events }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`langfuse ${res.status} ${res.statusText}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
