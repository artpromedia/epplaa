/**
 * AgentRuntime — core request lifecycle for Epplaa AI agents.
 *
 * Implements the lifecycle defined in §14.3.2 of the v4.2 architecture:
 *   load config → hydrate memory → call gateway → validate tool calls
 *   → dispatch or wait for approval → emit trace
 *
 * AI Sprint 1: real wiring (this file). Approval-bus suspension and the
 * Langfuse trace exporter still ship in AI Sprint 2 / late Sprint 1
 * respectively — those paths are clearly marked.
 */

import type { z } from "zod";
import type { AgentConfig } from "../agents/types.js";
import type {
  IModelGateway,
  Message,
  ModelResponse,
} from "../gateway/ModelGateway.js";
import type { IShortTermMemory, ConversationMessage } from "../memory/ShortTermMemory.js";
import type { IAgentRegistry } from "../registry/AgentRegistry.js";
import type { IPromptRegistry } from "../registry/PromptRegistry.js";
import type {
  IToolRegistry,
  ToolCall,
  ToolDescriptor,
  ToolResult,
} from "../registry/ToolRegistry.js";

export interface AgentRuntimeOptions {
  agentId: string;
  sessionId: string;
  registries: {
    agents: IAgentRegistry;
    prompts: IPromptRegistry;
    tools: IToolRegistry;
  };
  gateway: IModelGateway;
  memory: IShortTermMemory;
  /** Hook for dispatching tools that don't require approval. */
  toolDispatcher: (call: ToolCall, descriptor: ToolDescriptor) => Promise<ToolResult>;
  /**
   * Approval-bus integration. Returns an ApprovalDecision; when
   * `approved=true` the runtime auto-dispatches the tool via
   * `toolDispatcher` and surfaces the dispatch result to the caller.
   * The previous Sprint-1 contract (returning a synthetic ToolResult)
   * was replaced because it forced the operator UI to perform the
   * dispatch out-of-band.
   */
  approvalBus?: {
    requestApproval: (
      call: ToolCall,
      ctx: { agentId: string; sessionId: string },
    ) => Promise<ApprovalDecision>;
  };
  /**
   * Optional audit emitter — called for every approval-bus interaction
   * (proposed / approved / rejected / dispatched / dispatch_failed).
   * Failures here are swallowed and logged; an audit-sink outage MUST
   * NOT break agent traffic.
   */
  auditEmit?: (event: ApprovalAuditEvent) => Promise<void>;
  /** Optional hook for Langfuse / OTel trace emission. */
  emitTrace?: (event: TraceEvent) => Promise<string>;
}

export type ApprovalDecision =
  | { approved: true; approvedBy: string; decidedAt: string; note?: string | undefined }
  | {
      approved: false;
      /** "rejected" when an operator declined; "error" on transport failure. */
      kind: "rejected" | "error";
      reason: string;
      decidedBy?: string | undefined;
    };

export type ApprovalAuditEvent =
  | { kind: "tool_proposed"; agentId: string; sessionId: string; tool: string; callId: string; args: unknown; at: string }
  | { kind: "tool_approved"; agentId: string; sessionId: string; tool: string; callId: string; approvedBy: string; at: string }
  | { kind: "tool_rejected"; agentId: string; sessionId: string; tool: string; callId: string; reason: string; decidedBy?: string | undefined; at: string }
  | { kind: "tool_dispatched"; agentId: string; sessionId: string; tool: string; callId: string; at: string }
  | { kind: "tool_dispatch_failed"; agentId: string; sessionId: string; tool: string; callId: string; error: string; at: string };

export interface HandleInput {
  message: string;
  receivedAt: string;
}

export interface HandleOutput {
  response: string;
  awaitedApproval: boolean;
  traceId: string;
}

export interface TraceEvent {
  agentId: string;
  sessionId: string;
  modelResponse: ModelResponse;
  toolResults: ToolResult[];
  durationMs: number;
}

export class AgentRuntime {
  private readonly agentId: string;
  private readonly sessionId: string;
  private readonly opts: AgentRuntimeOptions;

  constructor(options: AgentRuntimeOptions) {
    this.agentId = options.agentId;
    this.sessionId = options.sessionId;
    this.opts = options;
  }

  async handle(input: HandleInput): Promise<HandleOutput> {
    const start = Date.now();
    const config = await this.loadConfig();
    const prompt = await this.opts.registries.prompts.load(config.promptRef);
    const history = await this.opts.memory.get(this.sessionId);

    const userMsg: ConversationMessage = {
      role: "user",
      content: input.message,
      timestamp: input.receivedAt,
    };

    const systemMsg: Message = { role: "system", content: prompt.systemPrompt };
    const llmMessages: Message[] = [
      systemMsg,
      ...history.map(historyToGatewayMessage),
      { role: "user", content: input.message },
    ];

    const response = await this.opts.gateway.complete({
      agentId: this.agentId,
      sessionId: this.sessionId,
      messages: llmMessages,
      availableTools: config.tools,
      model: config.modelPolicy.primary,
      maxTokens: config.modelPolicy.maxTokens,
      temperature: config.modelPolicy.temperature,
    });

    const validCalls = this.validateToolCalls(
      response.toolCalls.map((tc) => ({ name: tc.name, args: tc.args, callId: tc.callId })),
      config,
    );

    let awaitedApproval = false;
    const toolResults: ToolResult[] = [];
    for (const call of validCalls) {
      const desc = this.opts.registries.tools.get(call.name);
      if (!desc) continue; // unreachable: validateToolCalls already filtered.
      if (desc.approvalThreshold === "single-human") {
        if (!this.opts.approvalBus) {
          // Composition-time misconfiguration — an approval-required
          // tool was registered for an agent in an environment without
          // a wired approval bus. Surface to caller so the operator can
          // either remove the tool or wire the bus.
          toolResults.push({
            callId: call.callId,
            name: call.name,
            output: null,
            error: "approval-bus-not-wired",
          });
          awaitedApproval = true;
          continue;
        }
        const proposedAt = new Date().toISOString();
        await this.audit({
          kind: "tool_proposed",
          agentId: this.agentId,
          sessionId: this.sessionId,
          tool: call.name,
          callId: call.callId,
          args: call.args,
          at: proposedAt,
        });
        const decision = await this.opts.approvalBus.requestApproval(call, {
          agentId: this.agentId,
          sessionId: this.sessionId,
        });
        if (!decision.approved) {
          await this.audit({
            kind: "tool_rejected",
            agentId: this.agentId,
            sessionId: this.sessionId,
            tool: call.name,
            callId: call.callId,
            reason: decision.reason,
            decidedBy: decision.decidedBy,
            at: new Date().toISOString(),
          });
          toolResults.push({
            callId: call.callId,
            name: call.name,
            output: null,
            error:
              decision.kind === "rejected"
                ? `rejected${decision.decidedBy ? ` by ${decision.decidedBy}` : ""}: ${decision.reason}`
                : `approval-bus-error: ${decision.reason}`,
          });
          awaitedApproval = true;
          continue;
        }
        await this.audit({
          kind: "tool_approved",
          agentId: this.agentId,
          sessionId: this.sessionId,
          tool: call.name,
          callId: call.callId,
          approvedBy: decision.approvedBy,
          at: decision.decidedAt,
        });
        // Auto-dispatch the approved call. The runtime is now the single
        // place where money/account tools execute, so the audit trail is
        // complete (proposed -> approved -> dispatched|dispatch_failed).
        try {
          const dispatched = await this.opts.toolDispatcher(call, desc);
          await this.audit({
            kind: "tool_dispatched",
            agentId: this.agentId,
            sessionId: this.sessionId,
            tool: call.name,
            callId: call.callId,
            at: new Date().toISOString(),
          });
          toolResults.push(dispatched);
        } catch (err) {
          const message = (err as Error).message;
          await this.audit({
            kind: "tool_dispatch_failed",
            agentId: this.agentId,
            sessionId: this.sessionId,
            tool: call.name,
            callId: call.callId,
            error: message,
            at: new Date().toISOString(),
          });
          toolResults.push({
            callId: call.callId,
            name: call.name,
            output: null,
            error: `post-approval-dispatch-failed: ${message}`,
          });
        }
        awaitedApproval = true;
      } else {
        toolResults.push(await this.opts.toolDispatcher(call, desc));
      }
    }

    const assistantMsg: ConversationMessage = {
      role: "assistant",
      content: response.text,
      timestamp: new Date().toISOString(),
    };
    await this.opts.memory.append(this.sessionId, [userMsg, assistantMsg]);

    const traceId =
      (await this.opts.emitTrace?.({
        agentId: this.agentId,
        sessionId: this.sessionId,
        modelResponse: response,
        toolResults,
        durationMs: Date.now() - start,
      })) ?? `local-trace-${this.agentId}-${this.sessionId}-${Date.now()}`;

    return { response: response.text, awaitedApproval, traceId };
  }

  private async loadConfig(): Promise<AgentConfig> {
    const cfg = this.opts.registries.agents.get(this.agentId);
    if (!cfg) {
      throw new Error(`AgentRegistry: unknown agent '${this.agentId}'`);
    }
    return cfg;
  }

  private async audit(event: ApprovalAuditEvent): Promise<void> {
    if (!this.opts.auditEmit) return;
    try {
      await this.opts.auditEmit(event);
    } catch {
      // Audit-sink outage MUST NOT break agent traffic. We deliberately
      // swallow without re-throwing; the audit emitter is responsible
      // for its own internal logging.
    }
  }

  private validateToolCalls(calls: ToolCall[], config: AgentConfig): ToolCall[] {
    const allowed = new Set(config.tools);
    const valid: ToolCall[] = [];
    for (const call of calls) {
      if (!allowed.has(call.name)) continue;
      const desc = this.opts.registries.tools.get(call.name);
      if (!desc) continue;
      const parsed = (desc.inputSchema as z.ZodTypeAny).safeParse(call.args);
      if (!parsed.success) continue;
      valid.push({ name: call.name, args: parsed.data, callId: call.callId });
    }
    return valid;
  }
}

function historyToGatewayMessage(m: ConversationMessage): Message {
  return m.role === "tool"
    ? { role: "tool", content: m.content, toolCallId: m.toolCallId }
    : { role: m.role, content: m.content };
}
