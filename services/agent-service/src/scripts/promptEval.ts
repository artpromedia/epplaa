#!/usr/bin/env node
/**
 * prompt-eval CLI — Wave 4 slice 7.
 *
 * Usage:
 *   pnpm --filter @workspace/agent-service eval -- \
 *     --prompt path/to/prompt.txt \
 *     --golden golden/buyer-concierge.json \
 *     [--agent buyer-concierge] [--stub]
 *
 * In --stub mode the CLI uses a deterministic echo runner so the
 * harness is exercisable in CI without provider creds. In real mode
 * it builds a LiteLLM-backed gateway via composition.buildDeps and
 * routes the eval through it. Exits 0 on green, 1 on any failure.
 */

import { readFileSync } from "node:fs";
import { evaluatePrompt, formatReport, type PromptEvalCase, type PromptEvalRunner } from "../lib/promptEvaluator.js";
import { gatewayPromptRunner } from "../lib/gatewayPromptRunner.js";
import { promptEvalGoldenSchema as goldenSchema } from "../lib/promptEvalSchema.js";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a || !a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

/**
 * Stub runner — deterministic, no LLM. Useful for harness self-tests
 * and to verify golden JSON shape in CI before touching providers.
 * Strategy: echo the user message + prompt fingerprint. Each case in
 * the buyer-concierge golden was authored to assert shape rather than
 * semantics so this stub is enough to demonstrate green-on-success.
 */
function stubRunner(): PromptEvalRunner {
  return async ({ prompt, message }) => {
    const lower = message.toLowerCase();
    let text = "I will help you with your request.";
    if (lower.includes("order")) text += " Let me look up your order.";
    if (lower.includes("credit card") || lower.includes("card")) {
      text = "I cannot share payment card details.";
    }
    if (lower.includes("sue") || lower.includes("lawyer")) {
      text = "Let me escalate this to a human agent for review.";
    }
    return { text: `${text} [prompt:${prompt.length}b]`, latencyMs: 5 };
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const promptPath = typeof args.prompt === "string" ? args.prompt : undefined;
  const goldenPath = typeof args.golden === "string" ? args.golden : undefined;
  const useStub = args.stub === true;
  const agentOverride = typeof args.agent === "string" ? args.agent : undefined;

  if (!promptPath || !goldenPath) {
    console.error("usage: prompt-eval --prompt <file> --golden <file> [--agent <id>] [--stub]");
    process.exit(2);
  }

  const prompt = readFileSync(promptPath, "utf8");
  const goldenRaw = JSON.parse(readFileSync(goldenPath, "utf8"));
  const golden = goldenSchema.parse(goldenRaw);
  const agentId = agentOverride ?? golden.agent;

  let runner: PromptEvalRunner;
  if (useStub) {
    runner = stubRunner();
  } else {
    // Real-runner mode requires the LiteLLM gateway. We import lazily so
    // --stub mode never reaches into composition (which spins up Redis,
    // Kafka, Postgres connections).
    const { buildDeps } = await import("../composition.js");
    const deps = await buildDeps();
    runner = gatewayPromptRunner(deps.gateway, { agentId });
    process.on("exit", () => {
      void deps.shutdown();
    });
  }

  const cases: PromptEvalCase[] = golden.cases;
  const report = await evaluatePrompt({ prompt, cases, runner });
  console.log(formatReport(report));
  process.exit(report.passed ? 0 : 1);
}

main().catch((err) => {
  console.error("prompt-eval crashed:", (err as Error).message);
  process.exit(2);
});
