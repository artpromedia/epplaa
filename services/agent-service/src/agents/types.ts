/**
 * Shared type definitions for agent configuration.
 * @see §14.4 (Agent Configuration Schema)
 */

export interface MemoryProfile {
  shortTerm: boolean;
  longTerm: boolean;
}

export interface ModelPolicy {
  /** LiteLLM model identifier (e.g., "anthropic/claude-3-5-sonnet-20241022") */
  primary: string;
  /** LiteLLM model identifier for fallback (e.g., "openai/gpt-4o") */
  fallback?: string | undefined;
  maxTokens: number;
  temperature: number;
}

export interface BudgetPolicy {
  /** Hard daily USD cap enforced by LiteLLM gateway. */
  dailyUsdCap: number;
  /** Threshold at which a PagerDuty alert is sent (must be < dailyUsdCap). */
  alertThresholdUsd: number;
}

export interface SloMetadata {
  /** p95 response time target in milliseconds. */
  p95ResponseMs: number;
  /** Human-readable SLO description. */
  description: string;
}

/**
 * Complete agent configuration object.
 * @see §14.4 (Agent Configuration Schema)
 */
export interface AgentConfig {
  /** Unique agent identifier — must match the file name in src/agents/. */
  id: string;
  displayName: string;
  /** Versioned prompt key resolved by PromptRegistry. */
  promptRef: string;
  /** Tool names from ToolRegistry that this agent is permitted to call. */
  tools: string[];
  memoryProfile: MemoryProfile;
  modelPolicy: ModelPolicy;
  budgetPolicy: BudgetPolicy;
  slo: SloMetadata;
}
