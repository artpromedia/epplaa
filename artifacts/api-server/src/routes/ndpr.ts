import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { requireUserId } from "../lib/auth";
import {
  newNdprId,
  buildExportBundle,
  newBundleToken,
  applyRectify,
  applyRestrict,
  liftRestrict,
  findActiveErase,
  NDPR_CONSTANTS,
  type NdprKind,
} from "../lib/ndpr";
import { recordAudit } from "../lib/audit";

const router: IRouter = Router();

function rowToView(r: typeof schema.ndprRequestsTable.$inferSelect) {
  return {
    id: r.id,
    kind: r.kind as NdprKind,
    status: r.status,
    requestBody: r.requestBody,
    bundleToken: r.bundleToken,
    effectiveAtIso: r.effectiveAt?.toISOString() ?? null,
    completedAtIso: r.completedAt?.toISOString() ?? null,
    cancelledAtIso: r.cancelledAt?.toISOString() ?? null,
    failureReason: r.failureReason,
    createdAtIso: r.createdAt.toISOString(),
  };
}

/** GET /ndpr/requests — list caller's data-subject requests. */
router.get("/ndpr/requests", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const rows = await db
    .select()
    .from(schema.ndprRequestsTable)
    .where(eq(schema.ndprRequestsTable.userId, userId))
    .orderBy(desc(schema.ndprRequestsTable.createdAt));
  res.json(rows.map(rowToView));
});

/** GET /ndpr/requests/:id — fetch a single request (with bundle if ready). */
router.get("/ndpr/requests/:id", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const [row] = await db
    .select()
    .from(schema.ndprRequestsTable)
    .where(and(eq(schema.ndprRequestsTable.id, req.params.id), eq(schema.ndprRequestsTable.userId, userId)))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  await recordAudit({
    actorId: userId,
    action: "ndpr.request.read",
    entity: "ndpr_request",
    entityId: row.id,
    piiRead: true,
  });
  res.json({
    ...rowToView(row),
    bundlePayload: row.bundlePayload,
  });
});

/**
 * POST /ndpr/export — synchronous bundle build (dev) or enqueue for async
 * worker. We synchronously assemble the bundle so the test/CI path works
 * without waiting on a cron tick; production deploys can swap this for the
 * cron-driven worker by setting `NDPR_ASYNC=1`.
 */
router.post("/ndpr/export", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  // Rate-limit: one export per 30 days, aligned with NDPR §2.16 fees rules.
  const [user] = await db.select().from(schema.usersTable).where(eq(schema.usersTable.clerkId, userId)).limit(1);
  if (user?.dataExportRequestedAt && Date.now() - user.dataExportRequestedAt.getTime() < NDPR_CONSTANTS.EXPORT_RATE_LIMIT_MS) {
    res.status(429).json({ error: "export_rate_limited", nextAllowedAtIso: new Date(user.dataExportRequestedAt.getTime() + NDPR_CONSTANTS.EXPORT_RATE_LIMIT_MS).toISOString() });
    return;
  }
  const id = newNdprId("export");
  const async = process.env.NDPR_ASYNC === "1";
  if (async) {
    await db.insert(schema.ndprRequestsTable).values({ id, userId, kind: "export", status: "pending" });
  } else {
    const bundle = await buildExportBundle(userId);
    await db.insert(schema.ndprRequestsTable).values({
      id,
      userId,
      kind: "export",
      status: "ready",
      bundlePayload: bundle,
      bundleToken: newBundleToken(),
      completedAt: new Date(),
    });
  }
  await db
    .update(schema.usersTable)
    .set({ dataExportRequestedAt: new Date() })
    .where(eq(schema.usersTable.clerkId, userId));
  await recordAudit({
    actorId: userId,
    action: "ndpr.export.requested",
    entity: "ndpr_request",
    entityId: id,
    payload: { async },
    piiRead: true,
  });
  res.status(202).json({ id, status: async ? "pending" : "ready" });
});

/**
 * POST /ndpr/portability — alias of /ndpr/export emitting the same bundle.
 * Provided for spec clarity (NDPR distinguishes export vs portability rights).
 */
router.post("/ndpr/portability", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const id = newNdprId("portability");
  const bundle = await buildExportBundle(userId);
  await db.insert(schema.ndprRequestsTable).values({
    id,
    userId,
    kind: "portability",
    status: "ready",
    bundlePayload: bundle,
    bundleToken: newBundleToken(),
    completedAt: new Date(),
  });
  await recordAudit({
    actorId: userId,
    action: "ndpr.portability.requested",
    entity: "ndpr_request",
    entityId: id,
    piiRead: true,
  });
  res.status(202).json({ id, status: "ready" });
});

/** POST /ndpr/erase — schedule erasure (30-day grace). */
router.post("/ndpr/erase", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const existing = await findActiveErase(userId);
  if (existing) {
    res.status(409).json({ error: "erase_already_pending", id: existing.id });
    return;
  }
  const id = newNdprId("erase");
  const effectiveAt = new Date(Date.now() + NDPR_CONSTANTS.ERASE_GRACE_MS);
  await db.insert(schema.ndprRequestsTable).values({
    id,
    userId,
    kind: "erase",
    status: "pending",
    effectiveAt,
  });
  await recordAudit({
    actorId: userId,
    action: "ndpr.erase.scheduled",
    entity: "ndpr_request",
    entityId: id,
    payload: { effectiveAtIso: effectiveAt.toISOString() },
  });
  res.status(202).json({ id, status: "pending", effectiveAtIso: effectiveAt.toISOString() });
});

/** POST /ndpr/requests/:id/cancel — cancel pending erase (within grace). */
router.post("/ndpr/requests/:id/cancel", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const [row] = await db
    .select()
    .from(schema.ndprRequestsTable)
    .where(and(eq(schema.ndprRequestsTable.id, req.params.id), eq(schema.ndprRequestsTable.userId, userId)))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (row.status !== "pending") {
    res.status(409).json({ error: "not_cancellable", status: row.status });
    return;
  }
  await db
    .update(schema.ndprRequestsTable)
    .set({ status: "cancelled", cancelledAt: new Date() })
    .where(eq(schema.ndprRequestsTable.id, row.id));
  await recordAudit({
    actorId: userId,
    action: "ndpr.request.cancelled",
    entity: "ndpr_request",
    entityId: row.id,
    payload: { kind: row.kind },
  });
  res.json({ id: row.id, status: "cancelled" });
});

/** POST /ndpr/rectify — patch user record fields. */
router.post("/ndpr/rectify", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  // Accept either a flat body (`{displayName, phone, ...}`) or the
  // OpenAPI-shaped `{patch: {...}}` envelope used by the privacy page.
  // `applyRectify` only consumes the allow-listed flat keys, so anything
  // outside that shape is silently dropped.
  const raw = (req.body ?? {}) as Record<string, unknown>;
  const body = (raw.patch && typeof raw.patch === "object"
    ? (raw.patch as Record<string, unknown>)
    : raw);
  const id = newNdprId("rectify");
  await db.insert(schema.ndprRequestsTable).values({
    id,
    userId,
    kind: "rectify",
    status: "pending",
    requestBody: body,
  });
  const result = await applyRectify(userId, body);
  await db
    .update(schema.ndprRequestsTable)
    .set({
      status: result.ok ? "completed" : "failed",
      failureReason: result.ok ? "" : result.reason,
      completedAt: new Date(),
    })
    .where(eq(schema.ndprRequestsTable.id, id));
  res.status(result.ok ? 200 : 400).json({ id, status: result.ok ? "completed" : "failed" });
});

/** POST /ndpr/restrict — flip processing-restricted flag. */
router.post("/ndpr/restrict", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const body = req.body as { lift?: boolean };
  const id = newNdprId("restrict");
  if (body.lift) {
    await liftRestrict(userId);
  } else {
    await applyRestrict(userId);
  }
  await db.insert(schema.ndprRequestsTable).values({
    id,
    userId,
    kind: "restrict",
    status: "completed",
    requestBody: { lifted: Boolean(body.lift) },
    completedAt: new Date(),
  });
  res.json({ id, status: "completed", restricted: !body.lift });
});

export default router;
