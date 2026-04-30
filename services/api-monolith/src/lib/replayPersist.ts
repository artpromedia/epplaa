import { db, schema } from "./db";
import { eq } from "drizzle-orm";
import { listRecordedVideos } from "./streaming";
import { newSafeId } from "./ids";
import { logger } from "./logger";

export interface ReplayVideoSnapshot {
  uid: string;
  hlsUrl: string;
  thumbnailUrl: string;
  durationSeconds: number;
  recordedAt: string;
}

export interface PersistReplayResult {
  persisted: boolean;
  alreadyExisted: boolean;
  replayId: string | null;
}

/**
 * Idempotently write a replay row + sync the stream's `cf_video_uid` and
 * `hls_url` fields from the supplied video snapshot. The (streamId, video)
 * pair is the only input — the caller is responsible for sourcing the
 * snapshot (CF webhook payload, REST lookup, or any future provider).
 *
 * Idempotency is enforced by checking for an existing replay row keyed
 * on `live_stream_id`. Concurrent callers (e.g. the stop endpoint racing
 * a CF "video ready" webhook delivery) will both observe the same
 * post-condition: at most one replay row per stream.
 */
export async function persistReplayFromVideo(
  streamId: string,
  video: ReplayVideoSnapshot,
): Promise<PersistReplayResult> {
  const [stream] = await db
    .select()
    .from(schema.streamsTable)
    .where(eq(schema.streamsTable.id, streamId))
    .limit(1);
  if (!stream) {
    return { persisted: false, alreadyExisted: false, replayId: null };
  }
  const existing = await db
    .select({ id: schema.replaysTable.id })
    .from(schema.replaysTable)
    .where(eq(schema.replaysTable.liveStreamId, streamId))
    .limit(1);
  if (existing.length > 0) {
    // Replay already exists; still ensure the stream row carries the
    // freshest cf_video_uid + hls_url so the buyer-facing playback
    // metadata is consistent if the webhook delivers an updated url.
    if (video.uid && video.hlsUrl && (stream.cfVideoUid !== video.uid || stream.hlsUrl !== video.hlsUrl)) {
      await db
        .update(schema.streamsTable)
        .set({ cfVideoUid: video.uid, hlsUrl: video.hlsUrl })
        .where(eq(schema.streamsTable.id, stream.id));
    }
    return { persisted: false, alreadyExisted: true, replayId: existing[0].id };
  }
  const startedMs = stream.startedAt?.getTime() ?? Date.now();
  const endedMs = stream.endedAt?.getTime() ?? Date.now();
  const durationSeconds =
    video.durationSeconds || Math.max(0, Math.floor((endedMs - startedMs) / 1000));
  const replayId = newSafeId("rpl");
  try {
    await db.insert(schema.replaysTable).values({
      id: replayId,
      hostName: stream.hostName,
      hostAvatar: stream.hostAvatar ?? "",
      posterImage: video.thumbnailUrl || stream.posterImage || "",
      title: stream.title,
      durationLabel: formatDuration(durationSeconds),
      durationSeconds,
      viewCount: String(stream.peakViewers),
      productIds: stream.currentProductId ? [stream.currentProductId] : [],
      liveStreamId: stream.id,
      playbackUrl: video.hlsUrl || null,
    });
  } catch (err) {
    // Concurrent CF webhook deliveries can both pass the existence
    // check and race the insert. The partial unique index on
    // `replays.live_stream_id` (see lib/db/src/schema/replays.ts)
    // serializes them: the loser sees a unique violation and re-reads
    // the winner's row. We still sync the stream's cf_video_uid /
    // hls_url so the buyer-facing playback metadata is consistent.
    if (isUniqueViolation(err)) {
      const [winner] = await db
        .select({ id: schema.replaysTable.id })
        .from(schema.replaysTable)
        .where(eq(schema.replaysTable.liveStreamId, streamId))
        .limit(1);
      if (winner) {
        if (video.uid && video.hlsUrl && (stream.cfVideoUid !== video.uid || stream.hlsUrl !== video.hlsUrl)) {
          await db
            .update(schema.streamsTable)
            .set({ cfVideoUid: video.uid, hlsUrl: video.hlsUrl })
            .where(eq(schema.streamsTable.id, stream.id));
        }
        return { persisted: false, alreadyExisted: true, replayId: winner.id };
      }
    }
    throw err;
  }
  await db
    .update(schema.streamsTable)
    .set({ cfVideoUid: video.uid, hlsUrl: video.hlsUrl })
    .where(eq(schema.streamsTable.id, stream.id));
  return { persisted: true, alreadyExisted: false, replayId };
}

function isUniqueViolation(err: unknown): boolean {
  // Postgres SQLSTATE 23505 = unique_violation. The pg driver attaches
  // the SQLSTATE to `error.code`, but drizzle wraps every DB error in
  // a `DrizzleQueryError` and stashes the original on `.cause`. Walk
  // up to two levels to handle both shapes.
  for (let cur: unknown = err, depth = 0; cur && depth < 3; depth++) {
    if (typeof cur === "object" && cur !== null) {
      const code = (cur as { code?: string }).code;
      if (code === "23505") return true;
      cur = (cur as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return false;
}

/**
 * Best-effort fallback path triggered when a seller hits "stop". The
 * Cloudflare "video ready" webhook is the primary source of replay
 * persistence (see routes/streamingWebhooks.ts), but for legacy stub
 * provider, dev mode, or webhook-delivery delays this polls the live
 * input's recorded videos and writes the replay row if one is already
 * available. Either path converges on `persistReplayFromVideo`.
 */
export async function persistReplayForEndedStream(streamId: string): Promise<void> {
  const [stream] = await db
    .select()
    .from(schema.streamsTable)
    .where(eq(schema.streamsTable.id, streamId))
    .limit(1);
  if (!stream) return;
  if (!stream.cfInputId) return;
  try {
    const videos = await listRecordedVideos(stream.cfInputId);
    const v = videos[0];
    if (!v) return;
    const result = await persistReplayFromVideo(streamId, v);
    if (result.persisted) {
      logger.info({ streamId, videoUid: v.uid, replayId: result.replayId }, "replay_persisted_after_stream_end");
    }
  } catch (err) {
    logger.error({ err: (err as Error).message, streamId }, "replay_persist_failed");
  }
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}
