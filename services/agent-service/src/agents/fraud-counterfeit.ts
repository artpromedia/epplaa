/**
 * Fraud & Counterfeit Agent configuration.
 * @see §14.2 (Agent Definitions — Fraud & Counterfeit Agent)
 * @see §14.4 (Agent Configuration Schema)
 */

import type { AgentConfig } from "./types.js";

export const fraudCounterfeitAgent: AgentConfig = {
  id: "fraud-counterfeit",
  displayName: "Fraud & Counterfeit Agent",
  promptRef: "prompts/fraud-counterfeit/v1",
  tools: [
    "listing.flag_for_review",
    "listing.auto_takedown",
    "escalation.handoff_to_human",
  ],
  memoryProfile: {
    shortTerm: false, // no per-session context needed for fraud detection
    longTerm: true,   // fraud pattern embeddings
  },
  modelPolicy: {
    primary: "anthropic/claude-3-5-sonnet-20241022",
    // No fallback — high accuracy required; prefer failed call over degraded accuracy
    fallback: undefined,
    maxTokens: 1024,
    temperature: 0.0,  // deterministic for fraud classification
  },
  budgetPolicy: {
    dailyUsdCap: 30,
    alertThresholdUsd: 24,
  },
  slo: {
    p95ResponseMs: 5000,
    description: "precision ≥ 90%; false-positive rate < 5%",
  },
};
