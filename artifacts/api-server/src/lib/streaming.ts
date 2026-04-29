import { logger } from "./logger";
import { detectNonHostnameProductionSignals } from "./productionSignals";

// Cloudflare Stream provider, with a deterministic stub when
// CF_STREAM_API_TOKEN/CF_STREAM_ACCOUNT_ID aren't set.
const CF_BASE = "https://api.cloudflare.com/client/v4";

export interface LiveInputCreate {
  meta: { name: string; sellerUserId: string; streamId: string };
  recording: boolean;
}

export interface LiveInput {
  uid: string;
  rtmpUrl: string;
  rtmpStreamKey: string;
  whipUrl: string;
  hlsUrl: string;
  provider: "stub" | "cloudflare";
}

export interface RecordedVideo {
  uid: string;
  hlsUrl: string;
  thumbnailUrl: string;
  durationSeconds: number;
  recordedAt: string;
}

function selectProvider(): "stub" | "cloudflare" {
  const token = process.env.CF_STREAM_API_TOKEN;
  const account = process.env.CF_STREAM_ACCOUNT_ID;
  if (token && account) return "cloudflare";
  return "stub";
}

function newStubKey(streamId: string): string {
  const rand = Math.random().toString(36).slice(2, 14);
  return `stub-${streamId}-${rand}`;
}

function stubLiveInput(input: LiveInputCreate): LiveInput {
  const uid = `stub-input-${input.meta.streamId}`;
  const key = newStubKey(input.meta.streamId);
  return {
    uid,
    rtmpUrl: "rtmp://stub-ingest.epplaa.local/live",
    rtmpStreamKey: key,
    whipUrl: `https://stub-ingest.epplaa.local/whip/${uid}`,
    hlsUrl: `https://stub-playback.epplaa.local/${uid}/manifest.m3u8`,
    provider: "stub",
  };
}

async function cfFetch(path: string, init?: RequestInit): Promise<unknown> {
  const token = process.env.CF_STREAM_API_TOKEN!;
  const account = process.env.CF_STREAM_ACCOUNT_ID!;
  const url = `${CF_BASE}/accounts/${account}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      ...((init?.headers as Record<string, string> | undefined) ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`cf_stream_${res.status}_${body.slice(0, 200)}`);
  }
  return res.json();
}

interface CfLiveInputResponse {
  result: {
    uid: string;
    rtmps?: { url: string; streamKey: string };
    webRTC?: { url: string };
    playback?: { hls?: string };
  };
}

interface CfLiveInputVideosResponse {
  result: Array<{
    uid: string;
    duration: number;
    thumbnail: string;
    playback?: { hls?: string };
    created: string;
  }>;
}

interface CfVideoResponse {
  result: {
    uid: string;
    duration?: number;
    thumbnail?: string;
    playback?: { hls?: string };
    created?: string;
    status?: { state?: string };
    liveInput?: string;
    meta?: Record<string, unknown>;
  };
}

export interface CloudflareVideo {
  uid: string;
  hlsUrl: string;
  thumbnailUrl: string;
  durationSeconds: number;
  recordedAt: string;
  state: string;
  liveInputUid: string;
  meta: Record<string, unknown>;
}

export async function createLiveInput(input: LiveInputCreate): Promise<LiveInput> {
  if (selectProvider() === "stub") return stubLiveInput(input);
  try {
    const data = (await cfFetch("/stream/live_inputs", {
      method: "POST",
      body: JSON.stringify({
        meta: { name: input.meta.name, sellerUserId: input.meta.sellerUserId, streamId: input.meta.streamId },
        recording: { mode: input.recording ? "automatic" : "off" },
      }),
    })) as CfLiveInputResponse;
    return {
      uid: data.result.uid,
      rtmpUrl: data.result.rtmps?.url ?? "",
      rtmpStreamKey: data.result.rtmps?.streamKey ?? "",
      whipUrl: data.result.webRTC?.url ?? "",
      hlsUrl: data.result.playback?.hls ?? "",
      provider: "cloudflare",
    };
  } catch (err) {
    logger.error({ err: (err as Error).message }, "cf_stream_create_failed_falling_back_to_stub");
    return stubLiveInput(input);
  }
}

// CF has no in-place key rotation: delete the old live input and create
// a new one so the previous RTMP key stops accepting ingest.
export async function rotateStreamKey(
  uid: string,
  meta: { name: string; sellerUserId: string; streamId: string },
  recording: boolean,
): Promise<LiveInput> {
  if (selectProvider() === "stub") {
    return stubLiveInput({ meta, recording });
  }
  try {
    await cfFetch(`/stream/live_inputs/${uid}`, { method: "DELETE" });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, uid },
      "cf_stream_rotate_delete_old_failed_continuing",
    );
  }
  return await createLiveInput({ meta, recording });
}

export async function listRecordedVideos(uid: string): Promise<RecordedVideo[]> {
  if (selectProvider() === "stub") {
    return [
      {
        uid: `stub-vod-${uid}`,
        hlsUrl: `https://stub-playback.epplaa.local/vod/${uid}/manifest.m3u8`,
        thumbnailUrl: "",
        durationSeconds: 0,
        recordedAt: new Date().toISOString(),
      },
    ];
  }
  try {
    const data = (await cfFetch(`/stream/live_inputs/${uid}/videos`, { method: "GET" })) as CfLiveInputVideosResponse;
    return data.result.map((v) => ({
      uid: v.uid,
      hlsUrl: v.playback?.hls ?? "",
      thumbnailUrl: v.thumbnail,
      durationSeconds: v.duration,
      recordedAt: v.created,
    }));
  } catch (err) {
    logger.error({ err: (err as Error).message, uid }, "cf_stream_list_videos_failed");
    return [];
  }
}

// Fetch a single VOD by its Cloudflare Stream video uid. Used by the
// inbound CF Stream webhook handler to pull authoritative status +
// playback metadata after a "video ready" notification arrives, since
// the webhook payload itself can race against CF eventually-consistent
// edges. Returns null when the provider is in stub mode or the lookup
// fails for any reason — the caller (webhook handler) decides whether
// that's fatal.
export async function getCloudflareVideo(videoUid: string): Promise<CloudflareVideo | null> {
  if (selectProvider() === "stub") return null;
  try {
    const data = (await cfFetch(`/stream/${videoUid}`, { method: "GET" })) as CfVideoResponse;
    const r = data.result;
    return {
      uid: r.uid,
      hlsUrl: r.playback?.hls ?? "",
      thumbnailUrl: r.thumbnail ?? "",
      durationSeconds: Math.max(0, Math.floor(Number(r.duration ?? 0))),
      recordedAt: r.created ?? new Date().toISOString(),
      state: r.status?.state ?? "",
      liveInputUid: r.liveInput ?? "",
      meta: (r.meta ?? {}) as Record<string, unknown>,
    };
  } catch (err) {
    logger.error({ err: (err as Error).message, videoUid }, "cf_stream_get_video_failed");
    return null;
  }
}

export async function deleteLiveInput(uid: string): Promise<void> {
  if (selectProvider() === "stub") return;
  try {
    await cfFetch(`/stream/live_inputs/${uid}`, { method: "DELETE" });
  } catch (err) {
    logger.error({ err: (err as Error).message, uid }, "cf_stream_delete_failed");
  }
}

export function streamingProvider(): "stub" | "cloudflare" {
  return selectProvider();
}

/**
 * Boot-time sanity check (Task #23): on production-shaped deploys with
 * the Cloudflare provider enabled (CF_STREAM_API_TOKEN +
 * CF_STREAM_ACCOUNT_ID set), warn loudly if CF_STREAM_WEBHOOK_SECRET
 * is unset. Without the shared secret the inbound webhook handler
 * (routes/streamingWebhooks.ts) refuses every request with 503, so
 * Cloudflare's "video ready" notifications are dropped and replays
 * never get persisted from real broadcasts. Operators see broken
 * replays only after the first stream — the boot warn moves the
 * misconfiguration upstream of the first failure.
 *
 * Pure function — takes `env` and a `log` sink so the unit test can
 * exercise the staging-skipped, stub-skipped, and configured-silent
 * paths without poisoning `process.env`.
 */
export type CloudflareStreamWebhookConfigOutcome =
  | { ok: true }
  | { ok: false; reason: string };

export function assertCloudflareStreamWebhookConfiguredForProduction(
  env: NodeJS.ProcessEnv,
  log: { warn: (obj: unknown, msg: string) => void },
): CloudflareStreamWebhookConfigOutcome {
  const productionSignals = detectNonHostnameProductionSignals(env);
  if (productionSignals.length === 0) return { ok: true };
  const apiToken = (env.CF_STREAM_API_TOKEN ?? "").trim();
  const accountId = (env.CF_STREAM_ACCOUNT_ID ?? "").trim();
  // Only warn when CF provider is actually enabled — a production deploy
  // that intentionally hasn't wired Cloudflare Stream yet (stub mode)
  // shouldn't see a noisy warn for a webhook secret it doesn't need.
  if (apiToken === "" || accountId === "") return { ok: true };
  const webhookSecret = (env.CF_STREAM_WEBHOOK_SECRET ?? "").trim();
  if (webhookSecret !== "") return { ok: true };
  const signalDetails = productionSignals.map((s) => s.detail).join("; ");
  const reason =
    "CF_STREAM_WEBHOOK_SECRET not set on this production deploy. " +
    "The Cloudflare Stream provider is enabled (CF_STREAM_API_TOKEN + " +
    "CF_STREAM_ACCOUNT_ID are set) but without the shared secret the " +
    "inbound /api/streaming/webhooks/cloudflare handler refuses every " +
    "request with 503, so Cloudflare's video-ready notifications are " +
    "dropped and replays never get persisted from real broadcasts. " +
    `Detected production signal(s): ${signalDetails}. ` +
    "Set the missing env var — see docs/runbooks/production-secrets.md " +
    "(Cloudflare Stream section).";
  log.warn(
    {
      node_env: env.NODE_ENV,
      replit_deployment: env.REPLIT_DEPLOYMENT,
      deployment_environment: env.DEPLOYMENT_ENVIRONMENT,
      cf_stream_api_token: "[set]",
      cf_stream_account_id: "[set]",
      cf_stream_webhook_secret: null,
      production_signals: productionSignals.map((s) => s.signal),
    },
    `cf_stream_webhook_secret_missing_for_production: ${reason}`,
  );
  return { ok: false, reason };
}
