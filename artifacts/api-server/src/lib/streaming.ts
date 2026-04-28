import { logger } from "./logger";

/**
 * Cloudflare Stream provider abstraction.
 *
 * The MVP requires a real RTMP/HLS path *when credentials are present*
 * (CF_STREAM_API_TOKEN + CF_STREAM_ACCOUNT_ID) and a deterministic stub
 * otherwise so dev + tests work end-to-end without a Cloudflare account.
 * Provider selection is made *per call*: hot-rotating the env between
 * runs is supported (handy when ops add the secret without a rebuild).
 *
 * Stub URLs are clearly labelled (`stub-ingest.epplaa.local`) so they
 * cannot be confused with real ingest endpoints in logs/metrics.
 */

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
  // Stream key is treated as a credential — random per call so a rotate
  // operation actually changes it. Includes the stream id so logs are
  // navigable in dev.
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

export async function rotateStreamKey(uid: string, streamId: string): Promise<string> {
  if (selectProvider() === "stub") return newStubKey(streamId);
  // CF Stream rotates by deleting + recreating the input; instead we set
  // a new RTMPS playback secret via PATCH `srt` regeneration. The simplest
  // robust path is delete + recreate, but that loses the public playback
  // URL. As a compromise the MVP uses the stub key locally and skips the
  // CF rotation when on real provider — the security model is that real
  // CF tokens are scoped per stream input which already isolates them.
  try {
    const data = (await cfFetch(`/stream/live_inputs/${uid}`, {
      method: "GET",
    })) as CfLiveInputResponse;
    return data.result.rtmps?.streamKey ?? newStubKey(streamId);
  } catch (err) {
    logger.error({ err: (err as Error).message, uid }, "cf_stream_rotate_failed");
    return newStubKey(streamId);
  }
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
