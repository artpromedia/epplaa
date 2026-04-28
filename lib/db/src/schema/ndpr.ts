import { pgTable, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";

/**
 * NDPR data-subject requests: export, erase, rectify, restrict, portability.
 * Erase requests honour a 30-day grace window before the retention engine
 * actually purges PII, so a user can cancel by mistake.
 */
export const ndprRequestsTable = pgTable(
  "ndpr_requests",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    /** "export" | "erase" | "rectify" | "restrict" | "portability" */
    kind: text("kind").notNull(),
    /** "pending" | "ready" | "completed" | "cancelled" | "failed" */
    status: text("status").notNull().default("pending"),
    /** Body submitted with the request (rectify field patches, restrict scope). */
    requestBody: jsonb("request_body").$type<Record<string, unknown>>().notNull().default({}),
    /** Bundle assembly result (export/portability) — large JSON. */
    bundlePayload: jsonb("bundle_payload").$type<Record<string, unknown> | null>().default(null),
    /** Public token enabling owner download once ready. */
    bundleToken: text("bundle_token"),
    /** Earliest moment an erase request becomes irrevocable. */
    effectiveAt: timestamp("effective_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    failureReason: text("failure_reason").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ndpr_user_idx").on(t.userId, t.createdAt),
    index("ndpr_kind_status_idx").on(t.kind, t.status),
  ],
);

export type NdprRequest = typeof ndprRequestsTable.$inferSelect;
