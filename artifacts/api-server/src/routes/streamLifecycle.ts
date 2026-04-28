import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { requireUserId } from "../lib/auth";
import { newSafeId } from "../lib/ids";
import { createLiveInput, rotateStreamKey, streamingProvider } from "../lib/streaming";
import { currentKycTier } from "../lib/kyc";
import { sellerSanctionsBlocked } from "../lib/sanctions";
import { persistReplayForEndedStream } from "../lib/replayPersist";
import { enqueueNotification } from "../lib/notifications";
import { recordAudit } from "../lib/audit";
import { logger } from "../lib/logger";
import { isHost, listRecentMessages, chatSendAtomic, softDeleteMessage } from "../lib/chat";
import { recordReaction, recentReactions } from "../lib/reactions";
import { getSocketServer } from "../lib/socket";

const router: IRouter = Router();

const REQUIRED_KYC_TIER_TO_BROADCAST = 2;

// Tier 2+ KYC required. Provisions the CF live input and snapshots the
// seller's display info onto the stream row.
router.post("/streams", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const body = req.body as {
    title?: string;
    posterImage?: string;
    currentProductId?: string;
  };
  const title = String(body.title ?? "").trim();
  if (!title) {
    res.status(400).json({ error: "missing_title" });
    return;
  }
  const tier = await currentKycTier(userId);
  if (tier < REQUIRED_KYC_TIER_TO_BROADCAST) {
    res.status(403).json({ error: "kyc_tier_required", requiredTier: REQUIRED_KYC_TIER_TO_BROADCAST, currentTier: tier });
    return;
  }
  if (await sellerSanctionsBlocked(userId)) {
    res.status(403).json({ error: "sanctions_review_required" });
    return;
  }
  const [seller] = await db
    .select({ application: schema.sellersTable.application })
    .from(schema.sellersTable)
    .where(eq(schema.sellersTable.userId, userId))
    .limit(1);
  const application = (seller?.application ?? null) as Record<string, unknown> | null;
  const hostName = String(application?.storeHandle ?? application?.storeName ?? "seller");
  const hostAvatar = String(application?.storeAvatar ?? "");
  const streamId = newSafeId("str");
  const liveInput = await createLiveInput({
    meta: { name: title, sellerUserId: userId, streamId },
    recording: true,
  });
  const [row] = await db
    .insert(schema.streamsTable)
    .values({
      id: streamId,
      hostName,
      hostAvatar,
      title,
      posterImage: body.posterImage ?? "",
      currentProductId: body.currentProductId ?? null,
      isLive: false,
      sellerUserId: userId,
      cfInputId: liveInput.uid,
      rtmpUrl: liveInput.rtmpUrl,
      rtmpStreamKey: liveInput.rtmpStreamKey,
      whipUrl: liveInput.whipUrl,
      hlsUrl: liveInput.hlsUrl,
      provider: liveInput.provider,
      status: "idle",
      keyRotatedAt: new Date(),
    })
    .returning();
  res.status(201).json(toStreamWithSecrets(row));
});

// Idempotent. Notifies followers only on the first transition to live.
router.post("/streams/:streamId/start", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const [row] = await db
    .select()
    .from(schema.streamsTable)
    .where(eq(schema.streamsTable.id, req.params.streamId))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (row.sellerUserId !== userId) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  // KYC may have lapsed since the input was provisioned; re-check.
  const tier = await currentKycTier(userId);
  if (tier < REQUIRED_KYC_TIER_TO_BROADCAST) {
    res.status(403).json({ error: "kyc_tier_required", requiredTier: REQUIRED_KYC_TIER_TO_BROADCAST, currentTier: tier });
    return;
  }
  if (await sellerSanctionsBlocked(userId)) {
    res.status(403).json({ error: "sanctions_review_required" });
    return;
  }
  const wasLive = row.status === "live";
  const [updated] = await db
    .update(schema.streamsTable)
    .set({ status: "live", isLive: true, startedAt: row.startedAt ?? new Date() })
    .where(eq(schema.streamsTable.id, row.id))
    .returning();
  if (!wasLive) {
    const followers = await db
      .select({ userId: schema.followsTable.userId })
      .from(schema.followsTable)
      .where(eq(schema.followsTable.sellerName, row.hostName));
    for (const f of followers) {
      await enqueueNotification({
        userId: f.userId,
        eventType: "seller_went_live",
        payload: { title: `${row.hostName} is live`, body: row.title, url: `/live/${row.id}` },
      }).catch((err) => logger.error({ err: (err as Error).message }, "notify_go_live_failed"));
    }
  }
  res.json(toStreamWithSecrets(updated));
});

router.post("/streams/:streamId/stop", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const [row] = await db
    .select()
    .from(schema.streamsTable)
    .where(eq(schema.streamsTable.id, req.params.streamId))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (row.sellerUserId !== userId) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const [updated] = await db
    .update(schema.streamsTable)
    .set({ status: "ended", isLive: false, endedAt: new Date(), currentViewers: 0 })
    .where(eq(schema.streamsTable.id, row.id))
    .returning();
  await persistReplayForEndedStream(row.id);
  res.json(toStreamWithSecrets(updated));
});

router.post("/streams/:streamId/rotate-key", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const [row] = await db
    .select()
    .from(schema.streamsTable)
    .where(eq(schema.streamsTable.id, req.params.streamId))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (row.sellerUserId !== userId) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  if (!row.cfInputId) {
    res.status(400).json({ error: "no_live_input" });
    return;
  }
  const fresh = await rotateStreamKey(
    row.cfInputId,
    { name: row.title, sellerUserId: userId, streamId: row.id },
    true,
  );
  const [updated] = await db
    .update(schema.streamsTable)
    .set({
      cfInputId: fresh.uid,
      rtmpUrl: fresh.rtmpUrl,
      rtmpStreamKey: fresh.rtmpStreamKey,
      whipUrl: fresh.whipUrl,
      hlsUrl: fresh.hlsUrl,
      provider: fresh.provider,
      keyRotatedAt: new Date(),
    })
    .where(eq(schema.streamsTable.id, row.id))
    .returning();
  await recordAudit({
    actorId: userId,
    action: "stream.key.rotate",
    entity: "stream",
    entityId: row.id,
    payload: { provider: row.provider },
  });
  res.json(toStreamWithSecrets(updated));
});

// Public buyer-side read; never includes the RTMP key.
router.get("/streams/:streamId/playback", async (req, res) => {
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
    status: row.status,
    hlsUrl: row.hlsUrl,
    provider: row.provider,
    currentViewers: row.currentViewers,
    peakViewers: row.peakViewers,
    title: row.title,
    hostName: row.hostName,
    hostAvatar: row.hostAvatar,
    posterImage: row.posterImage,
    currentProductId: row.currentProductId,
    isLive: row.isLive,
    startedAtIso: row.startedAt?.toISOString() ?? null,
    endedAtIso: row.endedAt?.toISOString() ?? null,
  });
});

router.post("/streams/:streamId/mod-config", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  if (!(await isHost(req.params.streamId, userId))) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const body = req.body as { slowModeSeconds?: number; addBannedWord?: string };
  const patch: Partial<typeof schema.streamsTable.$inferInsert> = {};
  if (typeof body.slowModeSeconds === "number") {
    patch.slowModeSeconds = Math.max(0, Math.min(300, Math.floor(body.slowModeSeconds)));
  }
  if (typeof body.addBannedWord === "string" && body.addBannedWord.trim()) {
    const [current] = await db
      .select({ banned: schema.streamsTable.bannedWords })
      .from(schema.streamsTable)
      .where(eq(schema.streamsTable.id, req.params.streamId))
      .limit(1);
    const set = new Set([...(current?.banned ?? []), body.addBannedWord.trim().toLowerCase()]);
    patch.bannedWords = Array.from(set);
  }
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "no_fields" });
    return;
  }
  const [row] = await db
    .update(schema.streamsTable)
    .set(patch)
    .where(eq(schema.streamsTable.id, req.params.streamId))
    .returning();
  await recordAudit({
    actorId: userId,
    action: "stream.mod.config",
    entity: "stream",
    entityId: row.id,
    payload: { slowModeSeconds: row.slowModeSeconds, bannedWords: row.bannedWords.length },
  });
  res.json({
    id: row.id,
    slowModeSeconds: row.slowModeSeconds,
    bannedWords: row.bannedWords,
  });
});

router.get("/streams/:streamId/messages", async (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? 50)));
  const messages = await listRecentMessages(req.params.streamId, limit);
  res.json({ messages });
});

// Username is resolved server-side; client-supplied display names are
// never trusted (host impersonation vector).
router.post("/streams/:streamId/messages", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const body = req.body as { text?: string };
  const raw = String(body.text ?? "").trim();
  if (!raw) {
    res.status(400).json({ error: "empty_message" });
    return;
  }
  const text = raw.slice(0, 280);
  const [u] = await db
    .select({ name: schema.usersTable.displayName })
    .from(schema.usersTable)
    .where(eq(schema.usersTable.clerkId, userId))
    .limit(1);
  const username = (u?.name ?? "").trim() || "viewer";
  const result = await chatSendAtomic({
    streamId: req.params.streamId,
    userId,
    username,
    text,
  });
  if (!result.ok) {
    if (result.reason === "slow_mode") {
      res.status(429).json({ error: "slow_mode", retryAfterSeconds: result.waitSeconds });
      return;
    }
    res.status(404).json({ error: result.reason });
    return;
  }
  const io = getSocketServer();
  io?.of("/streams").to(`stream:${req.params.streamId}`).emit("chat:message", result.message);
  res.status(201).json(result.message);
});

router.delete("/streams/:streamId/messages/:messageId", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  if (!(await isHost(req.params.streamId, userId))) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const ok = await softDeleteMessage(req.params.streamId, req.params.messageId, userId);
  if (!ok) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  await recordAudit({
    actorId: userId,
    action: "stream.chat.delete",
    entity: "streamChatMessage",
    entityId: req.params.messageId,
    payload: { streamId: req.params.streamId },
  });
  const io = getSocketServer();
  io?.of("/streams").to(`stream:${req.params.streamId}`).emit("chat:deleted", {
    streamId: req.params.streamId,
    messageId: req.params.messageId,
  });
  res.status(204).end();
});

router.post("/streams/:streamId/reactions", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const body = req.body as { kind?: string; count?: number };
  const kind = String(body.kind ?? "heart").slice(0, 16);
  const count = Math.max(1, Math.min(10, Number(body.count ?? 1)));
  await recordReaction(req.params.streamId, kind, count);
  res.status(201).json({ ok: true });
});

router.get("/streams/:streamId/reactions/recent", async (req, res) => {
  const windowSeconds = Math.max(1, Math.min(300, Number(req.query.windowSeconds ?? 60)));
  const buckets = await recentReactions(req.params.streamId, windowSeconds);
  res.json({ buckets });
});

router.get("/streams/_provider/info", async (_req, res) => {
  res.json({ provider: streamingProvider() });
});

function toStreamWithSecrets(row: typeof schema.streamsTable.$inferSelect) {
  return {
    id: row.id,
    title: row.title,
    hostName: row.hostName,
    hostAvatar: row.hostAvatar,
    posterImage: row.posterImage,
    currentProductId: row.currentProductId,
    status: row.status,
    isLive: row.isLive,
    provider: row.provider,
    cfInputId: row.cfInputId,
    rtmpUrl: row.rtmpUrl,
    rtmpStreamKey: row.rtmpStreamKey,
    whipUrl: row.whipUrl,
    hlsUrl: row.hlsUrl,
    currentViewers: row.currentViewers,
    peakViewers: row.peakViewers,
    slowModeSeconds: row.slowModeSeconds,
    bannedWords: row.bannedWords,
    startedAtIso: row.startedAt?.toISOString() ?? null,
    endedAtIso: row.endedAt?.toISOString() ?? null,
    keyRotatedAtIso: row.keyRotatedAt?.toISOString() ?? null,
  };
}

export default router;
