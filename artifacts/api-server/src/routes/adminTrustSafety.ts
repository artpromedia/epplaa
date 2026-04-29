import { Router, type IRouter } from "express";
import { and, desc, eq, gte, like, count } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { requireUserId } from "../lib/auth";
import { requireRole } from "../lib/roles";
import { recordAudit } from "../lib/audit";
import { decryptDocument } from "../lib/kyc";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// Trust & Safety surfaces are admin-only: KYC docs, sanctions hits,
// cross-user NDPR queue, and audit search expose sensitive PII and
// must follow the strictest least-privilege gate. Reviewer-tier roles
// (moderator/support/finance_ops) do NOT get access here even though
// they have it on other operator surfaces.
const ADMIN_ONLY = ["admin"] as const;

/**
 * GET /admin/kyc/:id — verification detail with attached document
 * metadata. Used by the Trust & Safety queue's review drawer.
 */
router.get(
  "/admin/kyc/:id",
  requireRole(ADMIN_ONLY),
  async (req, res) => {
    const reviewerId = requireUserId(req, res);
    if (!reviewerId) return;
    const id = String(req.params.id ?? "");
    const [v] = await db
      .select()
      .from(schema.kycVerificationsTable)
      .where(eq(schema.kycVerificationsTable.id, id))
      .limit(1);
    if (!v) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const docIds = ((v.documentIds ?? []) as string[]) ?? [];
    let docs: typeof schema.kycDocumentsTable.$inferSelect[] = [];
    if (docIds.length > 0) {
      docs = await db
        .select()
        .from(schema.kycDocumentsTable)
        .where(eq(schema.kycDocumentsTable.userId, v.userId));
      docs = docs.filter((d) => docIds.includes(d.id));
    }
    await recordAudit({
      actorId: reviewerId,
      action: "admin.kyc.detail.read",
      entity: "kyc_verification",
      entityId: id,
      payload: { userId: v.userId },
      piiRead: true,
    });
    res.json({
      id: v.id,
      userId: v.userId,
      kind: v.kind,
      status: v.status,
      targetTier: v.targetTier,
      reviewerNote: v.reviewerNote,
      reviewedBy: v.reviewedBy,
      reviewedAtIso: v.reviewedAt?.toISOString() ?? null,
      submittedAtIso: v.submittedAt?.toISOString() ?? null,
      createdAtIso: v.createdAt.toISOString(),
      documents: docs.map((d) => ({
        id: d.id,
        kind: d.kind,
        filename: d.filename,
        contentType: d.contentType,
        sizeBytes: d.sizeBytes,
        sha256: d.sha256,
        status: d.status,
        createdAtIso: d.createdAt.toISOString(),
      })),
    });
  },
);

/**
 * GET /admin/kyc/documents/:id — admin doc download for thumbnail
 * rendering. Always recorded as a `piiRead` audit event.
 */
router.get(
  "/admin/kyc/documents/:id",
  requireRole(ADMIN_ONLY),
  async (req, res) => {
    const reviewerId = requireUserId(req, res);
    if (!reviewerId) return;
    const docId = String(req.params.id ?? "");
    const [doc] = await db
      .select()
      .from(schema.kycDocumentsTable)
      .where(eq(schema.kycDocumentsTable.id, docId))
      .limit(1);
    if (!doc || doc.status === "deleted" || !doc.inlineBlob) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    let plain: Buffer;
    try {
      plain = decryptDocument(docId, doc.inlineBlob, doc.nonceHex);
    } catch (err) {
      logger.error(
        { err: (err as Error).message, docId },
        "admin_kyc_doc_decrypt_failed",
      );
      res.status(500).json({ error: "decrypt_failed" });
      return;
    }
    await recordAudit({
      actorId: reviewerId,
      action: "admin.kyc.document.read",
      entity: "kyc_document",
      entityId: docId,
      payload: { userId: doc.userId, kind: doc.kind },
      piiRead: true,
    });
    res.json({
      id: doc.id,
      kind: doc.kind,
      filename: doc.filename,
      contentType: doc.contentType,
      sizeBytes: doc.sizeBytes,
      sha256: doc.sha256,
      blobBase64: plain.toString("base64"),
    });
  },
);

/**
 * GET /admin/sanctions — sanctions / PEP screening review queue.
 */
router.get(
  "/admin/sanctions",
  requireRole(ADMIN_ONLY),
  async (req, res) => {
    const status = String(req.query.status ?? "all");
    const limit = Math.min(
      Math.max(Number(req.query.limit ?? 100), 1),
      200,
    );
    const where: SQL | undefined =
      status === "all"
        ? undefined
        : eq(schema.sanctionsScreeningsTable.status, status);
    const rows = await db
      .select()
      .from(schema.sanctionsScreeningsTable)
      .where(where)
      .orderBy(desc(schema.sanctionsScreeningsTable.createdAt))
      .limit(limit);
    const totalRows = await db
      .select({ c: count() })
      .from(schema.sanctionsScreeningsTable)
      .where(where);
    res.json({
      items: rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        subjectKind: r.subjectKind,
        provider: r.provider,
        subjectName: r.subjectName,
        subjectCountry: r.subjectCountry,
        matchScore: r.matchScore,
        status: r.status,
        note: r.note,
        nextReviewAtIso: r.nextReviewAt?.toISOString() ?? null,
        createdAtIso: r.createdAt.toISOString(),
        listHits: r.listHits ?? [],
      })),
      totalCount: totalRows[0]?.c ?? 0,
    });
  },
);

/**
 * GET /admin/ndpr/requests — cross-user data-subject request queue.
 */
router.get(
  "/admin/ndpr/requests",
  requireRole(ADMIN_ONLY),
  async (req, res) => {
    const kind = String(req.query.kind ?? "all");
    const status = String(req.query.status ?? "all");
    const limit = Math.min(
      Math.max(Number(req.query.limit ?? 100), 1),
      200,
    );
    const conds: SQL[] = [];
    if (kind !== "all")
      conds.push(eq(schema.ndprRequestsTable.kind, kind));
    if (status !== "all")
      conds.push(eq(schema.ndprRequestsTable.status, status));
    const where: SQL | undefined =
      conds.length === 0
        ? undefined
        : conds.length === 1
          ? conds[0]
          : and(...conds);
    const rows = await db
      .select()
      .from(schema.ndprRequestsTable)
      .where(where)
      .orderBy(desc(schema.ndprRequestsTable.createdAt))
      .limit(limit);
    const totalRows = await db
      .select({ c: count() })
      .from(schema.ndprRequestsTable)
      .where(where);
    res.json({
      items: rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        kind: r.kind,
        status: r.status,
        createdAtIso: r.createdAt.toISOString(),
        effectiveAtIso: r.effectiveAt?.toISOString() ?? null,
        completedAtIso: r.completedAt?.toISOString() ?? null,
        cancelledAtIso: r.cancelledAt?.toISOString() ?? null,
        failureReason: r.failureReason,
      })),
      totalCount: totalRows[0]?.c ?? 0,
    });
  },
);

/**
 * POST /admin/ndpr/requests/:id/cancel — operator cancels a pending NDPR
 * request (e.g. an in-grace erasure that the user wants reversed via support).
 */
router.post(
  "/admin/ndpr/requests/:id/cancel",
  requireRole(ADMIN_ONLY),
  async (req, res) => {
    const reviewerId = requireUserId(req, res);
    if (!reviewerId) return;
    const id = String(req.params.id ?? "");
    const note = String(req.body?.note ?? "").trim();
    const [row] = await db
      .select()
      .from(schema.ndprRequestsTable)
      .where(eq(schema.ndprRequestsTable.id, id))
      .limit(1);
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (row.status !== "pending") {
      res
        .status(409)
        .json({ error: "not_cancellable", detail: `status=${row.status}` });
      return;
    }
    await db
      .update(schema.ndprRequestsTable)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(eq(schema.ndprRequestsTable.id, id));
    await recordAudit({
      actorId: reviewerId,
      action: "admin.ndpr.request.cancelled",
      entity: "ndpr_request",
      entityId: id,
      payload: { kind: row.kind, userId: row.userId, note },
    });
    const [updated] = await db
      .select()
      .from(schema.ndprRequestsTable)
      .where(eq(schema.ndprRequestsTable.id, id))
      .limit(1);
    if (!updated) {
      res.status(500).json({ error: "ndpr_request_missing" });
      return;
    }
    res.json({
      id: updated.id,
      userId: updated.userId,
      kind: updated.kind,
      status: updated.status,
      createdAtIso: updated.createdAt.toISOString(),
      effectiveAtIso: updated.effectiveAt?.toISOString() ?? null,
      completedAtIso: updated.completedAt?.toISOString() ?? null,
      cancelledAtIso: updated.cancelledAt?.toISOString() ?? null,
      failureReason: updated.failureReason,
    });
  },
);

/**
 * GET /admin/audit — search the append-only audit log. Filterable by
 * actor, entity, entity id, action verb / prefix, sinceIso, and a
 * piiOnly boolean for NDPR Article 28 reviews.
 *
 * Reading the audit log is itself audited (meta-audit).
 */
router.get(
  "/admin/audit",
  requireRole(ADMIN_ONLY),
  async (req, res) => {
    const reviewerId = requireUserId(req, res);
    if (!reviewerId) return;
    const actorId = String(req.query.actorId ?? "").trim();
    const entity = String(req.query.entity ?? "").trim();
    const entityId = String(req.query.entityId ?? "").trim();
    const action = String(req.query.action ?? "").trim();
    const piiOnly =
      String(req.query.piiOnly ?? "").toLowerCase() === "true";
    const sinceIso = String(req.query.sinceIso ?? "").trim();
    const limit = Math.min(
      Math.max(Number(req.query.limit ?? 100), 1),
      500,
    );
    const conds: SQL[] = [];
    if (actorId)
      conds.push(eq(schema.auditEventsTable.actorId, actorId));
    if (entity) conds.push(eq(schema.auditEventsTable.entity, entity));
    if (entityId)
      conds.push(eq(schema.auditEventsTable.entityId, entityId));
    if (action) {
      // Trailing dot or `*` means prefix search.
      const prefix = action.endsWith("*")
        ? action.slice(0, -1)
        : action;
      if (action.endsWith("*") || action.endsWith(".")) {
        conds.push(like(schema.auditEventsTable.action, `${prefix}%`));
      } else {
        conds.push(eq(schema.auditEventsTable.action, action));
      }
    }
    if (piiOnly) conds.push(eq(schema.auditEventsTable.piiRead, true));
    if (sinceIso) {
      const since = new Date(sinceIso);
      if (!Number.isNaN(since.getTime())) {
        conds.push(gte(schema.auditEventsTable.createdAt, since));
      }
    }
    const where: SQL | undefined =
      conds.length === 0
        ? undefined
        : conds.length === 1
          ? conds[0]
          : and(...conds);
    const rows = await db
      .select()
      .from(schema.auditEventsTable)
      .where(where)
      .orderBy(desc(schema.auditEventsTable.seq))
      .limit(limit);
    const totalRows = await db
      .select({ c: count() })
      .from(schema.auditEventsTable)
      .where(where);
    await recordAudit({
      actorId: reviewerId,
      action: "admin.audit.search",
      entity: "audit_log",
      payload: { actorId, entity, entityId, action, piiOnly, sinceIso, limit },
      piiRead: true,
    });
    res.json({
      items: rows.map((r) => ({
        seq: r.seq,
        actorId: r.actorId,
        action: r.action,
        entity: r.entity,
        entityId: r.entityId,
        piiRead: r.piiRead,
        payload: r.payload ?? {},
        createdAtIso: r.createdAt.toISOString(),
      })),
      totalCount: totalRows[0]?.c ?? 0,
    });
  },
);

export default router;
