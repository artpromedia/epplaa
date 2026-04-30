/**
 * ModelGateway — interface for the LiteLLM-backed multi-provider gateway.
 *
 * @see §14.5 (Model Gateway)
 * @see ADR-011 (Anthropic primary, OpenAI secondary, LiteLLM proxy)
 *
 * AI Sprint 0: interface and stub only. Real LiteLLM HTTP client wired
 * in AI Sprint 1.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Tool call ID — required when role is 'tool'. */
  toolCallId?: string | undefined;
}

export interface ToolCallRequest {
  /** Matches ToolDescriptor.name. */
  name: string;
  /** Parsed arguments (validated by ToolRegistry before dispatch). */
  args: unknown;
  /** LLM-generated call ID. */
  callId: string;
}

export interface ModelResponse {
  /** The model's text response (may be empty if the model only made tool calls). */
  text: string;
  /** Tool calls requested by the model. May be empty. */
  toolCalls: ToolCallRequest[];
  /** Model identifier returned by LiteLLM (e.g. "claude-3-5-sonnet-20241022"). */
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** Latency in milliseconds as measured by the gateway client. */
  latencyMs: number;
}

export interface GatewayCompleteOptions {
  /** Must match an agent ID for budget enforcement. */
  agentId: string;
  /** Session ID for Langfuse trace correlation. */
  sessionId: string;
  messages: Message[];
  /** Tool names available for this request (subset of ToolRegistry). */
  availableTools: string[];
  /** LiteLLM model identifier (e.g., "anthropic/claude-3-5-sonnet-20241022"). */
  model: string;
  maxTokens: number;
  temperature: number;
}

/**
 * Interface that production implementations must satisfy.
 * @see §14.5 (Model Gateway)
 */
export interface IModelGateway {
  /**
   * Send a completion request to the LiteLLM proxy.
   * Implements:
   *   - Per-agent budget enforcement (tracked in LiteLLM spend DB)
   *   - Provider failover (primary → fallback on 5xx)
   *   - Fail-safe: returns a scripted safe response on total gateway failure
   */
  complete(options: GatewayCompleteOptions): Promise<ModelResponse>;
}

// ---------------------------------------------------------------------------
// Stub implementation (AI Sprint 0)
// ---------------------------------------------------------------------------

export class StubModelGateway implements IModelGateway {
  async complete(_options: GatewayCompleteOptions): Promise<ModelResponse> {
    // TODO (AI Sprint 1): replace with real LiteLLM HTTP client call.
    // The LiteLLM proxy is at process.env.LITELLM_BASE_URL (FSN1).
    throw new Error(
      "StubModelGateway.complete() not yet implemented — AI Sprint 1. " +
        "Install and configure the LiteLLM proxy before wiring this gateway.",
    );
  }
}
