import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { requireUserId } from "../lib/auth";
import { enqueueNotification } from "../lib/notifications";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.get("/streams", async (_req, res) => {
  const rows = await db.select().from(schema.streamsTable);
  res.json(
    rows.map((r) => ({
      id: r.id,
      hostName: r.hostName,
      hostAvatar: r.hostAvatar,
      viewerCount: r.viewerCount,
      posterImage: r.posterImage,
      title: r.title,
      currentProductId: r.currentProductId,
      isLive: r.isLive,
    })),
  );
});

router.get("/streams/:streamId", async (req, res) => {
  const [row] = await db
    .select()
    .from(schema.streamsTable)
    .where(eq(schema.streamsTable.id, req.params.streamId))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({
    id: row.id,
    hostName: row.hostName,
    hostAvatar: row.hostAvatar,
    viewerCount: row.viewerCount,
    posterImage: row.posterImage,
    title: row.title,
    currentProductId: row.currentProductId,
    isLive: row.isLive,
  });
});

/**
 * Notify followers when a seller goes live. Authorization: only the
 * stream's owning seller may flip the flag. Idempotency is guaranteed by
 * the conditional UPDATE — `RETURNING` is empty when another caller (or
 * an earlier call) already set `is_live=true`, so the fan-out is skipped.
 */
router.post("/streams/:streamId/go-live", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const [stream] = await db
    .select()
    .from(schema.streamsTable)
    .where(eq(schema.streamsTable.id, req.params.streamId))
    .limit(1);
  if (!stream) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  // Strict ownership: stream must have a non-null sellerUserId AND it must
  // match the caller. Rejecting null-owner streams prevents unowned/legacy
  // streams from being hijacked + sending fanout notifications.
  if (!stream.sellerUserId || stream.sellerUserId !== userId) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const flipped = await db
    .update(schema.streamsTable)
    .set({ isLive: true })
    .where(and(eq(schema.streamsTable.id, stream.id), eq(schema.streamsTable.isLive, false)))
    .returning({ id: schema.streamsTable.id });
  const fanout = flipped.length > 0;
  if (fanout) {
    const followers = await db
      .select({ userId: schema.followsTable.userId })
      .from(schema.followsTable)
      .where(eq(schema.followsTable.sellerName, stream.hostName));
    for (const f of followers) {
      await enqueueNotification({
        userId: f.userId,
        eventType: "seller_went_live",
        payload: {
          title: `${stream.hostName} is live`,
          body: stream.title,
          url: `/live/${stream.id}`,
        },
      }).catch((err) => logger.error({ err: (err as Error).message }, "notify_go_live_failed"));
    }
  }
  res.json({ ok: true, fanout });
});

/**
 * Convenience endpoint used by the seller "Go live" UI which doesn't yet
 * have a stream row. The store handle is derived server-side from the
 * caller's seller profile so a signed-in user cannot fan out notifications
 * for a handle they do not own. No isLive flag is flipped here — use
 * POST /streams/:id/go-live for that.
 *
 * Body: { title: string, streamId?: string }
 */
router.post("/seller/go-live", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const body = req.body as { title?: string; streamId?: string };
  const title = String(body.title ?? "").trim();
  if (!title) {
    res.status(400).json({ error: "missing_fields" });
    return;
  }
  // Derive the seller's owned storeHandle from their profile. Any handle
  // sent in the body is ignored (defense against impersonation).
  const [seller] = await db
    .select({ application: schema.sellersTable.application })
    .from(schema.sellersTable)
    .where(eq(schema.sellersTable.userId, userId))
    .limit(1);
  const storeHandle =
    seller && seller.application && typeof seller.application === "object"
      ? String((seller.application as Record<string, unknown>).storeHandle ?? "").trim()
      : "";
  if (!storeHandle) {
    res.status(403).json({ error: "no_seller_handle" });
    return;
  }
  const followers = await db
    .select({ userId: schema.followsTable.userId })
    .from(schema.followsTable)
    .where(eq(schema.followsTable.sellerName, storeHandle));
  for (const f of followers) {
    await enqueueNotification({
      userId: f.userId,
      eventType: "seller_went_live",
      payload: {
        title: `${storeHandle} is live`,
        body: title,
        url: body.streamId ? `/live/${body.streamId}` : `/u/${storeHandle}`,
      },
    }).catch((err) => logger.error({ err: (err as Error).message }, "notify_seller_live_failed"));
  }
  // Match the GoLiveResponse contract: fanout is a boolean (whether any
  // followers were notified). Count is logged server-side instead.
  logger.info({ storeHandle, followers: followers.length }, "seller_live_fanout");
  res.json({ ok: true, fanout: followers.length > 0 });
});

export default router;
