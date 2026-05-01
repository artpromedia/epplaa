/**
 * LiteLLM-backed implementation of `IModelGateway`.
 *
 * @see ADR-011 (Anthropic primary, OpenAI secondary, LiteLLM proxy)
 * @see §14.5 (Model Gateway)
 *
 * Wire-format target: LiteLLM exposes the OpenAI Chat Completions schema
 * regardless of upstream provider. Per-agent budget enforcement is done
 * server-side by LiteLLM via the `user` field (we set it to the agent
 * ID) — there's no client-side accounting.
 *
 * Failure model:
 *   - Network/5xx → throw `GatewayError` so the caller can decide whether
 *     to retry or fall back to a scripted safe response.
 *   - 429 (rate limit) → throw with `retryable: true`.
 *   - 4xx schema errors → throw without `retryable` flag (config bug).
 */

import type {
  GatewayCompleteOptions,
  IModelGateway,
  Message,
  ModelResponse,
  ToolCallRequest,
} from "./ModelGateway.js";

export class GatewayError extends Error {
  constructor(message: string, readonly retryable: boolean = false) {
    super(message);
    this.name = "GatewayError";
  }
}

interface OpenAIChatRequest {
  model: string;
  messages: { role: string; content: string; tool_call_id?: string }[];
  max_tokens: number;
  temperature: number;
  user: string;
  // LiteLLM accepts the OpenAI tool spec; the agent-service supplies the
  // matching list of {name, description, parameters} entries from the
  // ToolRegistry (see AgentRuntime).
  tools?: { type: "function"; function: { name: string; description: string; parameters: unknown } }[];
}

interface OpenAIChatResponseToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAIChatResponse {
  model: string;
  choices: {
    message: {
      content: string | null;
      tool_calls?: OpenAIChatResponseToolCall[];
    };
  }[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface LiteLLMGatewayOptions {
  baseUrl: string; // e.g. http://litellm.ai-platform:4000
  apiKey: string; // LiteLLM master / virtual key
  fetchImpl?: typeof fetch; // injectable for tests
  /** Per-tool descriptors keyed by tool name; needed to render the OpenAI tools schema. */
  toolDescriptors?: Map<
    string,
    { description: string; parameters: unknown }
  >;
}

export class LiteLLMGateway implements IModelGateway {
  constructor(private readonly opts: LiteLLMGatewayOptions) {}

  async complete(options: GatewayCompleteOptions): Promise<ModelResponse> {
    const fetcher = this.opts.fetchImpl ?? fetch;
    const start = Date.now();

    const body: OpenAIChatRequest = {
      model: options.model,
      messages: options.messages.map((m) => mapMessage(m)),
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      user: options.agentId,
      ...(options.availableTools.length > 0 && this.opts.toolDescriptors
        ? {
            tools: options.availableTools
              .map((name) => {
                const desc = this.opts.toolDescriptors!.get(name);
                return desc
                  ? {
                      type: "function" as const,
                      function: { name, description: desc.description, parameters: desc.parameters },
                    }
                  : null;
              })
              .filter((t): t is NonNullable<typeof t> => t !== null),
          }
        : {}),
    };

    let resp: Response;
    try {
      resp = await fetcher(`${this.opts.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new GatewayError(
        `LiteLLM request failed: ${(err as Error).message}`,
        true,
      );
    }

    if (resp.status === 429) {
      throw new GatewayError("LiteLLM 429: rate limited", true);
    }
    if (resp.status >= 500) {
      throw new GatewayError(`LiteLLM ${resp.status}`, true);
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new GatewayError(`LiteLLM ${resp.status}: ${text}`);
    }

    const data = (await resp.json()) as OpenAIChatResponse;
    const choice = data.choices[0];
    if (!choice) {
      throw new GatewayError("LiteLLM returned no choices");
    }

    const toolCalls: ToolCallRequest[] =
      choice.message.tool_calls?.map((tc) => ({
        name: tc.function.name,
        args: parseJsonArgs(tc.function.arguments),
        callId: tc.id,
      })) ?? [];

    return {
      text: choice.message.content ?? "",
      toolCalls,
      model: data.model,
      usage: {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      },
      latencyMs: Date.now() - start,
    };
  }
}

function mapMessage(m: Message): { role: string; content: string; tool_call_id?: string } {
  if (m.role === "tool") {
    return { role: "tool", content: m.content, tool_call_id: m.toolCallId };
  }
  return { role: m.role, content: m.content };
}

function parseJsonArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
