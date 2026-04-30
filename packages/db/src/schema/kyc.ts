import { pgTable, text, integer, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * KYC documents — one row per uploaded artefact (gov ID, CAC certificate,
 * UBO declaration, bank-verification screenshot, etc.). The actual blob is
 * either stored in object storage (preferred) and referenced by `storageKey`,
 * OR — when no bucket is configured (dev) — held inline in `inlineBlob` as
 * base64. The plaintext blob is encrypted at rest with a per-document key
 * derived from SESSION_SECRET (see lib/kyc.ts).
 */
export const kycDocumentsTable = pgTable(
  "kyc_documents",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    /** "gov_id" | "cac" | "ubo" | "bank_verification" | "selfie" | "address_proof" */
    kind: text("kind").notNull(),
    /** Original filename for audit / display. */
    filename: text("filename").notNull().default(""),
    /** image/jpeg | image/png | application/pdf */
    contentType: text("content_type").notNull().default(""),
    /** Bytes of the (plaintext) document. */
    sizeBytes: integer("size_bytes").notNull().default(0),
    /** Object-storage key when uploaded to a bucket. */
    storageKey: text("storage_key"),
    /** Inline encrypted base64 blob when no bucket is configured. */
    inlineBlob: text("inline_blob"),
    /** Per-document encryption nonce (hex). */
    nonceHex: text("nonce_hex").notNull().default(""),
    /** SHA-256 of plaintext, for dedupe / integrity. */
    sha256: text("sha256").notNull().default(""),
    /** "claimed" | "uploaded" | "rejected" | "deleted" */
    status: text("status").notNull().default("claimed"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("kyc_documents_user_idx").on(t.userId, t.kind),
  ],
);

/**
 * KYC verifications — a verification ticket combines several documents and
 * carries the human/automated review verdict. Promoting a seller's `kycTier`
 * is the side-effect of approving a verification.
 */
export const kycVerificationsTable = pgTable(
  "kyc_verifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    /** "gov_id" (tier 2) | "cac" (tier 3) | "ubo" (tier 3) | "bank_verification" */
    kind: text("kind").notNull(),
    /** Target tier this verification supports if approved. */
    targetTier: integer("target_tier").notNull().default(1),
    /** "draft" | "pending_review" | "approved" | "rejected" */
    status: text("status").notNull().default("draft"),
    /** Document ids attached to this verification. */
    documentIds: jsonb("document_ids").$type<string[]>().notNull().default([]),
    /** Reviewer notes (admin) or rejection reason. */
    reviewerNote: text("reviewer_note").notNull().default(""),
    reviewedBy: text("reviewed_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("kyc_verifications_user_idx").on(t.userId, t.status),
  ],
);

/**
 * Rolling 30-day GMV window per seller. Maintained by `evaluateSellerThreshold`
 * which is called from order-finalize so every paid order pushes/refreshes
 * the window. Used to decide whether tier 2 / tier 3 KYC is required.
 */
export const sellerThresholdsTable = pgTable(
  "seller_thresholds",
  {
    sellerId: text("seller_id").primaryKey(),
    /** Sum of seller-share net minor over the past 30 days. */
    rolling30dGmvMinor: integer("rolling_30d_gmv_minor").notNull().default(0),
    /** Latest order timestamp counted. */
    lastOrderAt: timestamp("last_order_at", { withTimezone: true }),
    /** Currently required KYC tier (1, 2, or 3) computed from the window. */
    requiredKycTier: integer("required_kyc_tier").notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
);

export type KycDocument = typeof kycDocumentsTable.$inferSelect;
export type KycVerification = typeof kycVerificationsTable.$inferSelect;
export type SellerThreshold = typeof sellerThresholdsTable.$inferSelect;
