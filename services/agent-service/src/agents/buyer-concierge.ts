/**
 * Buyer Concierge Agent configuration.
 * @see §14.2 (Agent Definitions — Buyer Concierge Agent)
 * @see §14.4 (Agent Configuration Schema)
 */

import type { AgentConfig } from "./types.js";

export const buyerConciergeAgent: AgentConfig = {
  id: "buyer-concierge",
  displayName: "Buyer Concierge Agent",
  promptRef: "prompts/buyer-concierge/v1",
  tools: [
    "catalog.search",
    "order.read",
    "order.return_request",
    "payment.refund_request",
    "escalation.handoff_to_human",
  ],
  memoryProfile: {
    shortTerm: true,  // conversation context
    longTerm: true,   // order history embeddings
  },
  modelPolicy: {
    primary: "anthropic/claude-3-5-sonnet-20241022",
    fallback: "openai/gpt-4o-mini",  // cost-optimised for FAQ
    maxTokens: 1024,
    temperature: 0.1,
  },
  budgetPolicy: {
    dailyUsdCap: 100,
    alertThresholdUsd: 80,
  },
  slo: {
    p95ResponseMs: 2000,
    description: "p95 response < 2 s; CSAT ≥ 4.2/5",
  },
};
