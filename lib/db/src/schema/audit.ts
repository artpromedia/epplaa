import { pgTable, text, bigserial, timestamp, jsonb, boolean, index } from "drizzle-orm/pg-core";

/**
 * Append-only audit log with hash chaining.
 * Each row carries `prevHash` (sha256 of the prior row's `rowHash`) and
 * `rowHash` (sha256 of `prevHash || canonicalJSON(payload metadata)`).
 * Tampering with any historic row breaks the chain — verifiable offline.
 *
 * Retention: 7 years (per FIRS / NDPR financial-record rules). The retention
 * job in lib/retention.ts therefore *never* deletes rows from this table.
 */
export const auditEventsTable = pgTable(
  "audit_events",
  {
    /** Monotonic ordering key — required for hash chain consistency. */
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    /** Clerk user id of the actor (null for system / cron actions). */
    actorId: text("actor_id"),
    /** Stable verb describing the action ("seller.apply", "ndpr.export", etc.). */
    action: text("action").notNull(),
    /** Entity kind ("user", "order", "payout", "kyc_document", ...). */
    entity: text("entity").notNull(),
    /** Entity id (free-form). */
    entityId: text("entity_id").notNull().default(""),
    /** True when this event corresponds to a PII read (export bundle, admin lookup, etc.). */
    piiRead: boolean("pii_read").notNull().default(false),
    /** Sanitized request payload + outcome metadata. PII is scrubbed by recordAudit(). */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    /** sha256(prevHash || rowHashContent) — the chain link. */
    prevHash: text("prev_hash").notNull().default(""),
    rowHash: text("row_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_actor_idx").on(t.actorId, t.createdAt),
    index("audit_entity_idx").on(t.entity, t.entityId, t.createdAt),
    index("audit_action_idx").on(t.action, t.createdAt),
  ],
);

export type AuditEvent = typeof auditEventsTable.$inferSelect;
