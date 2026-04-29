import { Router, type IRouter, type Request, type Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { logger } from "../lib/logger";
import { persistReplayFromVideo, type ReplayVideoSnapshot } from "../lib/replayPersist";
import { streamingProvider, getCloudflareVideo } from "../lib/streaming";
import { isProductionEnvironment } from "../lib/productionSignals";

/**
 * Cloudflare Stream notification webhook. Mounted under
 * /api/streaming/webhooks/cloudflare with `express.raw()` so HMAC
 * verification (when CF_STREAM_WEBHOOK_SECRET is set) sees the exact
 * bytes Cloudflare signed.
 *
 * Cloudflare Stream POSTs the full video object whenever a video
 * transitions state. We act on `status.state === "ready"` (the
 * "video ready" event for the recorded VOD that follows a finished
 * live broadcast) and write the replay row + sync the stream's
 * cf_video_uid + hls_url. All other states are ack'd with 200 so CF
 * doesn't disable the endpoint, but logged for ops.
 *
 * Signature format (per CF docs):
 *   Webhook-Signature: time=<unix>,sig1=<hex hmac sha256>
 * where sig1 = HMAC-SHA256(secret, "<unix>.<body>"). We also reject
 * timestamps more than 5 minutes off wall-clock to prevent replay.
 */
const router: IRouter = Router();

const MAX_SKEW_SECONDS = 5 * 60;

router.post("/cloudflare", async (req, res) => {
  const rawBody: Buffer = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}), "utf8");

  const secret = process.env.CF_STREAM_WEBHOOK_SECRET;
  const provider = streamingProvider();

  if (!secret) {
    // Fail-closed in production when CF provider is enabled — without
    // the webhook secret we can't verify Cloudflare actually sent the
    // event, and accepting unsigned events would let anyone forge
    // replay rows for arbitrary streamIds.
    if (provider === "cloudflare" && isProductionEnvironment(process.env, logger)) {
      logger.error({ provider }, "cf_stream_webhook_secret_not_configured");
      res.status(503).json({ ok: false, reason: "webhook_secret_not_configured" });
      return;
    }
    logger.warn({ provider }, "cf_stream_webhook_unsigned_accepted");
  } else {
    const sigHeader = req.header("Webhook-Signature") ?? "";
    if (!verifyCfSignature(rawBody, sigHeader, secret)) {
      logger.warn("cf_stream_webhook_bad_signature");
      // 200 so CF doesn't disable the endpoint, but body flags rejection.
      res.status(200).json({ ok: false, reason: "invalid_signature" });
      return;
    }
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
  } catch {
    res.status(200).json({ ok: false, reason: "invalid_json" });
    return;
  }

  const status = (payload.status ?? {}) as { state?: string };
  const state = String(status.state ?? "");
  if (state !== "ready") {
    // CF emits webhooks for queued/inprogress/error/etc. too — only the
    // terminal "ready" state means the recording is fully encoded and
    // the HLS manifest is playable. Ack the rest as a no-op.
    logger.info({ state, uid: payload.uid }, "cf_stream_webhook_non_ready_state_ignored");
    res.status(200).json({ ok: true, ignored: true, state });
    return;
  }

  // Resolve the stream row. Preferred path: meta.streamId (we set this
  // when we provisioned the live input in createStream — see
  // routes/streamLifecycle.ts). Fallback: look up by liveInput uid in
  // case meta wasn't preserved (e.g. the stream row was repaired
  // out-of-band but the live input wasn't reprovisioned).
  const meta = (payload.meta ?? {}) as Record<string, unknown>;
  let streamId = String(meta.streamId ?? "");
  if (!streamId) {
    const liveInputUid = String(payload.liveInput ?? "");
    if (liveInputUid) {
      const [s] = await db
        .select({ id: schema.streamsTable.id })
        .from(schema.streamsTable)
        .where(eq(schema.streamsTable.cfInputId, liveInputUid))
        .limit(1);
      if (s) streamId = s.id;
    }
  }
  if (!streamId) {
    logger.warn(
      { uid: payload.uid, liveInput: payload.liveInput },
      "cf_stream_webhook_unmatched_stream",
    );
    res.status(200).json({ ok: true, ignored: true, reason: "unmatched_stream" });
    return;
  }

  const playback = (payload.playback ?? {}) as { hls?: string };
  let snapshot: ReplayVideoSnapshot = {
    uid: String(payload.uid ?? ""),
    hlsUrl: String(playback.hls ?? ""),
    thumbnailUrl: String(payload.thumbnail ?? ""),
    durationSeconds: Math.max(0, Math.floor(Number(payload.duration ?? 0))),
    recordedAt: String(payload.created ?? new Date().toISOString()),
  };
  if (!snapshot.uid) {
    logger.warn({ streamId }, "cf_stream_webhook_missing_video_uid");
    res.status(200).json({ ok: true, ignored: true, reason: "missing_video_uid" });
    return;
  }
  // Defensive fallback: at the very edge of CF's eventual consistency
  // the "video ready" delivery sometimes lacks playback.hls (the
  // manifest URL is provisioned a beat after the state transition is
  // emitted). Persisting the row with playbackUrl=null leaves the
  // buyer-facing replay broken until the seller manually re-triggers
  // it. When playback.hls is missing, re-fetch the authoritative video
  // record by uid and merge the missing fields. Best-effort: if the
  // lookup itself fails we fall through with the original snapshot
  // and let the row land — better a partially-populated replay than
  // dropping the delivery entirely.
  if (!snapshot.hlsUrl) {
    try {
      const fresh = await getCloudflareVideo(snapshot.uid);
      if (fresh) {
        snapshot = {
          uid: snapshot.uid,
          hlsUrl: fresh.hlsUrl || snapshot.hlsUrl,
          thumbnailUrl: snapshot.thumbnailUrl || fresh.thumbnailUrl,
          durationSeconds: snapshot.durationSeconds || fresh.durationSeconds,
          recordedAt: snapshot.recordedAt || fresh.recordedAt,
        };
        logger.info(
          { streamId, videoUid: snapshot.uid, hlsResolved: Boolean(snapshot.hlsUrl) },
          "cf_stream_webhook_payload_hydrated_from_cf",
        );
      }
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, streamId, videoUid: snapshot.uid },
        "cf_stream_webhook_hydrate_failed",
      );
    }
  }

  try {
    const result = await persistReplayFromVideo(streamId, snapshot);
    if (result.persisted) {
      logger.info(
        { streamId, videoUid: snapshot.uid, replayId: result.replayId },
        "cf_stream_webhook_replay_persisted",
      );
    } else if (result.alreadyExisted) {
      logger.info(
        { streamId, videoUid: snapshot.uid, replayId: result.replayId },
        "cf_stream_webhook_replay_already_existed",
      );
    } else {
      logger.warn({ streamId, videoUid: snapshot.uid }, "cf_stream_webhook_stream_not_found");
    }
    res.status(200).json({ ok: true, persisted: result.persisted, replayId: result.replayId });
  } catch (err) {
    const msg = (err as Error).message;
    logger.error({ err: msg, streamId, videoUid: snapshot.uid }, "cf_stream_webhook_persist_failed");
    // 500 so Cloudflare retries — replay persistence failures are
    // transient (DB hiccups) and we'd rather it redeliver than drop
    // the row silently.
    res.status(500).json({ ok: false, error: msg });
  }
});

export function verifyCfSignature(body: Buffer, header: string, secret: string): boolean {
  if (!header) return false;
  const parts = new Map<string, string>();
  for (const seg of header.split(",")) {
    const idx = seg.indexOf("=");
    if (idx <= 0) continue;
    parts.set(seg.slice(0, idx).trim(), seg.slice(idx + 1).trim());
  }
  const time = parts.get("time");
  const sig = parts.get("sig1");
  if (!time || !sig) return false;
  const ts = Number(time);
  if (!Number.isFinite(ts)) return false;
  const skewSec = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (skewSec > MAX_SKEW_SECONDS) return false;
  const expected = createHmac("sha256", secret)
    .update(`${time}.${body.toString("utf8")}`)
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sig, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Used by tests + the streaming provider info endpoint to surface
// whether the inbound webhook channel is fully wired (i.e. shared
// secret configured). Production deployments with the CF provider
// enabled but no shared secret will refuse webhooks.
export function cloudflareWebhookConfigured(): boolean {
  return Boolean(process.env.CF_STREAM_WEBHOOK_SECRET);
}

export default router;

// Convenience helper for unit tests so they don't have to depend on
// the express raw-body middleware to construct a valid signature.
export function signCloudflareWebhookForTest(
  body: Buffer | string,
  secret: string,
  unixSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const buf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  const sig = createHmac("sha256", secret)
    .update(`${unixSeconds}.${buf.toString("utf8")}`)
    .digest("hex");
  return `time=${unixSeconds},sig1=${sig}`;
}
