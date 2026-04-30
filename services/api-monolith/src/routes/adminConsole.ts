/**
 * Admin operator console routes.
 *
 * Owns the new T&S queue (`/admin/cases`), dispute queue (`/admin/disputes`),
 * payout-ops queue (`/admin/payouts`), takedowns workflow (`/admin/takedowns`),
 * role management (`/admin/users/:id/roles`), the moderator scan bench, and
 * the dashboard summary. All routes are gated by `requireRole(['admin',...])`
 * — `admin` implicitly satisfies every gate. Mutations call `recordAudit`
 * explicitly so the entity id is recorded in addition to whatever the
 * `auditMutations` middleware captures from the request envelope.
 */
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { requireUserId } from "../lib/auth";
import {
  ROLE_NAMES,
  type RoleName,
  grantRole,
  listRolesForUser,
  requireRole,
  revokeRole,
  userHasAnyRole,
} from "../lib/roles";
import {
  getModerationDashboardCounts,
  getModerationProviderInfo,
  moderateText,
  openModerationCase,
  resolveTargetOwnerUserId,
} from "../lib/moderation";
import {
  newPayoutActionId,
  newTakedownId,
} from "../lib/ids";
import { recordAudit } from "../lib/audit";
import { enqueueNotification } from "../lib/notifications";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// --- helpers --------------------------------------------------------------

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function isRoleName(x: string): x is RoleName {
  return (ROLE_NAMES as readonly string[]).includes(x);
}

const VALID_CASE_STATES = new Set(["open", "triage", "in_review", "action", "closed"]);
const VALID_CASE_DECISIONS = new Set([
  "approve",
  "hide",
  "ban",
  "refund",
  "deny",
  "partial",
  "escalate",
  "dismiss",
]);
const VALID_PAYOUT_OPS = new Set(["hold", "release", "clawback", "approve"]);

// --- Dashboard ------------------------------------------------------------

router.get("/admin/dashboard", requireRole(["admin", "moderator", "finance_ops", "support"]), async (_req, res) => {
  const counts = await getModerationDashboardCounts();
  const provider = getModerationProviderInfo();
  const heldPayouts = await db
    .select({ count: sql<string>`COUNT(*)::text` })
    .from(schema.payoutsTable)
    .where(eq(schema.payoutsTable.status, "blocked"));
  res.json({
    ...counts,
    heldPayouts: Number(heldPayouts[0]?.count ?? 0),
    moderationProvider: provider.provider,
    degraded: provider.degraded,
    degradedReason: provider.degradedReason,
  });
});

// --- Cases queue ----------------------------------------------------------

function caseRow(r: typeof schema.moderationCasesTable.$inferSelect) {
  return {
    id: r.id,
    kind: r.kind,
    targetKind: r.targetKind,
    targetId: r.targetId,
    severity: r.severity,
    state: r.state,
    assignedTo: r.assignedTo,
    slaDueAtIso: r.slaDueAt?.toISOString() ?? null,
    decision: r.decision,
    decisionReason: r.decisionReason,
    decidedAtIso: r.decidedAt?.toISOString() ?? null,
    decidedBy: r.decidedBy,
    evidence: r.evidence,
    sourceUserId: r.sourceUserId,
    sourceReportId: r.sourceReportId,
    takedownId: r.takedownId,
    createdAtIso: r.createdAt.toISOString(),
    updatedAtIso: r.updatedAt.toISOString(),
  };
}

router.get("/admin/cases", requireRole(["admin", "moderator", "support"]), async (req, res) => {
  const stateRaw = String(req.query.state ?? "").trim();
  const kindRaw = String(req.query.kind ?? "").trim();
  const assigneeRaw = String(req.query.assignee ?? "").trim();
  const limit = clampInt(req.query.limit, 1, 200, 50);
  const filters = [] as ReturnType<typeof eq>[];
  if (stateRaw) filters.push(eq(schema.moderationCasesTable.state, stateRaw));
  if (kindRaw) filters.push(eq(schema.moderationCasesTable.kind, kindRaw));
  if (assigneeRaw) filters.push(eq(schema.moderationCasesTable.assignedTo, assigneeRaw));
  const rows = await db
    .select()
    .from(schema.moderationCasesTable)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(asc(schema.moderationCasesTable.slaDueAt), desc(schema.moderationCasesTable.createdAt))
    .limit(limit);
  res.json({ items: rows.map(caseRow), totalCount: rows.length });
});

router.get("/admin/cases/:id", requireRole(["admin", "moderator", "support"]), async (req, res) => {
  const [row] = await db
    .select()
    .from(schema.moderationCasesTable)
    .where(eq(schema.moderationCasesTable.id, String(req.params.id ?? "")))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  // Include scan history for the same target so reviewers can see the
  // provider's signal alongside the case.
  const scans = await db
    .select()
    .from(schema.moderationScansTable)
    .where(
      and(
        eq(schema.moderationScansTable.targetKind, row.targetKind),
        eq(schema.moderationScansTable.targetId, row.targetId),
      ),
    )
    .orderBy(desc(schema.moderationScansTable.scannedAt))
    .limit(20);
  res.json({
    ...caseRow(row),
    scans: scans.map((s) => ({
      id: s.id,
      provider: s.provider,
      decision: s.decision,
      scores: s.scores,
      csamMatch: s.csamMatch,
      scannedAtIso: s.scannedAt.toISOString(),
    })),
  });
});

router.post("/admin/cases/:id/transition", requireRole(["admin", "moderator"]), async (req, res) => {
  const actorId = requireUserId(req, res);
  if (!actorId) return;
  const stateRaw = String((req.body as { state?: string }).state ?? "").trim();
  if (!VALID_CASE_STATES.has(stateRaw)) {
    res.status(400).json({ error: "bad_request", detail: "invalid state" });
    return;
  }
  const [row] = await db
    .update(schema.moderationCasesTable)
    .set({ state: stateRaw })
    .where(eq(schema.moderationCasesTable.id, String(req.params.id ?? "")))
    .returning();
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  await recordAudit({
    actorId,
    action: "moderation.case_transition",
    entity: "moderation_case",
    entityId: row.id,
    payload: { state: stateRaw },
  });
  res.json(caseRow(row));
});

router.post("/admin/cases/:id/assign", requireRole(["admin", "moderator"]), async (req, res) => {
  const actorId = requireUserId(req, res);
  if (!actorId) return;
  const assignee = String((req.body as { assignee?: string | null }).assignee ?? "").trim() || null;
  const [row] = await db
    .update(schema.moderationCasesTable)
    .set({ assignedTo: assignee, state: "triage" })
    .where(eq(schema.moderationCasesTable.id, String(req.params.id ?? "")))
    .returning();
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  await recordAudit({
    actorId,
    action: "moderation.case_assign",
    entity: "moderation_case",
    entityId: row.id,
    payload: { assignee },
  });
  res.json(caseRow(row));
});

router.post("/admin/cases/:id/decide", requireRole(["admin", "moderator"]), async (req, res) => {
  const actorId = requireUserId(req, res);
  if (!actorId) return;
  const body = req.body as { decision?: string; reason?: string };
  const decision = String(body.decision ?? "").trim();
  if (!VALID_CASE_DECISIONS.has(decision)) {
    res.status(400).json({ error: "bad_request", detail: "invalid decision" });
    return;
  }
  const reason = String(body.reason ?? "").trim();
  const [row] = await db
    .update(schema.moderationCasesTable)
    .set({
      state: "closed",
      decision,
      decisionReason: reason,
      decidedAt: new Date(),
      decidedBy: actorId,
    })
    .where(eq(schema.moderationCasesTable.id, String(req.params.id ?? "")))
    .returning();
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  // If the operator chose `ban`, auto-create a takedown (UI can also create
  // one explicitly via /admin/takedowns).
  if (decision === "ban") {
    const tdId = newTakedownId();
    await db.insert(schema.takedownsTable).values({
      id: tdId,
      targetKind: row.targetKind,
      targetId: row.targetId,
      reasonCode: reason || "policy_violation",
      actorUserId: actorId,
      notes: `auto:case=${row.id}`,
    });
    await db
      .update(schema.moderationCasesTable)
      .set({ takedownId: tdId })
      .where(eq(schema.moderationCasesTable.id, row.id));
    await recordAudit({
      actorId,
      action: "moderation.takedown_create",
      entity: "takedown",
      entityId: tdId,
      payload: { caseId: row.id, targetKind: row.targetKind, targetId: row.targetId },
    });
    // Same due-process notice as the manual /admin/takedowns route.
    await notifyTakedownTarget(tdId);
  }
  await recordAudit({
    actorId,
    action: "moderation.case_decide",
    entity: "moderation_case",
    entityId: row.id,
    payload: { decision, reason },
  });
  // Notify the original reporter (if any) that their report was
  // reviewed. Operator identity is intentionally omitted from the
  // payload — the reporter sees the decision, not who decided it.
  await notifyReporterOfDecision(row, decision, reason);
  res.json(caseRow(row));
});

// --- Disputes (cases of kind=dispute, with refund/release wiring) ---------

router.get("/admin/disputes", requireRole(["admin", "moderator", "support"]), async (req, res) => {
  const stateRaw = String(req.query.state ?? "").trim();
  const limit = clampInt(req.query.limit, 1, 200, 50);
  const filters = [eq(schema.moderationCasesTable.kind, "dispute")] as ReturnType<typeof eq>[];
  if (stateRaw) filters.push(eq(schema.moderationCasesTable.state, stateRaw));
  const rows = await db
    .select()
    .from(schema.moderationCasesTable)
    .where(and(...filters))
    .orderBy(asc(schema.moderationCasesTable.slaDueAt), desc(schema.moderationCasesTable.createdAt))
    .limit(limit);
  // Hydrate with the underlying return row so the operator UI can render
  // the buyer's reason without a second query.
  const returnIds = rows.map((r) => r.targetId);
  const returnsById = new Map<string, typeof schema.returnsTable.$inferSelect>();
  if (returnIds.length > 0) {
    const rs = await db
      .select()
      .from(schema.returnsTable)
      .where(inArray(schema.returnsTable.id, returnIds));
    for (const r of rs) returnsById.set(r.id, r);
  }
  res.json({
    items: rows.map((r) => ({
      ...caseRow(r),
      returnRow: (() => {
        const ret = returnsById.get(r.targetId);
        if (!ret) return null;
        return {
          id: ret.id,
          orderId: ret.orderId,
          productTitle: ret.productTitle,
          status: ret.status,
          refundAmountMinor: ret.refundAmountMinor,
          currencyCode: ret.currencyCode,
          reason: ret.reason,
          reasonLabel: ret.reasonLabel,
        };
      })(),
    })),
    totalCount: rows.length,
  });
});

router.post("/admin/disputes/:id/decide", requireRole(["admin", "moderator"]), async (req, res) => {
  const actorId = requireUserId(req, res);
  if (!actorId) return;
  const body = req.body as { decision?: string; reason?: string };
  const decision = String(body.decision ?? "").trim();
  if (!["refund", "deny", "partial"].includes(decision)) {
    res.status(400).json({ error: "bad_request", detail: "decision must be refund|deny|partial" });
    return;
  }
  const reason = String(body.reason ?? "").trim();
  const [row] = await db
    .select()
    .from(schema.moderationCasesTable)
    .where(eq(schema.moderationCasesTable.id, String(req.params.id ?? "")))
    .limit(1);
  if (!row || row.kind !== "dispute") {
    res.status(404).json({ error: "not_found" });
    return;
  }
  // Apply the decision to the underlying return row. We do not re-issue
  // refunds here (that lives in routes/returns.ts via the existing
  // `maybeRefundWallet` path); the operator decision drives the return
  // status, which the buyer flow turns into a wallet transaction.
  const newReturnStatus =
    decision === "refund" ? "refunded" : decision === "partial" ? "partial_refund" : "denied";
  await db
    .update(schema.returnsTable)
    .set({ status: newReturnStatus })
    .where(eq(schema.returnsTable.id, row.targetId));
  // Close the case.
  const [updated] = await db
    .update(schema.moderationCasesTable)
    .set({
      state: "closed",
      decision,
      decisionReason: reason,
      decidedAt: new Date(),
      decidedBy: actorId,
    })
    .where(eq(schema.moderationCasesTable.id, row.id))
    .returning();
  await recordAudit({
    actorId,
    action: "moderation.dispute_decide",
    entity: "moderation_case",
    entityId: row.id,
    payload: { decision, reason, returnId: row.targetId, newReturnStatus },
  });
  // Notify the buyer who filed the dispute that it was reviewed.
  // Same privacy rule as case decisions: operator identity stays out
  // of the payload.
  await notifyReporterOfDecision(row, decision, reason);
  res.json(caseRow(updated));
});

// --- Payout ops queue -----------------------------------------------------

function payoutRow(r: typeof schema.payoutsTable.$inferSelect) {
  return {
    id: r.id,
    userId: r.userId,
    sellerId: r.sellerId,
    orderId: r.orderId,
    amountMinor: r.amountMinor,
    currencyCode: r.currencyCode,
    status: r.status,
    kind: r.kind,
    gateway: r.gateway,
    gatewayReference: r.gatewayReference,
    holdUntilIso: r.holdUntil?.toISOString() ?? null,
    errorMessage: r.errorMessage,
    requestedAtIso: r.requestedAt.toISOString(),
    paidAtIso: r.paidAt?.toISOString() ?? null,
  };
}

router.get("/admin/payouts", requireRole(["admin", "finance_ops", "support"]), async (req, res) => {
  const statusRaw = String(req.query.status ?? "").trim();
  const limit = clampInt(req.query.limit, 1, 200, 50);
  const rows = await db
    .select()
    .from(schema.payoutsTable)
    .where(statusRaw ? eq(schema.payoutsTable.status, statusRaw) : undefined)
    .orderBy(desc(schema.payoutsTable.requestedAt))
    .limit(limit);
  res.json({ items: rows.map(payoutRow), totalCount: rows.length });
});

async function recordPayoutAction(
  payoutId: string,
  action: string,
  actorUserId: string,
  reason: string,
): Promise<void> {
  await db.insert(schema.payoutActionsTable).values({
    id: newPayoutActionId(),
    payoutId,
    action,
    actorUserId,
    reason,
  });
  await recordAudit({
    actorId: actorUserId,
    action: `payout.${action}`,
    entity: "payout",
    entityId: payoutId,
    payload: { reason },
  });
}

// Strict payout state machine. Operators may only transition payouts that
// are still in flight — `paid`/`failed`/`abandoned` rows are terminal and
// must never be re-released, otherwise `processDuePayouts` would disburse
// them a second time. The conditional `WHERE status IN (...)` guarantees
// invalid transitions return 0 rows (→ 409) instead of silently corrupting
// state. Combined with the gateway's own idempotency keys this prevents
// double-spend even under concurrent operator action.
const HOLD_FROM = ["pending", "scheduled", "processing"] as const;
const RELEASE_FROM = ["blocked"] as const;
const CLAWBACK_FROM = ["paid"] as const;

router.post("/admin/payouts/:id/hold", requireRole(["admin", "finance_ops"]), async (req, res) => {
  const actorId = requireUserId(req, res);
  if (!actorId) return;
  const reason = String((req.body as { reason?: string }).reason ?? "").trim();
  if (!reason) {
    res.status(400).json({ error: "bad_request", detail: "reason required" });
    return;
  }
  const id = String(req.params.id ?? "");
  const [row] = await db
    .update(schema.payoutsTable)
    .set({ status: "blocked", errorMessage: `held_by_ops: ${reason}` })
    .where(and(eq(schema.payoutsTable.id, id), inArray(schema.payoutsTable.status, [...HOLD_FROM])))
    .returning();
  if (!row) {
    const exists = await db.select({ id: schema.payoutsTable.id }).from(schema.payoutsTable).where(eq(schema.payoutsTable.id, id)).limit(1);
    res.status(exists.length === 0 ? 404 : 409).json({ error: exists.length === 0 ? "not_found" : "invalid_transition", allowedFrom: HOLD_FROM });
    return;
  }
  await recordPayoutAction(row.id, "hold", actorId, reason);
  res.json(payoutRow(row));
});

router.post("/admin/payouts/:id/release", requireRole(["admin", "finance_ops"]), async (req, res) => {
  const actorId = requireUserId(req, res);
  if (!actorId) return;
  const reason = String((req.body as { reason?: string }).reason ?? "ops_release").trim();
  // Release sends the row back to `pending` so the regular `processDuePayouts`
  // tick picks it up. We also clear `holdUntil` to ensure it isn't deferred.
  // Only `blocked` rows may be released — releasing a `paid` row would cause
  // a second disbursement.
  const id = String(req.params.id ?? "");
  const [row] = await db
    .update(schema.payoutsTable)
    .set({ status: "pending", errorMessage: null, holdUntil: null })
    .where(and(eq(schema.payoutsTable.id, id), inArray(schema.payoutsTable.status, [...RELEASE_FROM])))
    .returning();
  if (!row) {
    const exists = await db.select({ id: schema.payoutsTable.id }).from(schema.payoutsTable).where(eq(schema.payoutsTable.id, id)).limit(1);
    res.status(exists.length === 0 ? 404 : 409).json({ error: exists.length === 0 ? "not_found" : "invalid_transition", allowedFrom: RELEASE_FROM });
    return;
  }
  await recordPayoutAction(row.id, "release", actorId, reason);
  res.json(payoutRow(row));
});

router.post("/admin/payouts/:id/clawback", requireRole(["admin", "finance_ops"]), async (req, res) => {
  const actorId = requireUserId(req, res);
  if (!actorId) return;
  const reason = String((req.body as { reason?: string }).reason ?? "").trim();
  if (!reason) {
    res.status(400).json({ error: "bad_request", detail: "reason required" });
    return;
  }
  // Clawback is only meaningful on a `paid` row — funds are already out the
  // door and we are recording an after-the-fact reversal initiated through
  // the gateway portal. Marking a non-paid row as `failed` would just cancel
  // the disbursement, not claw it back, and was previously how operators
  // could accidentally reset a `paid` row to a re-disbursable state.
  const id = String(req.params.id ?? "");
  const [row] = await db
    .update(schema.payoutsTable)
    .set({ status: "failed", errorMessage: `clawback: ${reason}` })
    .where(and(eq(schema.payoutsTable.id, id), inArray(schema.payoutsTable.status, [...CLAWBACK_FROM])))
    .returning();
  if (!row) {
    const exists = await db.select({ id: schema.payoutsTable.id }).from(schema.payoutsTable).where(eq(schema.payoutsTable.id, id)).limit(1);
    res.status(exists.length === 0 ? 404 : 409).json({ error: exists.length === 0 ? "not_found" : "invalid_transition", allowedFrom: CLAWBACK_FROM });
    return;
  }
  await recordPayoutAction(row.id, "clawback", actorId, reason);
  res.json(payoutRow(row));
});

router.get("/admin/payouts/:id/actions", requireRole(["admin", "finance_ops", "support"]), async (req, res) => {
  const rows = await db
    .select()
    .from(schema.payoutActionsTable)
    .where(eq(schema.payoutActionsTable.payoutId, String(req.params.id ?? "")))
    .orderBy(desc(schema.payoutActionsTable.createdAt));
  res.json(
    rows.map((r) => ({
      id: r.id,
      payoutId: r.payoutId,
      action: r.action,
      actorUserId: r.actorUserId,
      reason: r.reason,
      createdAtIso: r.createdAt.toISOString(),
    })),
  );
});

// --- Takedowns ------------------------------------------------------------

function takedownRow(r: typeof schema.takedownsTable.$inferSelect) {
  return {
    id: r.id,
    targetKind: r.targetKind,
    targetId: r.targetId,
    reasonCode: r.reasonCode,
    actorUserId: r.actorUserId,
    notifiedAtIso: r.notifiedAt?.toISOString() ?? null,
    notes: r.notes,
    createdAtIso: r.createdAt.toISOString(),
  };
}

/**
 * Notify the seller whose content was taken down. Resolves the affected
 * user via `resolveTargetOwnerUserId`, enqueues a `content_takedown`
 * notification with the reason code + appeal URL, and stamps `notifiedAt`
 * on the takedown row so the operator queue can show whether due-process
 * notice has been served.
 *
 * Best-effort: a failure to resolve the owner (e.g. takedown of a raw
 * `text` snippet from the moderator scan bench) or to enqueue the
 * notification only logs and skips — the takedown itself remains the
 * source of truth.
 */
async function notifyTakedownTarget(takedownId: string): Promise<void> {
  const [td] = await db
    .select()
    .from(schema.takedownsTable)
    .where(eq(schema.takedownsTable.id, takedownId))
    .limit(1);
  if (!td) return;
  let ownerUserId: string | null = null;
  try {
    ownerUserId = await resolveTargetOwnerUserId(td.targetKind, td.targetId);
  } catch (err) {
    logger.error(
      { err: (err as Error).message, takedownId, targetKind: td.targetKind, targetId: td.targetId },
      "takedown_owner_resolve_failed",
    );
  }
  if (!ownerUserId) {
    logger.warn(
      { takedownId, targetKind: td.targetKind, targetId: td.targetId },
      "takedown_owner_unresolved_skipping_notify",
    );
    return;
  }
  // Reason codes are stored as machine slugs; the buyer-app safety hub
  // renders a human label client-side. We include both the slug and a
  // best-effort body so a fallback channel (email) is still readable
  // without the app.
  const reasonLabel = humanizeReasonCode(td.reasonCode);
  // The buyer-app safety hub renders the user's takedowns list with a
  // contextual appeal form per row (see `pages/safety/index.tsx`).
  // Only `/safety` and `/safety/report` are registered routes, so we
  // deep-link to `/safety` with a query param the page can use to
  // scroll/highlight the right row.
  const appealUrl = `/safety?takedown=${td.id}`;
  try {
    await enqueueNotification({
      userId: ownerUserId,
      eventType: "content_takedown",
      payload: {
        title: "Your content was removed",
        body: `Reason: ${reasonLabel}. Tap to review or appeal.`,
        url: appealUrl,
        takedownId: td.id,
        targetKind: td.targetKind,
        targetId: td.targetId,
        reasonCode: td.reasonCode,
        reasonLabel,
      },
    });
    await db
      .update(schema.takedownsTable)
      .set({ notifiedAt: new Date() })
      .where(eq(schema.takedownsTable.id, td.id));
  } catch (err) {
    logger.error(
      { err: (err as Error).message, takedownId, ownerUserId },
      "takedown_notify_enqueue_failed",
    );
  }
}

/**
 * Reason codes are slugs for searchability and i18n at the edges. Until
 * a full i18n catalogue lands we render a best-effort title-case
 * fallback so the email/push body is still readable.
 */
function humanizeReasonCode(code: string): string {
  const trimmed = String(code ?? "").trim();
  if (!trimmed) return "policy violation";
  return trimmed.replace(/[_-]+/g, " ");
}

/**
 * Notify the original reporter of a moderation case that their report
 * was reviewed. Skips silently when the case has no `sourceUserId`
 * (provider-opened cases or moderator-bench scans). Critically, the
 * payload exposes only the decision and decision reason — never the
 * moderator's clerk id — so the reporter cannot identify the operator
 * who handled their report.
 */
async function notifyReporterOfDecision(
  caseRowFromDb: typeof schema.moderationCasesTable.$inferSelect,
  decision: string,
  reason: string,
): Promise<void> {
  if (!caseRowFromDb.sourceUserId) return;
  const decisionLabel = decisionToReporterLabel(decision);
  try {
    await enqueueNotification({
      userId: caseRowFromDb.sourceUserId,
      eventType: "safety_report_decided",
      payload: {
        title: "Your report was reviewed",
        body: `Outcome: ${decisionLabel}.`,
        url: "/safety",
        caseId: caseRowFromDb.id,
        reportId: caseRowFromDb.sourceReportId ?? null,
        decision,
        decisionLabel,
        decisionReason: reason || null,
      },
    });
  } catch (err) {
    logger.error(
      { err: (err as Error).message, caseId: caseRowFromDb.id },
      "safety_report_decided_notify_failed",
    );
  }
}

function decisionToReporterLabel(decision: string): string {
  switch (decision) {
    case "ban":
    case "hide":
    case "refund":
      return "Action taken";
    case "partial":
      return "Partial action taken";
    case "approve":
    case "deny":
    case "dismiss":
      return "No action taken";
    case "escalate":
      return "Escalated for further review";
    default:
      return decision.replace(/_/g, " ");
  }
}

router.get("/admin/takedowns", requireRole(["admin", "moderator", "support"]), async (req, res) => {
  const limit = clampInt(req.query.limit, 1, 200, 50);
  const rows = await db
    .select()
    .from(schema.takedownsTable)
    .orderBy(desc(schema.takedownsTable.createdAt))
    .limit(limit);
  res.json(rows.map(takedownRow));
});

/**
 * Buyer-app endpoint: list takedowns where the authenticated user is
 * the affected party. Lives under /admin/takedowns/mine (no operator
 * role gate) so the safety hub can surface "your content was removed"
 * entries with appeal CTAs without leaking other tenants' takedowns.
 *
 * Resolution is "what owner did this targetKind+targetId map to at
 * read time", which mirrors how `notifyTakedownTarget` decides who to
 * notify. Tradeoff: if a product changes hands after takedown, the
 * new owner sees it; in practice products are not transferred. We
 * also include a `caseId` projection so the appeal CTA can deep-link
 * to the case-history view if one exists.
 */
router.get("/admin/takedowns/mine", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  // Bound the scan: most users have <10 takedowns ever, but the
  // takedowns table is global so we have to filter by ownership in
  // app code (no `ownerUserId` column yet). Cap at 1000 most recent
  // rows so an active marketplace doesn't truncate a seller's history.
  // Follow-up #208 / persisted ownerUserId is the correct long-term
  // fix; until then 1000 keeps the per-row owner lookup bounded
  // (~1k * single PK lookup) while covering all realistic histories.
  const rows = await db
    .select()
    .from(schema.takedownsTable)
    .orderBy(desc(schema.takedownsTable.createdAt))
    .limit(1000);
  const mine: (typeof schema.takedownsTable.$inferSelect)[] = [];
  for (const r of rows) {
    let owner: string | null = null;
    try {
      owner = await resolveTargetOwnerUserId(r.targetKind, r.targetId);
    } catch (err) {
      logger.error(
        { err: (err as Error).message, takedownId: r.id },
        "takedowns_mine_owner_resolve_failed",
      );
      continue;
    }
    if (owner === userId) mine.push(r);
  }
  // Hydrate with linked case state so the appeal CTA can show whether
  // an appeal is already in flight (case state == "in_review" /
  // "open"). We don't surface decision/decided_by — only state.
  // Skip the query when the user has no takedowns: passing an empty
  // array to `inArray` produces invalid SQL on this driver, and the
  // 500 would regress the safety section for the common zero-takedown
  // case.
  const caseByTakedown = new Map<string, { id: string; state: string }>();
  if (mine.length > 0) {
    const caseIds = await db
      .select({
        id: schema.moderationCasesTable.id,
        state: schema.moderationCasesTable.state,
        takedownId: schema.moderationCasesTable.takedownId,
      })
      .from(schema.moderationCasesTable)
      .where(
        inArray(
          schema.moderationCasesTable.takedownId,
          mine.map((m) => m.id),
        ),
      );
    for (const c of caseIds) {
      if (c.takedownId) caseByTakedown.set(c.takedownId, { id: c.id, state: c.state });
    }
  }
  // Seller-facing shape: redact `actorUserId` so the moderator's
  // identity never leaks via the buyer-app safety hub. The operator
  // console continues to use the unredacted `Takedown` shape via the
  // gated GET /admin/takedowns endpoint above.
  res.json(
    mine.map((r) => {
      const { actorUserId: _omit, ...rest } = takedownRow(r);
      return {
        ...rest,
        caseId: caseByTakedown.get(r.id)?.id ?? null,
        caseStatus: caseByTakedown.get(r.id)?.state ?? null,
      };
    }),
  );
});

router.post("/admin/takedowns", requireRole(["admin", "moderator"]), async (req, res) => {
  const actorId = requireUserId(req, res);
  if (!actorId) return;
  const body = req.body as {
    targetKind?: string;
    targetId?: string;
    reasonCode?: string;
    notes?: string;
  };
  const targetKind = String(body.targetKind ?? "").trim();
  const targetId = String(body.targetId ?? "").trim();
  const reasonCode = String(body.reasonCode ?? "").trim();
  if (!targetKind || !targetId || !reasonCode) {
    res.status(400).json({ error: "bad_request", detail: "targetKind, targetId, reasonCode required" });
    return;
  }
  const id = newTakedownId();
  await db.insert(schema.takedownsTable).values({
    id,
    targetKind,
    targetId,
    reasonCode,
    actorUserId: actorId,
    notes: String(body.notes ?? ""),
  });
  await recordAudit({
    actorId,
    action: "moderation.takedown_create",
    entity: "takedown",
    entityId: id,
    payload: { targetKind, targetId, reasonCode },
  });
  // Due-process notice. Best-effort — never fails the takedown insert.
  await notifyTakedownTarget(id);
  res.status(201).json({ id, targetKind, targetId, reasonCode });
});

/**
 * Seller appeal of a takedown. Lives under `/admin/takedowns/:id/appeal`
 * for path consistency with the rest of the takedown workflow, but is
 * not gated by `requireRole` — instead the actor must either be the
 * affected owner of the takedown, or an operator (admin/moderator).
 *
 * Effect: re-opens the linked moderation case so the queue picks it
 * back up. If no case is linked yet (manually-created takedown), one
 * is opened in `in_review` state. Records an audit row and writes a
 * structured `appeals` entry into the case evidence so the operator
 * can see the seller's stated reason.
 */
router.post("/admin/takedowns/:id/appeal", async (req, res) => {
  const actorId = requireUserId(req, res);
  if (!actorId) return;
  const id = String(req.params.id ?? "").trim();
  const reason = String((req.body as { reason?: string }).reason ?? "").trim();
  const [td] = await db
    .select()
    .from(schema.takedownsTable)
    .where(eq(schema.takedownsTable.id, id))
    .limit(1);
  if (!td) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  // Authorisation: the affected owner can appeal their own takedown.
  // Operators can also appeal on behalf of a seller (e.g. support flow).
  let ownerUserId: string | null = null;
  try {
    ownerUserId = await resolveTargetOwnerUserId(td.targetKind, td.targetId);
  } catch (err) {
    logger.error(
      { err: (err as Error).message, takedownId: id },
      "takedown_appeal_owner_resolve_failed",
    );
  }
  const isOwner = ownerUserId !== null && ownerUserId === actorId;
  let isOperator = false;
  if (!isOwner) {
    try {
      isOperator = await userHasAnyRole(actorId, ["admin", "moderator", "support"]);
    } catch (err) {
      logger.error(
        { err: (err as Error).message, actorId },
        "takedown_appeal_role_check_failed",
      );
    }
  }
  if (!isOwner && !isOperator) {
    res.status(403).json({ error: "forbidden", detail: "not_takedown_owner" });
    return;
  }
  // Locate or open the moderation case so the operator queue picks
  // the appeal back up. We pivot on `takedownId` so a takedown that
  // was created via /admin/cases/:id/decide (which back-links the
  // case) is matched, and so manually-created takedowns get a fresh
  // case opened.
  const [existingCase] = await db
    .select()
    .from(schema.moderationCasesTable)
    .where(eq(schema.moderationCasesTable.takedownId, td.id))
    .limit(1);
  let caseId: string;
  if (existingCase) {
    const evidence = (existingCase.evidence ?? {}) as Record<string, unknown>;
    const appeals = Array.isArray(evidence.appeals) ? (evidence.appeals as unknown[]) : [];
    appeals.push({
      atIso: new Date().toISOString(),
      byUserId: actorId,
      reason,
      onBehalfOfOwner: isOperator && !isOwner,
    });
    await db
      .update(schema.moderationCasesTable)
      .set({
        // Re-open the case for re-review. We deliberately clear
        // `decision` / `decidedAt` / `decidedBy` so the queue treats
        // this as a fresh action — the audit chain still preserves
        // the original decision.
        state: "in_review",
        decision: null,
        decisionReason: "",
        decidedAt: null,
        decidedBy: null,
        evidence: { ...evidence, appeals },
      })
      .where(eq(schema.moderationCasesTable.id, existingCase.id));
    caseId = existingCase.id;
  } else {
    caseId = await openModerationCase({
      kind: "report",
      targetKind: td.targetKind,
      targetId: td.targetId,
      severity: "normal",
      evidence: {
        appeals: [
          {
            atIso: new Date().toISOString(),
            byUserId: actorId,
            reason,
            onBehalfOfOwner: isOperator && !isOwner,
          },
        ],
        appealedTakedownId: td.id,
        reasonCode: td.reasonCode,
      },
      sourceUserId: ownerUserId,
    });
    await db
      .update(schema.moderationCasesTable)
      .set({ takedownId: td.id, state: "in_review" })
      .where(eq(schema.moderationCasesTable.id, caseId));
  }
  await recordAudit({
    actorId,
    action: "moderation.takedown_appeal",
    entity: "takedown",
    entityId: td.id,
    payload: { caseId, reason, isOperator: isOperator && !isOwner },
  });
  res.status(202).json({
    id: td.id,
    caseId,
    caseStatus: "in_review",
    appealedAtIso: new Date().toISOString(),
  });
});

// --- Roles management -----------------------------------------------------

router.get("/admin/users/:userId/roles", requireRole(["admin"]), async (req, res) => {
  const userId = String(req.params.userId ?? "");
  const roles = await listRolesForUser(userId);
  res.json({ userId, roles });
});

router.post("/admin/users/:userId/roles", requireRole(["admin"]), async (req, res) => {
  const actorId = requireUserId(req, res);
  if (!actorId) return;
  const userId = String(req.params.userId ?? "");
  const role = String((req.body as { role?: string }).role ?? "").trim();
  if (!isRoleName(role)) {
    res.status(400).json({ error: "bad_request", detail: "invalid role" });
    return;
  }
  const ok = await grantRole(userId, role, actorId);
  if (!ok) {
    res.status(404).json({ error: "role_not_found" });
    return;
  }
  await recordAudit({
    actorId,
    action: "rbac.grant",
    entity: "user_role",
    entityId: `${userId}:${role}`,
    payload: { userId, role },
  });
  const roles = await listRolesForUser(userId);
  res.json({ userId, roles });
});

router.delete("/admin/users/:userId/roles/:role", requireRole(["admin"]), async (req, res) => {
  const actorId = requireUserId(req, res);
  if (!actorId) return;
  const userId = String(req.params.userId ?? "");
  const role = String(req.params.role ?? "");
  if (!isRoleName(role)) {
    res.status(400).json({ error: "bad_request", detail: "invalid role" });
    return;
  }
  const ok = await revokeRole(userId, role);
  if (!ok) {
    res.status(404).json({ error: "role_not_found" });
    return;
  }
  await recordAudit({
    actorId,
    action: "rbac.revoke",
    entity: "user_role",
    entityId: `${userId}:${role}`,
    payload: { userId, role },
  });
  const roles = await listRolesForUser(userId);
  res.json({ userId, roles });
});

// --- Operator utilities ---------------------------------------------------

router.get("/admin/me/roles", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const roles = await listRolesForUser(userId);
  res.json({ userId, roles });
});

router.post("/admin/scan/text", requireRole(["admin", "moderator"]), async (req, res) => {
  const actorId = requireUserId(req, res);
  if (!actorId) return;
  const text = String((req.body as { text?: string }).text ?? "");
  if (!text) {
    res.status(400).json({ error: "bad_request", detail: "text required" });
    return;
  }
  const result = await moderateText(text, {
    surface: "operator_test",
    targetId: `op:${actorId}:${Date.now()}`,
    sourceUserId: actorId,
  });
  // Operator scan-bench is a privileged action: it consumes provider quota,
  // can mint a moderation case (review/block decisions trigger
  // recordScanAndMaybeOpenCase), and reveals the active moderation policy.
  // Audit it like any other admin mutation.
  await recordAudit({
    actorId,
    action: "moderation.scan_bench",
    entity: "moderation_scan",
    entityId: result.scanId,
    payload: { decision: result.decision, caseId: result.caseId, textLen: text.length },
  });
  res.json(result);
});

export default router;
