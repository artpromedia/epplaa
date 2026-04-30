/**
 * PromptRegistry — versioned prompt loading interface and in-memory stub.
 *
 * @see §14.6 (Prompt Registry)
 *
 * AI Sprint 0: in-memory stub only. The DB-backed implementation (with
 * version pointers and rollback support) is delivered in AI Sprint 1.
 */

export interface PromptVersion {
  /** e.g., "vendor-onboarding/v1" */
  ref: string;
  /** System prompt content (never hardcoded in agent code). */
  systemPrompt: string;
  /** ISO-8601 timestamp when this version was activated. */
  activatedAt: string;
}

/**
 * Interface that production implementations must satisfy.
 */
export interface IPromptRegistry {
  /**
   * Load the active version of a prompt by its ref.
   * @throws if the ref is not found.
   */
  load(ref: string): Promise<PromptVersion>;

  /**
   * List all known prompt refs and their active versions.
   */
  list(): Promise<PromptVersion[]>;
}

// ---------------------------------------------------------------------------
// In-memory stub (AI Sprint 0)
// ---------------------------------------------------------------------------

const STUB_PROMPTS: Record<string, PromptVersion> = {
  "prompts/vendor-onboarding/v1": {
    ref: "prompts/vendor-onboarding/v1",
    systemPrompt:
      "<!-- TODO (AI Sprint 1): real prompt content goes here after PR review -->",
    activatedAt: "2026-04-30T00:00:00Z",
  },
  "prompts/seller-copilot/v1": {
    ref: "prompts/seller-copilot/v1",
    systemPrompt:
      "<!-- TODO (AI Sprint 1): real prompt content goes here after PR review -->",
    activatedAt: "2026-04-30T00:00:00Z",
  },
  "prompts/buyer-concierge/v1": {
    ref: "prompts/buyer-concierge/v1",
    systemPrompt:
      "<!-- TODO (AI Sprint 1): real prompt content goes here after PR review -->",
    activatedAt: "2026-04-30T00:00:00Z",
  },
  "prompts/fraud-counterfeit/v1": {
    ref: "prompts/fraud-counterfeit/v1",
    systemPrompt:
      "<!-- TODO (AI Sprint 1): real prompt content goes here after PR review -->",
    activatedAt: "2026-04-30T00:00:00Z",
  },
  "prompts/ops-oncall/v1": {
    ref: "prompts/ops-oncall/v1",
    systemPrompt:
      "<!-- TODO (AI Sprint 1): real prompt content goes here after PR review -->",
    activatedAt: "2026-04-30T00:00:00Z",
  },
};

export class InMemoryPromptRegistry implements IPromptRegistry {
  async load(ref: string): Promise<PromptVersion> {
    const prompt = STUB_PROMPTS[ref];
    if (!prompt) {
      throw new Error(
        `PromptRegistry: unknown ref '${ref}'. ` +
          `Known refs: ${Object.keys(STUB_PROMPTS).join(", ")}`,
      );
    }
    return prompt;
  }

  async list(): Promise<PromptVersion[]> {
    return Object.values(STUB_PROMPTS);
  }
}
