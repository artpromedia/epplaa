/**
 * AgentRuntime — core request lifecycle for Epplaa AI agents.
 *
 * Implements the lifecycle defined in §14.3.2 of the v4.2 architecture:
 *   load config → hydrate memory → call gateway → validate tool calls
 *   → dispatch or wait for approval → emit trace
 *
 * AI Sprint 0: all method bodies are TODO stubs with comments referencing
 * the relevant §14 subsection. The class skeleton is complete so that
 * downstream code can import and construct it, and the smoke test can
 * assert construction succeeds.
 */

import type { AgentConfig } from "../agents/types.js";
import type { ToolCall, ToolResult } from "../registry/ToolRegistry.js";
import type { ModelResponse } from "../gateway/ModelGateway.js";

export interface AgentRuntimeOptions {
  /** Identifies the agent being run. Must match a config in the AgentRegistry. */
  agentId: string;
  /** Opaque session identifier (e.g., Clerk userId + timestamp hash). */
  sessionId: string;
}

export interface HandleInput {
  /** The user's message text (already PII-redacted and language-normalised). */
  message: string;
  /** ISO-8601 timestamp of message receipt. */
  receivedAt: string;
}

export interface HandleOutput {
  /** The agent's response text. */
  response: string;
  /** Whether the turn required a human-approval suspension. */
  awaitedApproval: boolean;
  /** Langfuse trace ID for this turn. */
  traceId: string;
}

/**
 * AgentRuntime orchestrates a single conversation turn for one agent.
 *
 * One AgentRuntime instance is created per HTTP request (or per LiveKit
 * session turn). It is NOT a long-lived singleton.
 */
export class AgentRuntime {
  private readonly agentId: string;
  private readonly sessionId: string;

  constructor(options: AgentRuntimeOptions) {
    this.agentId = options.agentId;
    this.sessionId = options.sessionId;
  }

  // -------------------------------------------------------------------------
  // §14.3.2 Step 1: Load agent config from PromptRegistry + ToolRegistry
  // -------------------------------------------------------------------------
  /**
   * Loads the agent's prompt reference and tool-set for this request.
   * TODO (AI Sprint 1): replace stub with real PromptRegistry.load() call.
   * @see §14.6 (Prompt Registry)
   * @see §14.7 (Tool Registry)
   */
  private async loadConfig(): Promise<AgentConfig> {
    // TODO (AI Sprint 1): look up this.agentId in AgentRegistry;
    // call PromptRegistry.load(config.promptRef) to hydrate the system prompt.
    throw new Error(
      `loadConfig() not yet implemented for agent '${this.agentId}' — AI Sprint 1`,
    );
  }

  // -------------------------------------------------------------------------
  // §14.3.2 Step 2: Hydrate short-term memory from Redis
  // -------------------------------------------------------------------------
  /**
   * Retrieves the conversation history for this session from Redis.
   * TODO (AI Sprint 1): connect to ShortTermMemory and retrieve the
   * last N turns for this.sessionId.
   * @see §14.8 (Memory Architecture)
   */
  private async hydrateMemory(): Promise<unknown[]> {
    // TODO (AI Sprint 1): return ShortTermMemory.get(this.sessionId)
    return [];
  }

  // -------------------------------------------------------------------------
  // §14.3.2 Step 3: Call the LiteLLM-backed ModelGateway
  // -------------------------------------------------------------------------
  /**
   * Sends the assembled prompt + conversation history to the model gateway.
   * TODO (AI Sprint 1): construct the messages array and call
   * ModelGateway.complete().
   * @see §14.5 (Model Gateway)
   */
  private async callGateway(
    _systemPrompt: string,
    _messages: unknown[],
    _userMessage: string,
  ): Promise<ModelResponse> {
    // TODO (AI Sprint 1): inject ModelGateway via constructor;
    // call gateway.complete({ agentId, messages, tools }).
    throw new Error("callGateway() not yet implemented — AI Sprint 1");
  }

  // -------------------------------------------------------------------------
  // §14.3.2 Step 4: Validate tool calls against ToolRegistry schema
  // -------------------------------------------------------------------------
  /**
   * Validates each proposed tool call from the model against:
   *   1. The agent's declared tool-set (scope check).
   *   2. The tool's Zod inputSchema (data validation).
   * Rejects any call that fails either check without executing it.
   * @see §14.7.1 (Tool descriptor fields)
   * @see §14.9.1 (Prompt Injection Defense — scope enforcement)
   */
  private validateToolCalls(_calls: ToolCall[]): ToolCall[] {
    // TODO (AI Sprint 1): for each call in _calls:
    //   1. Check call.name is in agentConfig.tools.
    //   2. Parse call.args through the tool's Zod inputSchema.
    //   3. Reject (throw or filter) calls that fail either check.
    return [];
  }

  // -------------------------------------------------------------------------
  // §14.3.2 Step 5a: Dispatch tool directly (approval not required)
  // -------------------------------------------------------------------------
  /**
   * Executes a tool whose approvalThreshold is 'none'.
   * TODO (AI Sprint 1): call the platform API backing the tool.
   * @see §14.7.2 (High-traffic tool subset)
   */
  private async dispatchTool(_call: ToolCall): Promise<ToolResult> {
    // TODO (AI Sprint 1): route call.name to the appropriate platform API;
    // validate the result against the tool's Zod outputSchema.
    throw new Error("dispatchTool() not yet implemented — AI Sprint 1");
  }

  // -------------------------------------------------------------------------
  // §14.3.2 Step 5b: Publish to ApprovalBus and await human decision
  // -------------------------------------------------------------------------
  /**
   * Publishes a proposed-action event and suspends until a human approves
   * or rejects (or until the 15-minute timeout expires).
   * ADR-014: this path is MANDATORY for all money/account/messaging tools.
   * @see §14.7.3 (Approval Bus)
   * @see ADR-014 (autonomy ceiling)
   */
  private async waitForApproval(_call: ToolCall): Promise<ToolResult> {
    // TODO (AI Sprint 2): publish to ApprovalBus.produce();
    // await agent.action_approved / agent.action_rejected event;
    // on timeout (15 min): return scripted safe response.
    throw new Error("waitForApproval() not yet implemented — AI Sprint 2");
  }

  // -------------------------------------------------------------------------
  // §14.3.2 Step 6: Emit Langfuse trace
  // -------------------------------------------------------------------------
  /**
   * Emits a structured trace to Langfuse for every LLM call.
   * TODO (AI Sprint 1): inject @langfuse/sdk LangfuseClient via constructor
   * and emit the trace with agentId, sessionId, tokens, latency.
   * @see §14.10 (Observability)
   */
  private async emitTrace(
    _response: ModelResponse,
    _toolResults: ToolResult[],
  ): Promise<string> {
    // TODO (AI Sprint 1): langfuseClient.trace({ agentId, sessionId, ... });
    // return the trace ID.
    return `stub-trace-${this.agentId}-${this.sessionId}-${Date.now()}`;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------
  /**
   * Handle one conversation turn.
   *
   * This is the top-level entry point called by the HTTP handler or the
   * LiveKit Agent worker. It orchestrates the full §14.3.2 lifecycle.
   *
   * AI Sprint 0: throws NotImplementedError — the lifecycle stubs are
   * present for the smoke test to confirm construction succeeds, but the
   * end-to-end path is wired in AI Sprint 1.
   */
  async handle(_input: HandleInput): Promise<HandleOutput> {
    // TODO (AI Sprint 1): orchestrate the full lifecycle:
    //   const config = await this.loadConfig();
    //   const history = await this.hydrateMemory();
    //   const response = await this.callGateway(systemPrompt, history, input.message);
    //   const validCalls = this.validateToolCalls(response.toolCalls);
    //   const toolResults = await Promise.all(validCalls.map(call =>
    //     tool.approvalThreshold === 'single-human'
    //       ? this.waitForApproval(call)
    //       : this.dispatchTool(call)
    //   ));
    //   const traceId = await this.emitTrace(response, toolResults);
    //   return { response: response.text, awaitedApproval: false, traceId };
    throw new Error(
      `AgentRuntime.handle() not yet implemented — AI Sprint 1. ` +
        `Agent: ${this.agentId}, Session: ${this.sessionId}`,
    );
  }
}
