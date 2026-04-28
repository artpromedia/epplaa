import { Router, type IRouter } from "express";
import { eq, and, desc, inArray } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { requireUserId } from "../lib/auth";
import { newReportId } from "../lib/ids";
import { openModerationCase } from "../lib/moderation";
import { logger } from "../lib/logger";

const router: IRouter = Router();

async function listBlocked(userId: string) {
  const rows = await db
    .select()
    .from(schema.blockedSellersTable)
    .where(eq(schema.blockedSellersTable.userId, userId))
    .orderBy(desc(schema.blockedSellersTable.createdAt));
  return rows.map((r) => ({ sellerName: r.sellerName, reason: r.reason, atIso: r.createdAt.toISOString() }));
}

router.get("/safety/reports", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const rows = await db
    .select()
    .from(schema.safetyReportsTable)
    .where(eq(schema.safetyReportsTable.userId, userId))
    .orderBy(desc(schema.safetyReportsTable.createdAt));
  // Buyer transparency: surface the linked moderation case state next to
  // each report (caseStatus only — no operator PII).
  const caseIds = rows.map((r) => r.caseId).filter((x): x is string => Boolean(x));
  const caseStateById = new Map<string, string>();
  if (caseIds.length > 0) {
    const cases = await db
      .select({ id: schema.moderationCasesTable.id, state: schema.moderationCasesTable.state })
      .from(schema.moderationCasesTable)
      .where(inArray(schema.moderationCasesTable.id, caseIds));
    for (const c of cases) caseStateById.set(c.id, c.state);
  }
  res.json(
    rows.map((r) => ({
      id: r.id,
      targetKind: r.targetKind,
      targetId: r.targetId,
      targetLabel: r.targetLabel,
      reason: r.reason,
      notes: r.notes,
      status: r.status,
      blockedAtSubmit: r.blockedAtSubmit,
      caseId: r.caseId ?? null,
      caseStatus: r.caseId ? caseStateById.get(r.caseId) ?? null : null,
      createdAtIso: r.createdAt.toISOString(),
      updatedAtIso: r.updatedAt.toISOString(),
    })),
  );
});

router.post("/safety/reports", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const body = req.body as {
    targetKind: string;
    targetId: string;
    targetLabel: string;
    reason: string;
    notes?: string;
    blockSeller?: boolean;
    sellerName?: string;
  };
  const id = newReportId();
  const [row] = await db
    .insert(schema.safetyReportsTable)
    .values({
      id,
      userId,
      targetKind: body.targetKind,
      targetId: body.targetId,
      targetLabel: body.targetLabel,
      reason: body.reason,
      notes: body.notes ?? "",
      status: "submitted",
      blockedAtSubmit: Boolean(body.blockSeller && body.sellerName),
    })
    .returning();
  if (body.blockSeller && body.sellerName) {
    await db
      .insert(schema.blockedSellersTable)
      .values({ userId, sellerName: body.sellerName, reason: body.reason })
      .onConflictDoNothing();
  }
  // Enqueue into the operator T&S queue. Best-effort: a queue write
  // failure is logged but must not 500 the buyer's report submission.
  let caseId: string | null = null;
  try {
    caseId = await openModerationCase({
      kind: "report",
      targetKind: row.targetKind,
      targetId: row.targetId,
      severity: "normal",
      evidence: {
        reportId: row.id,
        targetLabel: row.targetLabel,
        reason: row.reason,
        notes: row.notes,
        blockedAtSubmit: row.blockedAtSubmit,
      },
      sourceUserId: userId,
      sourceReportId: row.id,
    });
    await db
      .update(schema.safetyReportsTable)
      .set({ caseId })
      .where(eq(schema.safetyReportsTable.id, row.id));
  } catch (err) {
    logger.error({ err: (err as Error).message, reportId: row.id }, "safety_report_case_open_failed");
  }
  res.status(201).json({
    id: row.id,
    targetKind: row.targetKind,
    targetId: row.targetId,
    targetLabel: row.targetLabel,
    reason: row.reason,
    notes: row.notes,
    status: row.status,
    blockedAtSubmit: row.blockedAtSubmit,
    caseId,
    caseStatus: caseId ? "open" : null,
    createdAtIso: row.createdAt.toISOString(),
    updatedAtIso: row.updatedAt.toISOString(),
  });
});

router.get("/safety/blocked", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  res.json(await listBlocked(userId));
});

router.post("/safety/blocked", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const body = req.body as { sellerName?: string; reason?: string };
  if (!body.sellerName) {
    res.status(400).json({ error: "bad_request" });
    return;
  }
  await db
    .insert(schema.blockedSellersTable)
    .values({ userId, sellerName: body.sellerName, reason: body.reason ?? "manual" })
    .onConflictDoNothing();
  res.json(await listBlocked(userId));
});

router.delete("/safety/blocked/:sellerName", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  await db
    .delete(schema.blockedSellersTable)
    .where(
      and(
        eq(schema.blockedSellersTable.userId, userId),
        eq(schema.blockedSellersTable.sellerName, req.params.sellerName),
      ),
    );
  res.json(await listBlocked(userId));
});

export default router;
