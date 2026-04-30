/**
 * ApprovalBus — Kafka/Redpanda producer for the agent.proposed_action topic.
 *
 * @see §14.7.3 (Approval Bus)
 * @see ADR-014 (autonomy ceiling — all money/account/messaging actions require approval)
 * @see ADR-006 (event backbone — Redpanda)
 *
 * AI Sprint 0: interface and stub only. Real kafkajs producer wired in
 * AI Sprint 2 (when the Buyer Concierge + Seller Copilot agents go live).
 *
 * Topic: agent.proposed_action
 * Approval response topic: agent.action_approved / agent.action_rejected
 */

export interface ProposedActionEvent {
  /** UUIDv4 — used to correlate the approval response. */
  eventId: string;
  agentId: string;
  sessionId: string;
  /** The tool name from ToolRegistry. */
  tool: string;
  /** The tool's input args (already Zod-validated). */
  args: unknown;
  /** ISO-8601 */
  requestedAt: string;
  /** ISO-8601 — 15 minutes after requestedAt. */
  expiresAt: string;
}

export interface ApprovalResponseEvent {
  eventId: string;
  decision: "approved" | "rejected";
  /** The human operator's Clerk user ID. */
  approvedBy: string;
  /** ISO-8601 */
  decidedAt: string;
  /** Optional note from the operator. */
  note?: string | undefined;
}

export interface IApprovalBus {
  /**
   * Publish a proposed-action event to Redpanda.
   * Returns once the message is acknowledged by the broker.
   */
  produce(event: ProposedActionEvent): Promise<void>;

  /**
   * Subscribe to approval/rejection responses for a specific eventId.
   * Resolves when the decision arrives or rejects on timeout.
   * Timeout: 15 minutes (matches ProposedActionEvent.expiresAt).
   */
  awaitDecision(
    eventId: string,
    timeoutMs?: number,
  ): Promise<ApprovalResponseEvent>;
}

// ---------------------------------------------------------------------------
// Stub implementation (AI Sprint 0)
// ---------------------------------------------------------------------------

export class StubApprovalBus implements IApprovalBus {
  async produce(_event: ProposedActionEvent): Promise<void> {
    // TODO (AI Sprint 2): initialise kafkajs producer;
    // send to topic 'agent.proposed_action'.
    throw new Error(
      "StubApprovalBus.produce() not yet implemented — AI Sprint 2. " +
        "Requires Redpanda (ADR-006) and kafkajs.",
    );
  }

  async awaitDecision(
    _eventId: string,
    _timeoutMs = 15 * 60 * 1000,
  ): Promise<ApprovalResponseEvent> {
    // TODO (AI Sprint 2): subscribe to 'agent.action_approved' and
    // 'agent.action_rejected' topics; filter by eventId; resolve on match
    // or reject on timeout.
    throw new Error(
      "StubApprovalBus.awaitDecision() not yet implemented — AI Sprint 2.",
    );
  }
}
