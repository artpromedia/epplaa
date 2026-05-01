/**
 * Static AgentRegistry — maps agent IDs to their AgentConfig.
 *
 * Implementations may swap this out for a DB-backed registry once
 * dynamic agent provisioning is needed. AI Sprint 1 keeps it static.
 */

import type { AgentConfig } from "../agents/types.js";
import { buyerConciergeAgent } from "../agents/buyer-concierge.js";
import { sellerCopilotAgent } from "../agents/seller-copilot.js";
import { vendorOnboardingAgent } from "../agents/vendor-onboarding.js";
import { fraudCounterfeitAgent } from "../agents/fraud-counterfeit.js";
import { opsOncallAgent } from "../agents/ops-oncall.js";

const REGISTRY = new Map<string, AgentConfig>([
  [buyerConciergeAgent.id, buyerConciergeAgent],
  [sellerCopilotAgent.id, sellerCopilotAgent],
  [vendorOnboardingAgent.id, vendorOnboardingAgent],
  [fraudCounterfeitAgent.id, fraudCounterfeitAgent],
  [opsOncallAgent.id, opsOncallAgent],
]);

export interface IAgentRegistry {
  get(id: string): AgentConfig | undefined;
  list(): AgentConfig[];
}

export class StaticAgentRegistry implements IAgentRegistry {
  get(id: string): AgentConfig | undefined {
    return REGISTRY.get(id);
  }
  list(): AgentConfig[] {
    return [...REGISTRY.values()];
  }
}
