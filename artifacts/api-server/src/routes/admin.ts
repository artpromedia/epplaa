import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { requireUserId } from "../lib/auth";
import { runDailyReconciliation } from "../lib/reconciliation";
import { processDuePayouts } from "../lib/payments";
import { approveVerification, rejectVerification } from "../lib/kyc";

const router: IRouter = Router();

/**
 * Admin gate: comma-separated list of Clerk user IDs in EPPLAA_ADMIN_USER_IDS.
 * If empty, no one is admin (production-safe default).
 */
function getAdminIds(): Set<string> {
  return new Set(
    String(process.env.EPPLAA_ADMIN_USER_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const userId = requireUserId(req, res);
  if (!userId) return;
  if (!getAdminIds().has(userId)) {
    res.status(403).json({ error: "forbidden", detail: "admin_only" });
    return;
  }
  next();
}

router.get("/admin/payment-gateway-health", requireAdmin, async (_req, res) => {
  const rows = await db.select().from(schema.gatewayHealthTable);
  res.json(
    rows.map((r) => ({
      gateway: r.gateway,
      successCount: r.successCount,
      failureCount: r.failureCount,
      windowStartedAtIso: r.windowStartedAt.toISOString(),
      circuitOpenUntilIso: r.circuitOpenUntil?.toISOString() ?? null,
      lastEventAtIso: r.lastEventAt?.toISOString() ?? null,
    })),
  );
});

router.get("/admin/reconciliation-runs", requireAdmin, async (_req, res) => {
  const rows = await db
    .select()
    .from(schema.reconciliationRunsTable)
    .orderBy(desc(schema.reconciliationRunsTable.ranAt))
    .limit(50);
  res.json(
    rows.map((r) => ({
      id: r.id,
      gateway: r.gateway,
      windowStartIso: r.windowStart.toISOString(),
      windowEndIso: r.windowEnd.toISOString(),
      ledgerCount: r.ledgerCount,
      settlementCount: r.settlementCount,
      matchedCount: r.matchedCount,
      mismatches: r.mismatches,
      status: r.status,
      errorMessage: r.errorMessage,
      ranAtIso: r.ranAt.toISOString(),
    })),
  );
});

router.post("/admin/reconciliation/run", requireAdmin, async (_req, res) => {
  const runs = await runDailyReconciliation();
  res.json({ ok: true, runs: runs.length });
});

router.post("/admin/payouts/run-due", requireAdmin, async (_req, res) => {
  const result = await processDuePayouts();
  res.json({ ok: true, ...result });
});

router.get("/admin/payment-intents", requireAdmin, async (_req, res) => {
  const rows = await db
    .select()
    .from(schema.paymentIntentsTable)
    .orderBy(desc(schema.paymentIntentsTable.createdAt))
    .limit(50);
  res.json(
    rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      purpose: r.purpose,
      orderId: r.orderId,
      gateway: r.gateway,
      reference: r.reference,
      amountMinor: r.amountMinor,
      currencyCode: r.currencyCode,
      status: r.status,
      paidAtIso: r.paidAt?.toISOString() ?? null,
      createdAtIso: r.createdAt.toISOString(),
    })),
  );
});

// ---- KYC review queue (admin) ----
// We expose a thin admin surface so a compliance reviewer can list
// pending KYC verifications and approve/reject them. Approval promotes
// the seller's `kycTier` and sets `nextKycReviewAt` (used by the
// quarterly resweep). Rejection records the reason and emits an audit
// event. Both actions are guarded by the same admin allow-list above.

router.get("/admin/kyc/pending", requireAdmin, async (_req, res) => {
  const rows = await db
    .select()
    .from(schema.kycVerificationsTable)
    .where(eq(schema.kycVerificationsTable.status, "pending_review"))
    .orderBy(desc(schema.kycVerificationsTable.submittedAt))
    .limit(100);
  res.json(
    rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      kind: r.kind,
      status: r.status,
      submittedAtIso: r.submittedAt?.toISOString() ?? null,
      createdAtIso: r.createdAt.toISOString(),
    })),
  );
});

router.post("/admin/kyc/:id/approve", requireAdmin, async (req, res) => {
  const reviewerId = requireUserId(req, res);
  if (!reviewerId) return;
  const id = String(req.params.id ?? "");
  // The seller's tier promotion is computed inside `approveVerification`
  // from the verification row's `targetTier`; we only need the reviewer's
  // optional note here.
  const note = String(req.body?.note ?? "approved").trim();
  const result = await approveVerification(id, reviewerId, note);
  if (!result.ok) {
    res.status(404).json({ error: "not_found", detail: result.reason });
    return;
  }
  res.json({ ok: true, kycTier: result.kycTier });
});

router.post("/admin/kyc/:id/reject", requireAdmin, async (req, res) => {
  const reviewerId = requireUserId(req, res);
  if (!reviewerId) return;
  const id = String(req.params.id ?? "");
  const reason = String(req.body?.reason ?? "").trim();
  if (!reason) {
    res.status(400).json({ error: "bad_request", detail: "reason is required" });
    return;
  }
  const result = await rejectVerification(id, reviewerId, reason);
  if (!result.ok) {
    res.status(404).json({ error: "not_found", detail: result.reason });
    return;
  }
  res.json({ ok: true });
});

export default router;
