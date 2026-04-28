import { createHash, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { eq, and, gte, sql } from "drizzle-orm";
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

export const KYC_CONSTANTS = {
  TIER2_THRESHOLD_MINOR,
  TIER3_THRESHOLD_MINOR,
  MAX_DOC_BYTES,
  ALLOWED_CONTENT_TYPES: Array.from(ALLOWED_CONTENT_TYPES),
  KIND_TARGET_TIER,
};

logger.debug?.({ tier2: TIER2_THRESHOLD_MINOR, tier3: TIER3_THRESHOLD_MINOR }, "kyc_thresholds_loaded");
