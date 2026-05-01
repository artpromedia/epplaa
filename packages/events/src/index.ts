/**
 * Public API for @workspace/events.
 *
 * Producers call `publish(tx, ...)` from inside a Drizzle transaction.
 * Consumers register a handler via `registerConsumer(topic, handler)`
 * at module-load time; the worker (./worker.ts) drains the outbox and
 * fans events out.
 *
 * When Redpanda is enabled (env `EVENTS_BROKER=redpanda`), `publish()`
 * still writes to the outbox first, but the worker switches its sink
 * from the in-process registry to a Kafka producer. This is the gate
 * point for ADR-0006.
 */

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { eventOutboxTable, type EventOutboxInsert } from "./schema.js";

export { eventOutboxTable } from "./schema.js";
export type { EventOutboxRow } from "./schema.js";

/**
 * Generic envelope every event flows through. Payload type is parameterised
 * so call sites pass a zod schema and get a typed handler signature.
 */
export const envelopeMetaSchema = z.object({
  eventId: z.string().min(1),
  topic: z.string().min(1),
  aggregateId: z.string().min(1),
  eventType: z.string().min(1),
  occurredAt: z.string().datetime(),
});

export type EnvelopeMeta = z.infer<typeof envelopeMetaSchema>;

export interface PublishInput<T> {
  topic: string;
  aggregateId: string;
  eventType: string;
  payload: T;
  /** Optional headers; useful for trace propagation. */
  headers?: Record<string, string>;
}

/**
 * Inserts an event row inside the caller's transaction. Caller is
 * responsible for committing — that's the point of the outbox pattern.
 *
 * The `tx` parameter is intentionally `unknown` here so we don't pin
 * this package to a specific Drizzle driver version. The runtime check
 * in ../worker.ts uses the same shape.
 */
export async function publish<T>(
  tx: { insert: (table: typeof eventOutboxTable) => { values: (row: EventOutboxInsert) => Promise<unknown> } },
  input: PublishInput<T>,
): Promise<{ eventId: string }> {
  const eventId = randomUUID();
  await tx.insert(eventOutboxTable).values({
    id: eventId,
    topic: input.topic,
    aggregateId: input.aggregateId,
    eventType: input.eventType,
    payload: input.payload as unknown as Record<string, unknown>,
    headers: input.headers ?? {},
    status: "pending",
  });
  return { eventId };
}

// ---------------------------------------------------------------------------
// In-process consumer registry (Redpanda replaces this in Phase E.2).
// ---------------------------------------------------------------------------

export interface ConsumerHandler<T = unknown> {
  (meta: EnvelopeMeta, payload: T): Promise<void>;
}

const registry = new Map<string, ConsumerHandler[]>();

export function registerConsumer<T>(topic: string, handler: ConsumerHandler<T>): void {
  const existing = registry.get(topic);
  if (existing) {
    existing.push(handler as ConsumerHandler);
  } else {
    registry.set(topic, [handler as ConsumerHandler]);
  }
}

export function getRegisteredConsumers(topic: string): ConsumerHandler[] {
  return registry.get(topic) ?? [];
}

/** Test helper — clears the registry between tests. */
export function __resetRegistryForTests(): void {
  registry.clear();
}
