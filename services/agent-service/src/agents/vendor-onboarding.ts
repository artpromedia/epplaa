/**
 * Vendor Onboarding Agent configuration.
 * @see §14.2 (Agent Definitions — Vendor Onboarding Agent)
 * @see §14.4 (Agent Configuration Schema)
 */

import type { AgentConfig } from "./types.js";

export const vendorOnboardingAgent: AgentConfig = {
  id: "vendor-onboarding",
  displayName: "Vendor Onboarding Agent",
  promptRef: "prompts/vendor-onboarding/v1",
  tools: [
    "catalog.search",
    "catalog.create_draft",
    "runbook.search",
    "escalation.handoff_to_human",
  ],
  memoryProfile: {
    shortTerm: true,  // session context
    longTerm: true,   // vendor profile embeddings
  },
  modelPolicy: {
    primary: "anthropic/claude-3-5-sonnet-20241022",
    fallback: "openai/gpt-4o",
    maxTokens: 2048,
    temperature: 0.2,
  },
  budgetPolicy: {
    dailyUsdCap: 50,
    alertThresholdUsd: 40,
  },
  slo: {
    p95ResponseMs: 3000,
    description: "p95 response < 3 s; resolution rate ≥ 70% without escalation",
  },
};
