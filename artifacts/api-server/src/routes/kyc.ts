import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db, schema } from "../lib/db";
import { requireUserId } from "../lib/auth";
import {
  KYC_CONSTANTS,
  encryptDocument,
  decryptDocument,
  validateUpload,
  evaluateSellerThreshold,
  currentKycTier,
  listUserDocuments,
  type KycDocumentKind,
  type KycVerificationKind,
} from "../lib/kyc";
import { recordAudit } from "../lib/audit";
import { logger } from "../lib/logger";
import { screenSubject } from "../lib/sanctions";

const router: IRouter = Router();

const ALLOWED_DOC_KINDS: ReadonlySet<KycDocumentKind> = new Set([
  "gov_id",
  "cac",
  "ubo",
  "bank_verification",
  "selfie",
  "address_proof",
]);

const ALLOWED_VERIF_KINDS: ReadonlySet<KycVerificationKind> = new Set([
  "gov_id",
  "cac",
  "ubo",
  "bank_verification",
]);

function newDocId(): string {
  return `kdoc_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
}
function newVerifId(): string {
  return `kver_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
}

/**
 * GET /kyc/me — caller's KYC status.
 */
router.get("/kyc/me", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const tier = await currentKycTier(userId);
  const { gmvMinor, requiredTier } = await evaluateSellerThreshold(userId);
  const verifications = await db
    .select()
    .from(schema.kycVerificationsTable)
    .where(eq(schema.kycVerificationsTable.userId, userId));
  const documents = await listUserDocuments(userId);
  res.json({
    kycTier: tier,
    requiredKycTier: requiredTier,
    rolling30dGmvMinor: gmvMinor,
    thresholds: {
      tier2Minor: KYC_CONSTANTS.TIER2_THRESHOLD_MINOR,
      tier3Minor: KYC_CONSTANTS.TIER3_THRESHOLD_MINOR,
    },
    verifications: verifications.map((v) => ({
      id: v.id,
      kind: v.kind,
      targetTier: v.targetTier,
      status: v.status,
      reviewerNote: v.reviewerNote,
      submittedAtIso: v.submittedAt?.toISOString() ?? null,
      reviewedAtIso: v.reviewedAt?.toISOString() ?? null,
    })),
    documents,
  });
});

/**
 * POST /kyc/documents — claim a document slot. Returns an upload token
 * that the client uses to PUT the encrypted blob.
 */
router.post("/kyc/documents", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const body = req.body as { kind?: string; filename?: string; contentType?: string; sizeBytes?: number };
  const kind = String(body.kind ?? "") as KycDocumentKind;
  if (!ALLOWED_DOC_KINDS.has(kind)) {
    res.status(400).json({ error: "bad_kind" });
    return;
  }
  const validationErr = validateUpload(String(body.contentType ?? ""), Number(body.sizeBytes ?? 0));
  if (validationErr) {
    res.status(400).json({ error: validationErr });
    return;
  }
  const id = newDocId();
  await db.insert(schema.kycDocumentsTable).values({
    id,
    userId,
    kind,
    filename: String(body.filename ?? ""),
    contentType: String(body.contentType ?? ""),
    sizeBytes: Number(body.sizeBytes ?? 0),
    status: "claimed",
  });
  await recordAudit({
    actorId: userId,
    action: "kyc.document.claimed",
    entity: "kyc_document",
    entityId: id,
    payload: { kind, sizeBytes: Number(body.sizeBytes ?? 0) },
  });
  res.status(201).json({ id, uploadPath: `/api/kyc/documents/${id}/upload` });
});

/**
 * PUT /kyc/documents/:id/upload — body is base64-encoded blob bytes.
 * Encrypts with AES-256-GCM using a per-doc key derived from SESSION_SECRET
 * and stores inline (dev) or in object storage (prod, when configured).
 */
router.put("/kyc/documents/:id/upload", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const docId = req.params.id;
  const body = req.body as { blobBase64?: string };
  if (typeof body.blobBase64 !== "string" || body.blobBase64.length === 0) {
    res.status(400).json({ error: "missing_blob" });
    return;
  }
  const [doc] = await db
    .select()
    .from(schema.kycDocumentsTable)
    .where(and(eq(schema.kycDocumentsTable.id, docId), eq(schema.kycDocumentsTable.userId, userId)))
    .limit(1);
  if (!doc) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (doc.status !== "claimed") {
    res.status(409).json({ error: "already_uploaded" });
    return;
  }
  const plain = Buffer.from(body.blobBase64, "base64");
  const validationErr = validateUpload(doc.contentType, plain.length);
  if (validationErr) {
    res.status(400).json({ error: validationErr });
    return;
  }
  const { ciphertextB64, nonceHex, sha256 } = encryptDocument(docId, plain);
  await db
    .update(schema.kycDocumentsTable)
    .set({
      inlineBlob: ciphertextB64,
      nonceHex,
      sha256,
      sizeBytes: plain.length,
      status: "uploaded",
      uploadedAt: new Date(),
    })
    .where(eq(schema.kycDocumentsTable.id, docId));
  await recordAudit({
    actorId: userId,
    action: "kyc.document.uploaded",
    entity: "kyc_document",
    entityId: docId,
    payload: { sha256, sizeBytes: plain.length },
  });
  res.json({ ok: true, sha256 });
});

/**
 * GET /kyc/documents/:id — owner downloads the decrypted blob (audited).
 * Returns base64 in JSON to keep the API uniform; clients decode client-side.
 */
router.get("/kyc/documents/:id", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const docId = req.params.id;
  const [doc] = await db
    .select()
    .from(schema.kycDocumentsTable)
    .where(and(eq(schema.kycDocumentsTable.id, docId), eq(schema.kycDocumentsTable.userId, userId)))
    .limit(1);
  if (!doc || doc.status !== "uploaded" || !doc.inlineBlob) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  let plain: Buffer;
  try {
    plain = decryptDocument(docId, doc.inlineBlob, doc.nonceHex);
  } catch (err) {
    logger.error({ err: (err as Error).message, docId }, "kyc_doc_decrypt_failed");
    res.status(500).json({ error: "decrypt_failed" });
    return;
  }
  await recordAudit({
    actorId: userId,
    action: "kyc.document.read",
    entity: "kyc_document",
    entityId: docId,
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
});

/**
 * POST /kyc/start — open a verification ticket for a given kind.
 */
router.post("/kyc/start", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const body = req.body as {
    kind?: string;
    tier?: number;
    documentIds?: string[];
    subjectName?: string;
    country?: string;
  };
  const kind = String(body.kind ?? "") as KycVerificationKind;
  if (!ALLOWED_VERIF_KINDS.has(kind)) {
    res.status(400).json({ error: "bad_kind" });
    return;
  }
  const documentIds = Array.isArray(body.documentIds) ? body.documentIds.map(String) : [];
  // Caller may explicitly request a target tier (e.g. UI picks Tier 3 with
  // kind=cac, also wants the verification recorded as targeting Tier 3).
  // We clamp into [kind's natural tier, 3] so the caller can only widen,
  // never narrow — a `gov_id` row can be Tier 2 or Tier 3 (covers both),
  // but `cac/ubo` cannot be downgraded to Tier 2.
  const naturalTier = KYC_CONSTANTS.KIND_TARGET_TIER[kind] ?? 1;
  const requested = Number.isFinite(body.tier) ? Number(body.tier) : naturalTier;
  const targetTier = Math.min(3, Math.max(naturalTier, requested));
  const id = newVerifId();
  await db.insert(schema.kycVerificationsTable).values({
    id,
    userId,
    kind,
    targetTier,
    status: "draft",
    documentIds,
  });
  // Run an opportunistic sanctions screen on opening (cheap stub in dev,
  // real provider in prod). Result is persisted; the payout gate uses it.
  await screenSubject({
    userId,
    name: String(body.subjectName ?? userId),
    country: String(body.country ?? "NG"),
  });
  await recordAudit({
    actorId: userId,
    action: "kyc.verification.started",
    entity: "kyc_verification",
    entityId: id,
    payload: { kind, targetTier, documentIds },
  });
  res.status(201).json({ id, kind, targetTier, status: "draft" });
});

/**
 * POST /kyc/verifications/:id/submit — caller submits for human review.
 */
router.post("/kyc/verifications/:id/submit", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const verifId = req.params.id;
  const body = (req.body ?? {}) as { documentIds?: string[] };
  const [v] = await db
    .select()
    .from(schema.kycVerificationsTable)
    .where(and(eq(schema.kycVerificationsTable.id, verifId), eq(schema.kycVerificationsTable.userId, userId)))
    .limit(1);
  if (!v) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (v.status === "approved") {
    res.json({ id: v.id, status: v.status });
    return;
  }
  // Two ways to attach docs:
  //   1) Caller passes `documentIds` in the submit body (the UI uploads
  //      first, then references the doc IDs here). Always wins.
  //   2) Caller relied on docs attached at /kyc/start time.
  // If neither is populated we auto-attach every uploaded doc the user
  // currently owns — this matches the "upload then submit" UX where the
  // verification starts empty.
  let docIds = Array.isArray(body.documentIds) && body.documentIds.length > 0
    ? body.documentIds.map(String)
    : ((v.documentIds ?? []) as string[]);
  if (docIds.length === 0) {
    const uploaded = await db
      .select({ id: schema.kycDocumentsTable.id })
      .from(schema.kycDocumentsTable)
      .where(
        and(
          eq(schema.kycDocumentsTable.userId, userId),
          eq(schema.kycDocumentsTable.status, "uploaded"),
        ),
      );
    docIds = uploaded.map((d) => d.id);
  }
  if (docIds.length === 0) {
    res.status(400).json({ error: "no_documents" });
    return;
  }
  // Persist the (possibly newly-resolved) doc list onto the verification
  // so audit + admin review have a stable record of what was submitted.
  await db
    .update(schema.kycVerificationsTable)
    .set({ documentIds: docIds })
    .where(eq(schema.kycVerificationsTable.id, verifId));
  const docs = await db
    .select()
    .from(schema.kycDocumentsTable)
    .where(eq(schema.kycDocumentsTable.userId, userId));
  const docById = new Map(docs.map((d) => [d.id, d]));
  for (const id of docIds) {
    const d = docById.get(id);
    if (!d || d.status !== "uploaded") {
      res.status(400).json({ error: "document_not_uploaded", documentId: id });
      return;
    }
  }
  await db
    .update(schema.kycVerificationsTable)
    .set({ status: "pending_review", submittedAt: new Date() })
    .where(eq(schema.kycVerificationsTable.id, verifId));
  await recordAudit({
    actorId: userId,
    action: "kyc.verification.submitted",
    entity: "kyc_verification",
    entityId: verifId,
    payload: { documentCount: docIds.length },
  });
  res.json({ id: verifId, status: "pending_review" });
});

export default router;
