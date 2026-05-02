/**
 * ToolDispatcher — executes non-approval tool calls against backing services.
 *
 * Sprint 1.1 lands:
 *  - HandlerRegistry: per-tool handlers that receive (args, ctx) and return
 *    output. Validates output against `ToolDescriptor.outputSchema` so a
 *    misbehaving downstream cannot silently corrupt the agent's reasoning.
 *  - HttpToolDispatcher: thin wrapper that adds an HTTP client (fetch-based)
 *    + service-to-service auth token to the context every handler receives.
 *  - Default handlers for the read-only tools that already have monolith
 *    routes (catalog.search → /listings, order.read → /orders/:id).
 *
 * Money/account tools (refund_request, return_request, listing.flag*,
 * payment.payout_request, message.send_to_user) are NOT registered here:
 * they go through the approval bus first, and the post-approval dispatch
 * happens in the operator-facing UI per ADR-014. A future slice may add
 * post-approval auto-dispatch by passing this dispatcher into the approval
 * adapter, but that path needs end-to-end audit-trail wiring first.
 */

import type { ToolCall, ToolDescriptor, ToolResult } from "../registry/ToolRegistry.js";

export interface ToolDispatchContext {
  agentId: string;
  sessionId: string;
  /** Optional service-to-service bearer token forwarded to backing APIs. */
  authToken: string | undefined;
}

export type ToolHandler = (
  args: unknown,
  ctx: ToolDispatchContext,
) => Promise<unknown>;

export interface ToolDispatcherOptions {
  /** Base URL of the api-monolith (e.g. http://api-monolith.commerce). */
  monolithBaseUrl: string;
  /** Service-to-service token; forwarded as `Authorization: Bearer <token>`. */
  serviceToken: string | undefined;
  /** Fetch implementation; injected for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Per-call timeout in ms. */
  timeoutMs?: number;
  /** Optional extra handlers registered on top of the defaults. */
  extraHandlers?: Map<string, ToolHandler>;
}

/**
 * In-process dispatcher with a per-tool handler registry.
 *
 * Unknown tools and downstream errors return structured ToolResult.error
 * strings rather than throwing, matching the AgentRuntime contract that
 * tool failures are observable in the model's next turn.
 */
export class HttpToolDispatcher {
  private readonly handlers: Map<string, ToolHandler>;
  private readonly opts: Required<Omit<ToolDispatcherOptions, "extraHandlers" | "serviceToken">> & {
    serviceToken: string | undefined;
  };

  constructor(opts: ToolDispatcherOptions) {
    this.opts = {
      monolithBaseUrl: opts.monolithBaseUrl.replace(/\/$/, ""),
      serviceToken: opts.serviceToken,
      fetchImpl: opts.fetchImpl ?? globalThis.fetch.bind(globalThis),
      timeoutMs: opts.timeoutMs ?? 5_000,
    };
    this.handlers = new Map(this.defaultHandlers());
    if (opts.extraHandlers) {
      for (const [name, h] of opts.extraHandlers) this.handlers.set(name, h);
    }
  }

  /** Test seam: register or replace a handler. */
  register(name: string, handler: ToolHandler): void {
    this.handlers.set(name, handler);
  }

  /** Test seam: list registered tool names. */
  registeredTools(): string[] {
    return [...this.handlers.keys()];
  }

  /**
   * Dispatch a tool call. Validates output against the descriptor's
   * schema before returning to AgentRuntime.
   */
  async dispatch(
    call: ToolCall,
    descriptor: ToolDescriptor,
    ctx: ToolDispatchContext,
  ): Promise<ToolResult> {
    const handler = this.handlers.get(call.name);
    if (!handler) {
      return {
        callId: call.callId,
        name: call.name,
        output: null,
        error: `tool-not-implemented: ${call.name} has no dispatcher handler (Sprint 1.1+)`,
      };
    }
    try {
      const raw = await handler(call.args, ctx);
      const parsed = descriptor.outputSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          callId: call.callId,
          name: call.name,
          output: null,
          error: `output-schema-violation: ${parsed.error.message}`,
        };
      }
      return { callId: call.callId, name: call.name, output: parsed.data };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        callId: call.callId,
        name: call.name,
        output: null,
        error: `tool-dispatch-error: ${message}`,
      };
    }
  }

  /** GET helper with timeout + service-token forwarding. */
  private async monolithGet(path: string, ctx: ToolDispatchContext): Promise<unknown> {
    const url = `${this.opts.monolithBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    const headers: Record<string, string> = {
      accept: "application/json",
      "x-agent-service-id": ctx.agentId,
      "x-agent-session-id": ctx.sessionId,
    };
    const token = ctx.authToken ?? this.opts.serviceToken;
    if (token) headers.authorization = `Bearer ${token}`;
    try {
      const res = await this.opts.fetchImpl(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`upstream ${res.status} ${res.statusText}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Built-in handlers for read-only monolith tools. Each handler shapes the
   * upstream response into the descriptor's outputSchema; a schema mismatch
   * surfaces as a tool-dispatch-error rather than silent data corruption.
   */
  private defaultHandlers(): Iterable<[string, ToolHandler]> {
    return [
      [
        "catalog.search",
        async (args, ctx) => {
          const { query } = args as { query: string };
          const q = encodeURIComponent(query);
          const data = (await this.monolithGet(`/listings?q=${q}`, ctx)) as {
            listings?: Array<{ id: string; title: string }>;
            total?: number;
          };
          const listings = Array.isArray(data.listings) ? data.listings : [];
          return {
            results: listings.map((l) => ({ listingId: l.id, title: l.title })),
            total: typeof data.total === "number" ? data.total : listings.length,
          };
        },
      ],
      [
        "order.read",
        async (args, ctx) => {
          const { orderId } = args as { orderId: string };
          const data = (await this.monolithGet(
            `/orders/${encodeURIComponent(orderId)}`,
            ctx,
          )) as { id?: string; status?: string; totalMinor?: number; currencyCode?: string };
          return {
            orderId: data.id ?? orderId,
            status: data.status ?? "unknown",
            total: typeof data.totalMinor === "number" ? data.totalMinor / 100 : 0,
            currency: data.currencyCode ?? "NGN",
          };
        },
      ],
    ];
  }
}
