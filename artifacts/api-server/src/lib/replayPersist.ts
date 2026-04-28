import { db, schema } from "./db";
import { eq } from "drizzle-orm";
import { listRecordedVideos } from "./streaming";
import { newSafeId } from "./ids";
import { logger } from "./logger";

export async function persistReplayForEndedStream(streamId: string): Promise<void> {
  const [stream] = await db
    .select()
    .from(schema.streamsTable)
    .where(eq(schema.streamsTable.id, streamId))
    .limit(1);
  if (!stream) return;
  if (!stream.cfInputId) return;
  const existing = await db
    .select({ id: schema.replaysTable.id })
    .from(schema.replaysTable)
    .where(eq(schema.replaysTable.liveStreamId, streamId))
    .limit(1);
  if (existing.length > 0) return;
  try {
    const videos = await listRecordedVideos(stream.cfInputId);
    const v = videos[0];
    if (!v) return;
    const startedMs = stream.startedAt?.getTime() ?? Date.now();
    const endedMs = stream.endedAt?.getTime() ?? Date.now();
    const durationSeconds = v.durationSeconds || Math.max(0, Math.floor((endedMs - startedMs) / 1000));
    await db.insert(schema.replaysTable).values({
      id: newSafeId("rpl"),
      hostName: stream.hostName,
      hostAvatar: stream.hostAvatar ?? "",
      posterImage: v.thumbnailUrl || stream.posterImage || "",
      title: stream.title,
      durationLabel: formatDuration(durationSeconds),
      durationSeconds,
      viewCount: String(stream.peakViewers),
      productIds: stream.currentProductId ? [stream.currentProductId] : [],
      liveStreamId: stream.id,
      playbackUrl: v.hlsUrl || null,
    });
    await db
      .update(schema.streamsTable)
      .set({ cfVideoUid: v.uid, hlsUrl: v.hlsUrl })
      .where(eq(schema.streamsTable.id, stream.id));
    logger.info({ streamId, videoUid: v.uid }, "replay_persisted_after_stream_end");
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
