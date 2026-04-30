import { createHash, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { eq, and, gte, inArray, sql } from "drizzle-orm";
import { db, schema } from "./db";
import { logger } from "./logger";
import { recordAudit } from "./audit";

const TIER2_THRESHOLD_MINOR = 50_000_000; // NGN 500k → 500_000 * 100
const TIER3_THRESHOLD_MINOR = 500_000_000; // NGN 5M → 5_000_000 * 100

const ALLOWED_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "application/pdf"]);
const MAX_DOC_BYTES = 6 * 1024 * 1024; // 6 MB

export type KycDocumentKind =
  | "gov_id"
  | "cac"
  | "ubo"
  | "bank_verification"
  | "selfie"
  | "address_proof";

export type KycVerificationKind = "gov_id" | "cac" | "ubo" | "bank_verification";

const KIND_TARGET_TIER: Record<KycVerificationKind, number> = {
  gov_id: 2,
  bank_verification: 2,
  cac: 3,
  ubo: 3,
};

function deriveDocKey(documentId: string): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("SESSION_SECRET must be set and >= 16 chars to encrypt KYC documents");
  }
  return createHash("sha256").update(secret).update("\nkyc:").update(documentId).digest();
}

export function encryptDocument(documentId: string, plaintext: Buffer): { ciphertextB64: string; nonceHex: string; sha256: string } {
  const key = deriveDocKey(documentId);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertextB64: Buffer.concat([enc, tag]).toString("base64"),
    nonceHex: nonce.toString("hex"),
    sha256: createHash("sha256").update(plaintext).digest("hex"),
  };
}

export function decryptDocument(documentId: string, ciphertextB64: string, nonceHex: string): Buffer {
  const key = deriveDocKey(documentId);
  const nonce = Buffer.from(nonceHex, "hex");
  const buf = Buffer.from(ciphertextB64, "base64");
  const tag = buf.subarray(buf.length - 16);
  const enc = buf.subarray(0, buf.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

export function validateUpload(contentType: string, sizeBytes: number): string | null {
  if (!ALLOWED_CONTENT_TYPES.has(contentType.toLowerCase())) return "unsupported_content_type";
  if (sizeBytes <= 0) return "empty_blob";
  if (sizeBytes > MAX_DOC_BYTES) return "blob_too_large";
  return null;
}

/**
 * Compute the rolling-30-day GMV window for a seller and the tier required
 * by that window. Counted GMV is the *seller-share* portion of paid orders,
 * derived from `payouts.amount_minor` rows of kind=seller_share that were
 * scheduled in the last 30 days.
 */
export async function evaluateSellerThreshold(sellerId: string): Promise<{ gmvMinor: number; requiredTier: number }> {
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const rows = await db
    .select({ amountMinor: schema.payoutsTable.amountMinor })
    .from(schema.payoutsTable)
    .where(
      and(
        eq(schema.payoutsTable.sellerId, sellerId),
        eq(schema.payoutsTable.kind, "seller_share"),
        gte(schema.payoutsTable.requestedAt, since),
      ),
    );
  const gmvMinor = rows.reduce((s, r) => s + (r.amountMinor ?? 0), 0);
  const requiredTier = gmvMinor >= TIER3_THRESHOLD_MINOR ? 3 : gmvMinor >= TIER2_THRESHOLD_MINOR ? 2 : 1;
  // Persist for fast lookup by the payout cron.
  await db
    .insert(schema.sellerThresholdsTable)
    .values({
      sellerId,
      rolling30dGmvMinor: gmvMinor,
      lastOrderAt: new Date(),
      requiredKycTier: requiredTier,
    })
    .onConflictDoUpdate({
      target: schema.sellerThresholdsTable.sellerId,
      set: { rolling30dGmvMinor: gmvMinor, lastOrderAt: new Date(), requiredKycTier: requiredTier },
    });
  return { gmvMinor, requiredTier };
}

/**
 * Required tier for a hypothetical *additional* GMV add-on. Used by the
 * pre-payout gate to make tier decisions BEFORE inserting the payout row.
 */
export async function requiredTierForOrder(sellerId: string, addGmvMinor: number): Promise<{ gmvMinor: number; requiredTier: number }> {
  const { gmvMinor } = await evaluateSellerThreshold(sellerId);
  const projected = gmvMinor + addGmvMinor;
  const requiredTier = projected >= TIER3_THRESHOLD_MINOR ? 3 : projected >= TIER2_THRESHOLD_MINOR ? 2 : 1;
  return { gmvMinor: projected, requiredTier };
}

export async function currentKycTier(userId: string): Promise<number> {
  const [row] = await db
    .select({ kycTier: schema.sellersTable.kycTier })
    .from(schema.sellersTable)
    .where(eq(schema.sellersTable.userId, userId))
    .limit(1);
  return row?.kycTier ?? 1;
}

/**
 * Approve a KYC verification: marks the row approved, marks attached docs
 * uploaded, and promotes the seller's `kycTier` to max(current, target).
 * Idempotent.
 */
export async function approveVerification(
  verificationId: string,
  reviewerId: string,
  note: string,
): Promise<{ ok: true; kycTier: number } | { ok: false; reason: string }> {
  const [v] = await db
    .select()
    .from(schema.kycVerificationsTable)
    .where(eq(schema.kycVerificationsTable.id, verificationId))
    .limit(1);
  if (!v) return { ok: false, reason: "not_found" };
  if (v.status === "approved") {
    const tier = await currentKycTier(v.userId);
    return { ok: true, kycTier: tier };
  }
  // Hard guard: only verifications the seller has formally submitted are
  // eligible for approval. This prevents reviewers (or a forged admin
  // request) from promoting a tier on a draft/empty ticket. `submitVerification`
  // also enforces required-doc completeness before flipping status to
  // `pending_review`, so reaching this branch implies docs are present.
  if (v.status !== "pending_review") {
    return { ok: false, reason: `bad_status:${v.status}` };
  }
  // Defense in depth: re-check tier prerequisites at approval time.
  // The submit gate already runs this, but a verification could in
  // principle sit in pending_review while docs the user previously
  // attached are deleted (status flipped to "deleted"). Re-running
  // here ensures the reviewer is never the last line of defense.
  const submittedDocIds = ((v.documentIds ?? []) as string[]) ?? [];
  const stillMissing = await missingKindsForTier(v.userId, v.targetTier, submittedDocIds);
  if (stillMissing.length > 0) {
    return { ok: false, reason: `missing_required_kinds:${stillMissing.join(",")}` };
  }
  await db
    .update(schema.kycVerificationsTable)
    .set({ status: "approved", reviewerNote: note, reviewedBy: reviewerId, reviewedAt: new Date() })
    .where(eq(schema.kycVerificationsTable.id, verificationId));
  // Promote seller tier — never demote on approval.
  const seller = await db
    .select()
    .from(schema.sellersTable)
    .where(eq(schema.sellersTable.userId, v.userId))
    .limit(1);
  const currentTier = seller[0]?.kycTier ?? 1;
  const newTier = Math.max(currentTier, v.targetTier);
  await db
    .insert(schema.sellersTable)
    .values({ userId: v.userId, kycTier: newTier })
    .onConflictDoUpdate({ target: schema.sellersTable.userId, set: { kycTier: newTier } });
  await recordAudit({
    actorId: reviewerId,
    action: "kyc.verification.approved",
    entity: "kyc_verification",
    entityId: verificationId,
    payload: { userId: v.userId, targetTier: v.targetTier, newTier },
  });
  return { ok: true, kycTier: newTier };
}

export async function rejectVerification(
  verificationId: string,
  reviewerId: string,
  note: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [v] = await db
    .select()
    .from(schema.kycVerificationsTable)
    .where(eq(schema.kycVerificationsTable.id, verificationId))
    .limit(1);
  if (!v) return { ok: false, reason: "not_found" };
  await db
    .update(schema.kycVerificationsTable)
    .set({ status: "rejected", reviewerNote: note, reviewedBy: reviewerId, reviewedAt: new Date() })
    .where(eq(schema.kycVerificationsTable.id, verificationId));
  await recordAudit({
    actorId: reviewerId,
    action: "kyc.verification.rejected",
    entity: "kyc_verification",
    entityId: verificationId,
    payload: { userId: v.userId, note },
  });
  return { ok: true };
}

export async function listUserDocuments(userId: string): Promise<Array<{
  id: string;
  kind: string;
  filename: string;
  status: string;
  createdAtIso: string;
}>> {
  const rows = await db
    .select()
    .from(schema.kycDocumentsTable)
    .where(eq(schema.kycDocumentsTable.userId, userId))
    .orderBy(sql`${schema.kycDocumentsTable.createdAt} desc`);
  return rows
    .filter((r) => r.status !== "deleted")
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      filename: r.filename,
      status: r.status,
      createdAtIso: r.createdAt.toISOString(),
    }));
}

/**
 * Compliance gate: each tier requires a specific set of document KINDs to be
 * uploaded. Tier 3 also inherits Tier 2's required kinds (a CAC + UBO without
 * gov_id and bank_verification can't legally underwrite a payout).
 *
 * Returns the list of kinds the user is still missing for the given target
 * tier, considering:
 *   - all docs the user has already uploaded (any past verification)
 *   - the docs about to be attached to the verification being submitted
 *
 * Reviewers MUST NOT be able to flip a verification to "approved" if this
 * helper returns a non-empty array — promote a tier without the underlying
 * evidence and we fail SCUML / NDPR Article 5(d) data-quality at audit.
 */
const TIER_REQUIRED_KINDS: Record<number, KycVerificationKind[]> = {
  1: [],
  2: ["gov_id", "bank_verification"],
  3: ["gov_id", "bank_verification", "cac", "ubo"],
};

export async function missingKindsForTier(
  userId: string,
  targetTier: number,
  extraDocIds: string[] = [],
): Promise<KycVerificationKind[]> {
  const required = TIER_REQUIRED_KINDS[targetTier] ?? [];
  if (required.length === 0) return [];
  // Only docs that are actually present (uploaded) or already approved
  // count toward tier prerequisites. `claimed` rows are stubs created by
  // /kyc/documents before bytes arrive — accepting them would let a
  // seller submit empty placeholders and still pass the gate. `rejected`
  // and `deleted` rows have no evidentiary value.
  const VALID_DOC_STATUSES = new Set(["uploaded", "approved"]);
  const owned = await db
    .select({ id: schema.kycDocumentsTable.id, kind: schema.kycDocumentsTable.kind, status: schema.kycDocumentsTable.status })
    .from(schema.kycDocumentsTable)
    .where(eq(schema.kycDocumentsTable.userId, userId));
  const haveKinds = new Set<string>();
  for (const d of owned) {
    if (!VALID_DOC_STATUSES.has(d.status)) continue;
    haveKinds.add(d.kind);
  }
  // Include the docs in this submission even if they haven't been re-fetched.
  if (extraDocIds.length > 0) {
    const extras = await db
      .select({ id: schema.kycDocumentsTable.id, kind: schema.kycDocumentsTable.kind, status: schema.kycDocumentsTable.status })
      .from(schema.kycDocumentsTable)
      .where(and(
        eq(schema.kycDocumentsTable.userId, userId),
        inArray(schema.kycDocumentsTable.id, extraDocIds),
      ));
    for (const d of extras) if (VALID_DOC_STATUSES.has(d.status)) haveKinds.add(d.kind);
  }
  return required.filter((k) => !haveKinds.has(k));
}

export const KYC_CONSTANTS = {
  TIER2_THRESHOLD_MINOR,
  TIER3_THRESHOLD_MINOR,
  MAX_DOC_BYTES,
  ALLOWED_CONTENT_TYPES: Array.from(ALLOWED_CONTENT_TYPES),
  KIND_TARGET_TIER,
  TIER_REQUIRED_KINDS,
};

logger.debug?.({ tier2: TIER2_THRESHOLD_MINOR, tier3: TIER3_THRESHOLD_MINOR }, "kyc_thresholds_loaded");
