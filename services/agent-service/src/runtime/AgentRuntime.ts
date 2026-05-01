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
  /** Optional hook for AI Sprint 2 approval bus; not required in Sprint 1. */
  approvalBus?: { propose: (call: ToolCall, agentId: string) => Promise<ToolResult> };
  /** Optional hook for Langfuse / OTel trace emission. */
  emitTrace?: (event: TraceEvent) => Promise<string>;
}

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
          // Sprint 1 doesn't ship the bus yet; surface the request to the
          // caller so the operator can wire it up by Sprint 2 without
          // changing this code path.
          toolResults.push({
            callId: call.callId,
            name: call.name,
            output: null,
            error: "approval-bus-not-wired",
          });
          awaitedApproval = true;
          continue;
        }
        const result = await this.opts.approvalBus.propose(call, this.agentId);
        toolResults.push(result);
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
