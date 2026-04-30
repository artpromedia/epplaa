/**
 * Ops On-Call Agent configuration.
 * @see §14.2 (Agent Definitions — Ops On-Call Agent)
 * @see §14.4 (Agent Configuration Schema)
 */

import type { AgentConfig } from "./types.js";

export const opsOncallAgent: AgentConfig = {
  id: "ops-oncall",
  displayName: "Ops On-Call Agent",
  promptRef: "prompts/ops-oncall/v1",
  tools: [
    "runbook.search",
    "escalation.handoff_to_human",
    "stream.suggest_pin",
  ],
  memoryProfile: {
    shortTerm: true,  // incident session context
    longTerm: false,  // runbooks are in long-term memory via pgvector
  },
  modelPolicy: {
    primary: "anthropic/claude-3-5-sonnet-20241022",
    fallback: "openai/gpt-4o",
    maxTokens: 2048,
    temperature: 0.1,  // low latency requires deterministic, focused responses
  },
  budgetPolicy: {
    dailyUsdCap: 20,
    alertThresholdUsd: 16,
  },
  slo: {
    p95ResponseMs: 1500,
    description: "p95 response < 1.5 s (on-call latency is critical)",
  },
};
