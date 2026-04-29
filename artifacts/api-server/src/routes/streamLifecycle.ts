import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { requireUserId } from "../lib/auth";
import { newSafeId } from "../lib/ids";
import { createLiveInput, rotateStreamKey, streamingProvider } from "../lib/streaming";
import { cloudflareWebhookConfigured } from "./streamingWebhooks";
import { currentKycTier } from "../lib/kyc";
import { sellerSanctionsBlocked } from "../lib/sanctions";
import { persistReplayForEndedStream } from "../lib/replayPersist";
import { enqueueNotification } from "../lib/notifications";
import { recordAudit } from "../lib/audit";
import { logger } from "../lib/logger";
import { isHost, listRecentMessages, chatSendAtomic, softDeleteMessage, toPublicChatMessage, resolveChatRole } from "../lib/chat";
import {
  addStreamModerator,
  canModerateStream,
  listStreamModerators,
  lookupChatMessageAuthor,
  removeStreamModerator,
} from "../lib/streamModerators";
import { recordReaction, recentReactions } from "../lib/reactions";
import { getSocketServer } from "../lib/socket";
import { moderateText, moderateImage } from "../lib/moderation";
import { invalidateTrendingCache } from "../lib/recommender";

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
  // Poster image moderation: scan the seller-supplied thumbnail before the
  // stream row is created so blocked content never reaches the catalog.
  // CSAM matches open a high-severity case via recordScanAndMaybeOpenCase
  // inside moderateImage; we surface the case id back to the caller so
  // ops can audit the rejection.
  const posterUrl = String(body.posterImage ?? "").trim();
  if (posterUrl) {
    const posterScan = await moderateImage(posterUrl, {
      surface: "stream_poster",
      targetId: `pending:${userId}`,
      sourceUserId: userId,
    });
    if (posterScan.blocked) {
      res.status(422).json({ error: "poster_image_rejected", caseId: posterScan.caseId, decision: posterScan.decision });
      return;
    }
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
  // Reset per-session viewer counters on a fresh transition into live so a
  // viral previous session (peak=10k from yesterday, currentViewers stale
  // from a missed /stop) does not unfairly skew today's trending score.
  // When the stream is already live this is a no-op resume — leave the
  // counters alone so the recommender keeps seeing the live signal.
  const sessionPatch = wasLive
    ? { status: "live" as const, isLive: true, startedAt: row.startedAt ?? new Date() }
    : {
        status: "live" as const,
        isLive: true,
        startedAt: new Date(),
        currentViewers: 0,
        peakViewers: 0,
        endedAt: null,
      };
  const [updated] = await db
    .update(schema.streamsTable)
    .set(sessionPatch)
    .where(eq(schema.streamsTable.id, row.id))
    .returning();
  // Discovery /trending-streams is cached for ~15s; flush it so a freshly
  // live stream (or a resumed one) appears on the rail immediately.
  invalidateTrendingCache();
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
  // Pop the just-ended stream off /trending-streams immediately instead
  // of waiting up to 15s for the cache to age out.
  invalidateTrendingCache();
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
    // Live mod-config snapshot, included so the viewer-side moderation
    // tools (Task #22) can initialise their slow-mode dropdown to the
    // currently-applied value instead of misleading 0/Off.
    slowModeSeconds: row.slowModeSeconds,
    bannedWords: row.bannedWords,
  });
});

router.post("/streams/:streamId/mod-config", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  // Hosts and promoted moderators may both tune slow-mode and banned
  // words — that's the whole point of deputising mods.
  if (!(await canModerateStream(req.params.streamId, userId))) {
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
  res.json({ messages: messages.map(toPublicChatMessage) });
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
  // Real-time text moderation. Block decisions refuse the send (and open
  // a content case automatically); review/allow decisions pass through.
  // A provider failure must not block legitimate chat — log + allow.
  try {
    const mod = await moderateText(text, {
      surface: "stream_chat",
      targetId: `${req.params.streamId}:${userId}:${Date.now()}`,
      sourceUserId: userId,
    });
    if (mod.blocked) {
      res.status(422).json({ error: "blocked_by_moderation", caseId: mod.caseId });
      return;
    }
  } catch (err) {
    logger.error({ err: (err as Error).message }, "chat_text_moderation_failed");
  }
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
  const pub = toPublicChatMessage(result.message);
  const io = getSocketServer();
  io?.of("/streams").to(`stream:${req.params.streamId}`).emit("chat:message", pub);
  res.status(201).json(pub);
});

router.delete("/streams/:streamId/messages/:messageId", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  // Mods can delete chat messages just like the host (Task #22). The
  // moderator-grant table is the source of truth — see canModerateStream.
  if (!(await canModerateStream(req.params.streamId, userId))) {
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

// --- Moderator management (Task #22) -------------------------------------
//
// Only the host (the seller_user_id on the stream row) may add or remove
// moderators. Mods themselves cannot promote further mods — that's a
// privilege-escalation footgun we'd rather not arm.
//
// `POST /streams/:streamId/moderators` accepts either:
//   - `{ userId: "..." }` — direct promotion by user id
//   - `{ fromMessageId: "msg_..." }` — promote the author of a chat
//     message id (so the host UI can deputise straight from a chat row
//     without ever exposing raw user ids in the public chat payload).
//
// Each grant/revoke writes a hash-chained audit row so trust & safety
// has a permanent record of who got mod and when.

router.get("/streams/:streamId/moderators", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  if (!(await isHost(req.params.streamId, userId))) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const moderators = await listStreamModerators(req.params.streamId);
  res.json({ moderators });
});

router.post("/streams/:streamId/moderators", async (req, res) => {
  const actorId = requireUserId(req, res);
  if (!actorId) return;
  if (!(await isHost(req.params.streamId, actorId))) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const body = req.body as { userId?: string; fromMessageId?: string };
  let promoteUserId = String(body.userId ?? "").trim();
  let resolvedFromMessage = false;
  if (!promoteUserId && body.fromMessageId) {
    const author = await lookupChatMessageAuthor(
      req.params.streamId,
      String(body.fromMessageId).trim(),
    );
    if (!author) {
      res.status(404).json({ error: "message_not_found" });
      return;
    }
    promoteUserId = author.userId;
    resolvedFromMessage = true;
  }
  if (!promoteUserId) {
    res.status(400).json({ error: "missing_user" });
    return;
  }
  // Promoting the host themselves is a no-op (they already outrank mods);
  // we refuse rather than silently inserting a redundant grant row.
  const [stream] = await db
    .select({ seller: schema.streamsTable.sellerUserId })
    .from(schema.streamsTable)
    .where(eq(schema.streamsTable.id, req.params.streamId))
    .limit(1);
  if (!stream) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (stream.seller && stream.seller === promoteUserId) {
    res.status(400).json({ error: "cannot_promote_host" });
    return;
  }
  await addStreamModerator({
    streamId: req.params.streamId,
    userId: promoteUserId,
    grantedBy: actorId,
  });
  await recordAudit({
    actorId,
    action: "stream.moderator.add",
    entity: "streamModerator",
    entityId: `${req.params.streamId}:${promoteUserId}`,
    payload: {
      streamId: req.params.streamId,
      promotedUserId: promoteUserId,
      via: resolvedFromMessage ? "message" : "userId",
    },
  });
  const moderators = await listStreamModerators(req.params.streamId);
  const promoted = moderators.find((m) => m.userId === promoteUserId);
  res.status(201).json({
    moderator: promoted ?? {
      userId: promoteUserId,
      username: "viewer",
      grantedBy: actorId,
      grantedAtIso: new Date().toISOString(),
    },
    moderators,
  });
});

router.delete("/streams/:streamId/moderators/:userId", async (req, res) => {
  const actorId = requireUserId(req, res);
  if (!actorId) return;
  if (!(await isHost(req.params.streamId, actorId))) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const removed = await removeStreamModerator(req.params.streamId, req.params.userId);
  if (!removed) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  await recordAudit({
    actorId,
    action: "stream.moderator.remove",
    entity: "streamModerator",
    entityId: `${req.params.streamId}:${req.params.userId}`,
    payload: {
      streamId: req.params.streamId,
      revokedUserId: req.params.userId,
    },
  });
  res.status(204).end();
});

// Lets a signed-in viewer find out whether they're the host or a mod for
// this stream. The viewer client uses this to decide whether to render the
// in-stream moderation tools (delete buttons, slow-mode dropdown).
router.get("/streams/:streamId/moderation-role", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const role = await resolveChatRole(req.params.streamId, userId);
  res.json({ role });
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
  res.json({
    provider: streamingProvider(),
    webhookConfigured: cloudflareWebhookConfigured(),
  });
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
