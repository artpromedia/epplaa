/**
 * KafkaApprovalBus — kafkajs-backed implementation of IApprovalBus.
 *
 * @see §14.7.3 (Approval Bus)
 * @see ADR-006 (event backbone — Redpanda)
 * @see ADR-014 (autonomy ceiling — single-human approval for money/account/messaging)
 *
 * Topics:
 *   agent.proposed_action          — produced by this service
 *   agent.action_approved          — consumed
 *   agent.action_rejected          — consumed
 *
 * Decision-correlation strategy: one long-running consumer subscribes to
 * the response topics on startup. `awaitDecision(eventId)` registers a
 * resolver on an in-memory map; the consumer dispatches incoming records
 * to the matching resolver and rejects pending awaits on timeout. This
 * means a single agent-service replica owns awaits for actions it
 * produced; if the replica restarts before approval lands, the operator
 * can re-issue the action (idempotent on the proposed-action eventId).
 *
 * Kafka client config is intentionally minimal — production deployment
 * sets brokers, ssl, sasl via env (KAFKA_BROKERS, KAFKA_SSL,
 * KAFKA_SASL_MECHANISM, KAFKA_SASL_USERNAME, KAFKA_SASL_PASSWORD).
 */

import type { Kafka, Consumer, Producer } from "kafkajs";
import { logger } from "../lib/observability.js";
import type {
  ApprovalResponseEvent,
  IApprovalBus,
  ProposedActionEvent,
} from "./ApprovalBus.js";

export const PROPOSED_ACTION_TOPIC = "agent.proposed_action";
export const ACTION_APPROVED_TOPIC = "agent.action_approved";
export const ACTION_REJECTED_TOPIC = "agent.action_rejected";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

interface PendingDecision {
  resolve: (event: ApprovalResponseEvent) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface KafkaApprovalBusOptions {
  kafka: Kafka;
  /** Consumer group ID — defaults to `agent-service-approvals`. */
  groupId?: string;
}

export class KafkaApprovalBus implements IApprovalBus {
  private readonly producer: Producer;
  private readonly consumer: Consumer;
  private readonly pending = new Map<string, PendingDecision>();
  private started = false;

  constructor(opts: KafkaApprovalBusOptions) {
    this.producer = opts.kafka.producer({ allowAutoTopicCreation: false });
    this.consumer = opts.kafka.consumer({
      groupId: opts.groupId ?? "agent-service-approvals",
      // Fetch responses immediately; approvals are low volume but
      // latency-sensitive (operator clicks "approve").
      maxWaitTimeInMs: 100,
    });
  }

  /**
   * Connect producer + consumer and start dispatching responses.
   * Idempotent.
   */
  async start(): Promise<void> {
    if (this.started) return;
    await this.producer.connect();
    await this.consumer.connect();
    await this.consumer.subscribe({
      topics: [ACTION_APPROVED_TOPIC, ACTION_REJECTED_TOPIC],
      fromBeginning: false,
    });
    await this.consumer.run({
      eachMessage: async ({ topic, message }) => {
        if (!message.value) return;
        let event: ApprovalResponseEvent;
        try {
          event = JSON.parse(message.value.toString()) as ApprovalResponseEvent;
        } catch (err) {
          logger.warn(
            { err: (err as Error).message, topic },
            "approval_bus_invalid_payload",
          );
          return;
        }
        const decision = topic === ACTION_APPROVED_TOPIC ? "approved" : "rejected";
        // Coerce decision in case producer omitted it; topic is authoritative.
        event.decision = decision;
        const pending = this.pending.get(event.eventId);
        if (!pending) {
          // Either we already timed out, or another replica owns this await.
          return;
        }
        clearTimeout(pending.timer);
        this.pending.delete(event.eventId);
        pending.resolve(event);
      },
    });
    this.started = true;
    logger.info("kafka_approval_bus_started");
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    // Reject any in-flight awaits so callers don't hang forever.
    for (const [eventId, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`KafkaApprovalBus stopped before decision (${eventId})`));
    }
    this.pending.clear();
    await this.consumer.disconnect();
    await this.producer.disconnect();
    this.started = false;
  }

  async produce(event: ProposedActionEvent): Promise<void> {
    if (!this.started) {
      throw new Error("KafkaApprovalBus.produce() called before start()");
    }
    await this.producer.send({
      topic: PROPOSED_ACTION_TOPIC,
      messages: [
        {
          // Partition by agentId so all proposals from one agent stay ordered.
          key: event.agentId,
          // eventId in headers makes it cheap to filter without parsing JSON.
          headers: { eventId: event.eventId },
          value: JSON.stringify(event),
        },
      ],
    });
  }

  async awaitDecision(
    eventId: string,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<ApprovalResponseEvent> {
    if (!this.started) {
      throw new Error("KafkaApprovalBus.awaitDecision() called before start()");
    }
    if (this.pending.has(eventId)) {
      throw new Error(`Already awaiting decision for eventId=${eventId}`);
    }
    return new Promise<ApprovalResponseEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(eventId);
        reject(new Error(`Approval timeout after ${timeoutMs}ms (eventId=${eventId})`));
      }, timeoutMs);
      // Allow the process to exit if this is the only pending op.
      timer.unref?.();
      this.pending.set(eventId, { resolve, reject, timer });
    });
  }

  /** Test seam: count of awaits currently in-flight. */
  pendingCount(): number {
    return this.pending.size;
  }
}
