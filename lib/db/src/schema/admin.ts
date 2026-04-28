import { pgTable, text, boolean, timestamp, jsonb, primaryKey, index } from "drizzle-orm/pg-core";

/**
 * Roles & RBAC for the operator console. We keep `text` PKs to match every
 * other table in this project. Default roles (admin / moderator /
 * finance_ops / support) are inserted at boot by `bootstrapRoles()`.
 */
export const rolesTable = pgTable("roles", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const userRolesTable = pgTable(
  "user_roles",
  {
    userId: text("user_id").notNull(),
    roleId: text("role_id").notNull(),
    grantedBy: text("granted_by"),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.roleId] }),
    index("user_roles_user_idx").on(t.userId),
  ],
);

/**
 * Trust & Safety case queue. One row per actionable item across kinds:
 *   - "report"   — opened from a buyer safety report
 *   - "dispute"  — opened from a return entering `disputed`
 *   - "content"  — opened by a moderation provider on image/video/text
 *   - "csam"     — high-priority CSAM match (auto block)
 *   - "kyc"      — KYC review (existing kyc table is the SoT; case is the queue handle)
 *
 * State machine: open → triage → in_review → action → closed
 * `decision` records the operator outcome: approve / hide / ban / refund /
 * deny / partial / escalate / dismiss.
 */
export const moderationCasesTable = pgTable(
  "moderation_cases",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(), // report | dispute | content | csam | kyc
    targetKind: text("target_kind").notNull(), // user | seller | product | stream | message | return | listing | image | video | text
    targetId: text("target_id").notNull(),
    severity: text("severity").notNull().default("normal"), // low | normal | high | critical
    state: text("state").notNull().default("open"), // open | triage | in_review | action | closed
    assignedTo: text("assigned_to"),
    slaDueAt: timestamp("sla_due_at", { withTimezone: true }),
    decision: text("decision"),
    decisionReason: text("decision_reason").notNull().default(""),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: text("decided_by"),
    evidence: jsonb("evidence").notNull().default({}),
    sourceUserId: text("source_user_id"),
    sourceReportId: text("source_report_id"),
    takedownId: text("takedown_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("moderation_cases_state_idx").on(t.state),
    index("moderation_cases_kind_idx").on(t.kind),
    index("moderation_cases_assignee_idx").on(t.assignedTo),
    index("moderation_cases_target_idx").on(t.targetKind, t.targetId),
  ],
);

/**
 * Every moderation provider call (real or stub) is recorded here.
 * `decision` is one of allow / review / block. `csamMatch=true` always
 * forces a block + critical case regardless of generic decision.
 */
export const moderationScansTable = pgTable(
  "moderation_scans",
  {
    id: text("id").primaryKey(),
    targetKind: text("target_kind").notNull(),
    targetId: text("target_id").notNull(),
    provider: text("provider").notNull(),
    decision: text("decision").notNull(),
    scores: jsonb("scores").notNull().default({}),
    csamMatch: boolean("csam_match").notNull().default(false),
    raw: jsonb("raw").notNull().default({}),
    scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("moderation_scans_target_idx").on(t.targetKind, t.targetId),
    index("moderation_scans_scanned_at_idx").on(t.scannedAt),
  ],
);

/**
 * Audit trail of finance_ops actions on payouts (hold / release / clawback /
 * approve). Lives alongside the hash-chained audit log because operators
 * need a fast queryable history per payout — the audit chain is the
 * compliance source-of-truth, this is the operator UX projection.
 */
export const payoutActionsTable = pgTable(
  "payout_actions",
  {
    id: text("id").primaryKey(),
    payoutId: text("payout_id").notNull(),
    action: text("action").notNull(), // hold | release | clawback | approve
    actorUserId: text("actor_user_id").notNull(),
    reason: text("reason").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("payout_actions_payout_idx").on(t.payoutId)],
);

/**
 * Permanent removal record. A takedown is the terminal action when
 * "hide" is escalated to "ban" or a CSAM/safety policy violation is
 * confirmed. `notifiedAt` is set when the affected party is notified.
 */
export const takedownsTable = pgTable(
  "takedowns",
  {
    id: text("id").primaryKey(),
    targetKind: text("target_kind").notNull(),
    targetId: text("target_id").notNull(),
    reasonCode: text("reason_code").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    notes: text("notes").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("takedowns_target_idx").on(t.targetKind, t.targetId)],
);

export type Role = typeof rolesTable.$inferSelect;
export type UserRole = typeof userRolesTable.$inferSelect;
export type ModerationCase = typeof moderationCasesTable.$inferSelect;
export type ModerationScan = typeof moderationScansTable.$inferSelect;
export type PayoutAction = typeof payoutActionsTable.$inferSelect;
export type Takedown = typeof takedownsTable.$inferSelect;
