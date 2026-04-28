import { randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { eq, and } from "drizzle-orm";
import { db, schema } from "./db";
import { logger } from "./logger";
import { recordAudit } from "./audit";
import { getUserId } from "./auth";

const ERASE_GRACE_MS = 30 * 24 * 3600 * 1000;
const EXPORT_RATE_LIMIT_MS = 30 * 24 * 3600 * 1000; // one export per 30 days

export type NdprKind = "export" | "erase" | "rectify" | "restrict" | "portability";

export function newNdprId(kind: NdprKind): string {
  return `ndpr_${kind}_${Date.now().toString(36)}_${randomBytes(2).toString("hex")}`;
}

export function newBundleToken(): string {
  return randomBytes(24).toString("hex");
}

/**
 * Assemble a portable JSON bundle of every row owned by the user.
 * Does NOT delete or anonymise — that's `applyErase` below.
 */
export async function buildExportBundle(userId: string): Promise<Record<string, unknown>> {
  const [user] = await db.select().from(schema.usersTable).where(eq(schema.usersTable.clerkId, userId)).limit(1);
  const orders = await db.select().from(schema.ordersTable).where(eq(schema.ordersTable.userId, userId));
  const cart = await db.select().from(schema.cartItemsTable).where(eq(schema.cartItemsTable.userId, userId));
  const wallet = await db.select().from(schema.walletTxnsTable).where(eq(schema.walletTxnsTable.userId, userId));
  const wishlist = await db.select().from(schema.wishlistTable).where(eq(schema.wishlistTable.userId, userId));
  const reviews = await db.select().from(schema.reviewsTable).where(eq(schema.reviewsTable.userId, userId));
  const onboarding = await db.select().from(schema.onboardingTable).where(eq(schema.onboardingTable.userId, userId));
  const seller = await db.select().from(schema.sellersTable).where(eq(schema.sellersTable.userId, userId));
  const payouts = await db.select().from(schema.payoutsTable).where(eq(schema.payoutsTable.userId, userId));
  const kycDocs = await db.select().from(schema.kycDocumentsTable).where(eq(schema.kycDocumentsTable.userId, userId));
  const kycVerifs = await db.select().from(schema.kycVerificationsTable).where(eq(schema.kycVerificationsTable.userId, userId));
  // Strip the actual document blob from the export — the user receives
  // metadata. The blob can be downloaded separately via the document API.
  const kycDocsScrubbed = kycDocs.map((d) => ({
    id: d.id,
    kind: d.kind,
    filename: d.filename,
    contentType: d.contentType,
    sizeBytes: d.sizeBytes,
    sha256: d.sha256,
    status: d.status,
    createdAtIso: d.createdAt.toISOString(),
  }));
  return {
    schemaVersion: 1,
    generatedAtIso: new Date().toISOString(),
    user,
    orders,
    cart,
    wallet,
    wishlist,
    reviews,
    onboarding,
    seller,
    payouts,
    kycDocuments: kycDocsScrubbed,
    kycVerifications: kycVerifs,
  };
}

/**
 * Apply an approved (i.e. effective) erase request:
 * - Anonymise PII columns on the users row.
 * - Cascade-delete cart, wishlist, addresses, payment methods, push tokens,
 *   recently viewed, recent searches, follows, notifications, KYC docs.
 * - Preserve orders, payments, payouts, audit, sanctions screenings, and
 *   reviews (FIRS / NDPR financial-record retention) but disconnect the
 *   user identifier where possible (orders keep userId for FIRS audits).
 */
export async function applyErase(userId: string): Promise<void> {
  const anonymised = `erased_${userId.slice(-6)}`;
  await db
    .update(schema.usersTable)
    .set({
      email: `${anonymised}@erased.invalid`,
      displayName: "Erased User",
      avatarUrl: "",
      phone: null,
      phoneCountry: null,
      addresses: [],
      paymentMethods: [],
      dataDeletedAt: new Date(),
    })
    .where(eq(schema.usersTable.clerkId, userId));
  await db.delete(schema.cartItemsTable).where(eq(schema.cartItemsTable.userId, userId));
  await db.delete(schema.wishlistTable).where(eq(schema.wishlistTable.userId, userId));
  await db.delete(schema.recentlyViewedTable).where(eq(schema.recentlyViewedTable.userId, userId));
  await db.delete(schema.recentSearchesTable).where(eq(schema.recentSearchesTable.userId, userId));
  await db.delete(schema.followsTable).where(eq(schema.followsTable.userId, userId));
  await db.delete(schema.notificationsOutboxTable).where(eq(schema.notificationsOutboxTable.userId, userId));
  await db.delete(schema.pushTokensTable).where(eq(schema.pushTokensTable.userId, userId));
  // KYC docs are personal — purge them. Verifications stay (FIRS + audit
  // need them), but their attached doc-id list is left dangling intentionally.
  await db
    .update(schema.kycDocumentsTable)
    .set({ status: "deleted", inlineBlob: null, storageKey: null, deletedAt: new Date() })
    .where(eq(schema.kycDocumentsTable.userId, userId));
  await recordAudit({
    actorId: null,
    action: "ndpr.erase.applied",
    entity: "user",
    entityId: userId,
    payload: { anonymisedAs: anonymised },
  });
}

/**
 * Rectify: patch user fields from `body` and audit the change.
 */
export async function applyRectify(
  userId: string,
  body: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const allowed: Partial<typeof schema.usersTable.$inferInsert> = {};
  if (typeof body.displayName === "string") allowed.displayName = body.displayName;
  if (typeof body.email === "string") allowed.email = body.email;
  if (typeof body.phone === "string") allowed.phone = body.phone;
  if (typeof body.countryCode === "string") allowed.countryCode = body.countryCode;
  if (Object.keys(allowed).length === 0) return { ok: false, reason: "no_fields" };
  await db.update(schema.usersTable).set(allowed).where(eq(schema.usersTable.clerkId, userId));
  await recordAudit({
    actorId: userId,
    action: "ndpr.rectify.applied",
    entity: "user",
    entityId: userId,
    payload: { fields: Object.keys(allowed) },
  });
  return { ok: true };
}

/**
 * Restrict-processing flag — sets `processing_restricted_at`. Used by
 * `requireProcessingNotRestricted` middleware to short-circuit mutating
 * endpoints with 423 Locked.
 */
export async function applyRestrict(userId: string): Promise<void> {
  await db
    .update(schema.usersTable)
    .set({ processingRestrictedAt: new Date() })
    .where(eq(schema.usersTable.clerkId, userId));
  await recordAudit({
    actorId: userId,
    action: "ndpr.restrict.applied",
    entity: "user",
    entityId: userId,
  });
}

export async function liftRestrict(userId: string): Promise<void> {
  await db
    .update(schema.usersTable)
    .set({ processingRestrictedAt: null })
    .where(eq(schema.usersTable.clerkId, userId));
  await recordAudit({
    actorId: userId,
    action: "ndpr.restrict.lifted",
    entity: "user",
    entityId: userId,
  });
}

/**
 * Cron tick: process due NDPR requests.
 * - Pending exports → assemble bundle.
 * - Pending erases past `effectiveAt` → apply erase + mark completed.
 */
export async function processDueNdprRequests(): Promise<{ exports: number; erases: number }> {
  let exports = 0;
  let erases = 0;
  const pending = await db
    .select()
    .from(schema.ndprRequestsTable)
    .where(eq(schema.ndprRequestsTable.status, "pending"));
  for (const row of pending) {
    try {
      if (row.kind === "export" || row.kind === "portability") {
        const bundle = await buildExportBundle(row.userId);
        await db
          .update(schema.ndprRequestsTable)
          .set({
            bundlePayload: bundle,
            bundleToken: newBundleToken(),
            status: "ready",
            completedAt: new Date(),
          })
          .where(eq(schema.ndprRequestsTable.id, row.id));
        await recordAudit({
          actorId: null,
          action: `ndpr.${row.kind}.ready`,
          entity: "ndpr_request",
          entityId: row.id,
          payload: { userId: row.userId },
          piiRead: true,
        });
        exports++;
      } else if (row.kind === "erase") {
        if (!row.effectiveAt || row.effectiveAt.getTime() > Date.now()) continue;
        await applyErase(row.userId);
        await db
          .update(schema.ndprRequestsTable)
          .set({ status: "completed", completedAt: new Date() })
          .where(eq(schema.ndprRequestsTable.id, row.id));
        erases++;
      } else if (row.kind === "rectify") {
        const result = await applyRectify(row.userId, row.requestBody);
        await db
          .update(schema.ndprRequestsTable)
          .set({
            status: result.ok ? "completed" : "failed",
            failureReason: result.ok ? "" : result.reason,
            completedAt: new Date(),
          })
          .where(eq(schema.ndprRequestsTable.id, row.id));
      } else if (row.kind === "restrict") {
        await applyRestrict(row.userId);
        await db
          .update(schema.ndprRequestsTable)
          .set({ status: "completed", completedAt: new Date() })
          .where(eq(schema.ndprRequestsTable.id, row.id));
      }
    } catch (err) {
      logger.error({ err: (err as Error).message, requestId: row.id }, "ndpr_process_failed");
      await db
        .update(schema.ndprRequestsTable)
        .set({ status: "failed", failureReason: (err as Error).message })
        .where(eq(schema.ndprRequestsTable.id, row.id));
    }
  }
  return { exports, erases };
}

export const NDPR_CONSTANTS = { ERASE_GRACE_MS, EXPORT_RATE_LIMIT_MS };

/**
 * Express middleware: blocks mutating requests for users who have invoked
 * NDPR Article 19 (Right to Restriction of Processing). Returns 423 Locked
 * with a small JSON body so the client can surface the state. Always lets
 * NDPR routes through so the user can lift the restriction or cancel an
 * erase, and never gates unauthenticated traffic (anonymous reads or
 * webhooks should not 423 on a session lookup miss).
 */
const RESTRICT_BYPASS_PATHS = [
  "/ndpr/",
  "/auth/",
  "/healthz",
  "/webhooks/",
];
export async function requireProcessingNotRestricted(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const method = req.method.toUpperCase();
  if (method !== "POST" && method !== "PUT" && method !== "PATCH" && method !== "DELETE") {
    next();
    return;
  }
  if (RESTRICT_BYPASS_PATHS.some((p) => req.path.startsWith(p))) {
    next();
    return;
  }
  const userId = getUserId(req);
  if (!userId) {
    next();
    return;
  }
  const [u] = await db
    .select({ restrictedAt: schema.usersTable.processingRestrictedAt })
    .from(schema.usersTable)
    .where(eq(schema.usersTable.clerkId, userId))
    .limit(1);
  if (u?.restrictedAt) {
    res.status(423).json({ error: "processing_restricted" });
    return;
  }
  next();
}

/** Helper to find an active erase request (pending, not yet effective). */
export async function findActiveErase(userId: string) {
  const [row] = await db
    .select()
    .from(schema.ndprRequestsTable)
    .where(
      and(
        eq(schema.ndprRequestsTable.userId, userId),
        eq(schema.ndprRequestsTable.kind, "erase"),
        eq(schema.ndprRequestsTable.status, "pending"),
      ),
    )
    .limit(1);
  return row ?? null;
}
