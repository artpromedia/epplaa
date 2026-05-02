/**
 * KafkaApprovalBus tests — using a hand-rolled fake kafkajs to avoid a
 * Redpanda dependency in CI.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Kafka } from "kafkajs";
import {
  KafkaApprovalBus,
  PROPOSED_ACTION_TOPIC,
  ACTION_APPROVED_TOPIC,
  ACTION_REJECTED_TOPIC,
} from "../approval/KafkaApprovalBus.js";
import type {
  ApprovalResponseEvent,
  ProposedActionEvent,
} from "../approval/ApprovalBus.js";

interface FakeMessage {
  topic: string;
  message: { value: Buffer; key?: Buffer; headers?: Record<string, Buffer> };
}

interface FakeConsumerHandlers {
  eachMessage?: (m: FakeMessage) => Promise<void>;
}

class FakeKafka {
  public producedRecords: { topic: string; messages: { key?: Buffer | string; value?: string; headers?: Record<string, string> }[] }[] = [];
  private consumerHandlers: FakeConsumerHandlers = {};
  private subscribedTopics: string[] = [];

  producer() {
    return {
      connect: async () => undefined,
      disconnect: async () => undefined,
      send: async (record: { topic: string; messages: { key?: string; value?: string; headers?: Record<string, string> }[] }) => {
        this.producedRecords.push(record);
        return [];
      },
    };
  }

  consumer() {
    return {
      connect: async () => undefined,
      disconnect: async () => undefined,
      subscribe: async ({ topics }: { topics: string[] }) => {
        this.subscribedTopics = topics;
      },
      run: async (handlers: FakeConsumerHandlers) => {
        this.consumerHandlers = handlers;
      },
    };
  }

  /** Test helper — simulate a response message arriving from the broker. */
  async deliver(topic: string, payload: ApprovalResponseEvent): Promise<void> {
    if (!this.subscribedTopics.includes(topic)) {
      throw new Error(`Test consumer not subscribed to ${topic}`);
    }
    await this.consumerHandlers.eachMessage?.({
      topic,
      message: { value: Buffer.from(JSON.stringify(payload)) },
    });
  }
}

function buildEvent(overrides: Partial<ProposedActionEvent> = {}): ProposedActionEvent {
  const now = new Date();
  return {
    eventId: "evt-1",
    agentId: "buyer-concierge",
    sessionId: "sess-1",
    tool: "payment.refund_request",
    args: { paymentId: "p1", amountNgn: 1000, reason: "test" },
    requestedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe("KafkaApprovalBus", () => {
  let fake: FakeKafka;
  let bus: KafkaApprovalBus;

  beforeEach(async () => {
    fake = new FakeKafka();
    // Cast: KafkaApprovalBus only uses producer()/consumer() methods.
    bus = new KafkaApprovalBus({ kafka: fake as unknown as Kafka });
    await bus.start();
  });

  it("produces to the proposed-action topic", async () => {
    await bus.produce(buildEvent());
    expect(fake.producedRecords).toHaveLength(1);
    expect(fake.producedRecords[0]!.topic).toBe(PROPOSED_ACTION_TOPIC);
    const payload = JSON.parse(fake.producedRecords[0]!.messages[0]!.value as string) as ProposedActionEvent;
    expect(payload.eventId).toBe("evt-1");
    expect(payload.tool).toBe("payment.refund_request");
  });

  it("resolves awaitDecision when an approval response arrives", async () => {
    const decisionPromise = bus.awaitDecision("evt-1", 5_000);
    expect(bus.pendingCount()).toBe(1);

    await fake.deliver(ACTION_APPROVED_TOPIC, {
      eventId: "evt-1",
      decision: "approved",
      approvedBy: "user_admin_42",
      decidedAt: new Date().toISOString(),
    });

    const decision = await decisionPromise;
    expect(decision.decision).toBe("approved");
    expect(decision.approvedBy).toBe("user_admin_42");
    expect(bus.pendingCount()).toBe(0);
  });

  it("resolves awaitDecision with rejection when message arrives on rejected topic", async () => {
    const decisionPromise = bus.awaitDecision("evt-2", 5_000);

    await fake.deliver(ACTION_REJECTED_TOPIC, {
      eventId: "evt-2",
      // Even if producer set "approved", the topic is authoritative.
      decision: "approved",
      approvedBy: "user_admin_42",
      decidedAt: new Date().toISOString(),
      note: "policy violation",
    });

    const decision = await decisionPromise;
    expect(decision.decision).toBe("rejected");
    expect(decision.note).toBe("policy violation");
  });

  it("times out and rejects pending awaits", async () => {
    vi.useFakeTimers();
    const promise = bus.awaitDecision("evt-3", 100);
    // Pre-attach the rejection handler so vitest doesn't see an unhandled
    // rejection when the fake timer fires synchronously.
    const captured = promise.catch((err: Error) => err);
    await vi.advanceTimersByTimeAsync(150);
    const err = await captured;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Approval timeout/);
    expect(bus.pendingCount()).toBe(0);
    vi.useRealTimers();
  });

  it("ignores messages with no matching pending await", async () => {
    // No await registered; deliver should not throw.
    await fake.deliver(ACTION_APPROVED_TOPIC, {
      eventId: "evt-unknown",
      decision: "approved",
      approvedBy: "user_admin",
      decidedAt: new Date().toISOString(),
    });
    expect(bus.pendingCount()).toBe(0);
  });

  it("rejects double-await on the same eventId", async () => {
    void bus.awaitDecision("evt-dup", 5_000).catch(() => undefined);
    await expect(bus.awaitDecision("evt-dup", 5_000)).rejects.toThrow(/Already awaiting/);
  });

  it("rejects in-flight awaits when stop() is called", async () => {
    const promise = bus.awaitDecision("evt-stop", 60_000);
    await bus.stop();
    await expect(promise).rejects.toThrow(/stopped before decision/);
  });

  it("throws when produce/awaitDecision are called before start()", async () => {
    const fresh = new KafkaApprovalBus({ kafka: new FakeKafka() as unknown as Kafka });
    await expect(fresh.produce(buildEvent())).rejects.toThrow(/before start/);
    await expect(fresh.awaitDecision("x")).rejects.toThrow(/before start/);
  });
});
