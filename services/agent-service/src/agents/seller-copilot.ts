/**
 * Seller Copilot Agent configuration.
 * @see §14.2 (Agent Definitions — Seller Copilot Agent)
 * @see §14.4 (Agent Configuration Schema)
 */

import type { AgentConfig } from "./types.js";

export const sellerCopilotAgent: AgentConfig = {
  id: "seller-copilot",
  displayName: "Seller Copilot Agent",
  promptRef: "prompts/seller-copilot/v1",
  tools: [
    "catalog.search",
    "catalog.create_draft",
    "order.read",
    "order.create_draft",
    "runbook.search",
    "escalation.handoff_to_human",
  ],
  memoryProfile: {
    shortTerm: true,  // active session
    longTerm: true,   // seller behaviour patterns
  },
  modelPolicy: {
    primary: "anthropic/claude-3-5-sonnet-20241022",
    fallback: "openai/gpt-4o",
    maxTokens: 2048,
    temperature: 0.2,
  },
  budgetPolicy: {
    dailyUsdCap: 75,
    alertThresholdUsd: 60,
  },
  slo: {
    p95ResponseMs: 2000,
    description: "p95 response < 2 s",
  },
};
