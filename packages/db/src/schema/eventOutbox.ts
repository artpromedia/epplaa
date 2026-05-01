/**
 * Re-export of `event_outbox` from @workspace/events so Drizzle picks it
 * up during migration generation. The canonical definition lives in
 * packages/events so consumers (the outbox worker) can import the table
 * without taking a transitive dep on every other db schema file.
 */

export { eventOutboxTable } from "@workspace/events/schema";
export type { EventOutboxRow } from "@workspace/events/schema";
