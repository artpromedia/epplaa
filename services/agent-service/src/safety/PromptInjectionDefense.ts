/**
 * PromptInjectionDefense — layered defense against prompt injection attacks.
 *
 * @see §14.9.1 (Prompt Injection Defense)
 *
 * Implements six defense layers:
 *   1. Structural delimiters
 *   2. Output schema validation (Zod)
 *   3. Scope enforcement (tool-set check)
 *   4. Untrusted-content classifier hook
 *   5. Behavioural monitoring hook
 *   6. Multi-model voting hook
 *
 * AI Sprint 0: all hooks are stubs. Real implementations added per the
 * AI Sprint 8 hardening milestone.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// 1. Structural delimiters
// ---------------------------------------------------------------------------

/**
 * Wraps user content in structural XML delimiters so the LLM can
 * distinguish user-supplied text from the system prompt.
 *
 * @see §14.9.1 — Defense layer 1
 */
export function wrapUserContent(userInput: string): string {
  return `<user_input>\n${userInput}\n</user_input>`;
}

/**
 * Wraps the system prompt in structural XML delimiters.
 *
 * @see §14.9.1 — Defense layer 1
 */
export function wrapSystemPrompt(systemPrompt: string): string {
  return `<system>\n${systemPrompt}\n</system>`;
}

// ---------------------------------------------------------------------------
// 2. Output schema validation
// ---------------------------------------------------------------------------

/**
 * Validates an agent response against the expected Zod output schema.
 * Returns the parsed value or throws a ZodError.
 *
 * @see §14.9.1 — Defense layer 2
 */
export function validateOutput<T extends z.ZodTypeAny>(
  schema: T,
  rawOutput: unknown,
): z.infer<T> {
  return schema.parse(rawOutput);
}

// ---------------------------------------------------------------------------
// 3. Scope enforcement
// ---------------------------------------------------------------------------

export interface ScopeEnforcementResult {
  allowed: string[];
  rejected: string[];
}

/**
 * Filters a list of proposed tool call names against the agent's declared
 * tool-set. Returns allowed and rejected sets.
 *
 * @see §14.9.1 — Defense layer 3
 */
export function enforceScope(
  proposedToolNames: string[],
  agentToolSet: string[],
): ScopeEnforcementResult {
  const allowedSet = new Set(agentToolSet);
  const allowed: string[] = [];
  const rejected: string[] = [];
  for (const name of proposedToolNames) {
    if (allowedSet.has(name)) {
      allowed.push(name);
    } else {
      rejected.push(name);
    }
  }
  return { allowed, rejected };
}

// ---------------------------------------------------------------------------
// 4. Untrusted-content classifier hook (stub)
// ---------------------------------------------------------------------------

export interface ClassifierResult {
  isSafe: boolean;
  /** Confidence score 0–1. Threshold for alerting: < 0.8. */
  confidence: number;
  /** Reason for classification (for audit log). */
  reason: string;
}

/**
 * Scores user input for injection patterns using a fast classifier model.
 * Default: Claude Haiku via LiteLLM.
 *
 * TODO (AI Sprint 8): implement real classifier call.
 * @see §14.9.1 — Defense layer 4
 */
export async function classifyUserInput(
  _userInput: string,
): Promise<ClassifierResult> {
  // TODO (AI Sprint 8): call LiteLLM with a fast classifier prompt;
  // return isSafe: false if confidence < 0.8.
  return { isSafe: true, confidence: 1.0, reason: "stub — always safe" };
}

// ---------------------------------------------------------------------------
// 5. Behavioural monitoring hook (stub)
// ---------------------------------------------------------------------------

export interface BehaviourMonitorResult {
  anomalous: boolean;
  /** Description of the anomaly (for Langfuse trace). */
  description?: string | undefined;
}

/**
 * Checks whether the tool-call sequence in a turn is consistent with the
 * agent's declared purpose. Powered by a Langfuse eval job in production.
 *
 * TODO (AI Sprint 8): implement real behavioural monitoring.
 * @see §14.9.1 — Defense layer 5
 */
export async function monitorBehaviour(
  _agentId: string,
  _toolCallNames: string[],
): Promise<BehaviourMonitorResult> {
  // TODO (AI Sprint 8): cross-reference toolCallNames with the agent's
  // historical tool-call distribution; flag unusual sequences.
  return { anomalous: false };
}

// ---------------------------------------------------------------------------
// 6. Multi-model voting hook (stub)
// ---------------------------------------------------------------------------

export interface VotingResult {
  /** true if the majority of models agree the action is safe. */
  approved: boolean;
  votes: Array<{ model: string; vote: "approve" | "reject"; reason: string }>;
}

/**
 * For high-stakes decisions (payment, takedown), asks a second model to
 * independently evaluate the proposed tool call before dispatch.
 *
 * TODO (AI Sprint 8): implement for listing.auto_takedown and
 * payment.refund_request.
 * @see §14.9.1 — Defense layer 6
 */
export async function multiModelVote(
  _toolName: string,
  _toolArgs: unknown,
  _context: string,
): Promise<VotingResult> {
  // TODO (AI Sprint 8): call the secondary model with a structured
  // evaluation prompt; compare results; return majority vote.
  return {
    approved: true,
    votes: [{ model: "stub", vote: "approve", reason: "stub — always approve" }],
  };
}
