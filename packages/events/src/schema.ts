/**
 * Outbox table.
 *
 * The strangler-fig migration (ADR-0001) requires that domain events
 * cross service boundaries reliably even before Redpanda exists. We use
 * the standard transactional-outbox pattern:
 *
 *   1. Domain code calls `publish()` inside the same transaction that
 *      mutates business state.
 *   2. Row is INSERTed into `event_outbox` (status='pending').
 *   3. A background worker (see ./worker.ts) polls pending rows in
 *      created_at order, hands them to in-process consumers, then
 *      flips status to 'delivered'.
 *   4. When the second consumer for a topic appears (the gate trigger
 *      in ADR-0006), the worker switches its sink from "in-process
 *      registry" to "Redpanda producer". Domain code does not change.
 *
 * Idempotency: every event carries a unique `event_id`. Consumers MUST
 * de-duplicate on `event_id` before applying side effects.
 */

import { pgTable, text, timestamp, jsonb, integer, index } from "drizzle-orm/pg-core";

export const eventOutboxTable = pgTable(
  "event_outbox",
  {
    id: text("id").primaryKey(),
    topic: text("topic").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    headers: jsonb("headers"),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (t) => ({
    byStatusCreated: index("event_outbox_status_created_idx").on(t.status, t.createdAt),
    byTopicCreated: index("event_outbox_topic_created_idx").on(t.topic, t.createdAt),
  }),
);

export type EventOutboxRow = typeof eventOutboxTable.$inferSelect;
export type EventOutboxInsert = typeof eventOutboxTable.$inferInsert;
