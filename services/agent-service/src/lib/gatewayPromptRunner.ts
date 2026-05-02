/**
 * Adapter: turn an IModelGateway into a PromptEvalRunner.
 *
 * Used by the prompt-eval CLI / activation gate to drive a real LLM
 * against a candidate prompt without re-implementing message
 * construction. Tests use the stub runner instead so they don't need
 * provider credentials.
 */

import type { IModelGateway } from "../gateway/ModelGateway.js";
import type { PromptEvalRunner } from "./promptEvaluator.js";

export interface GatewayRunnerOptions {
  agentId: string;
  /** Default: "anthropic/claude-3-5-sonnet-20241022" */
  model?: string;
  /** Default: 1024 */
  maxTokens?: number;
  /** Default: 0.1 */
  temperature?: number;
}

export function gatewayPromptRunner(
  gateway: IModelGateway,
  opts: GatewayRunnerOptions,
): PromptEvalRunner {
  return async ({ prompt, message }) => {
    const response = await gateway.complete({
      agentId: opts.agentId,
      sessionId: `prompt-eval-${Date.now()}`,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: message },
      ],
      availableTools: [], // eval mode — no tool calls
      model: opts.model ?? "anthropic/claude-3-5-sonnet-20241022",
      maxTokens: opts.maxTokens ?? 1024,
      temperature: opts.temperature ?? 0.1,
    });
    return { text: response.text, latencyMs: response.latencyMs };
  };
}
