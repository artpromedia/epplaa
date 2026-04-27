import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, schema } from "../lib/db";

const router: IRouter = Router();

function rowToReplay(r: typeof schema.replaysTable.$inferSelect) {
  return {
    id: r.id,
    hostName: r.hostName,
    hostAvatar: r.hostAvatar,
    posterImage: r.posterImage,
    title: r.title,
    durationLabel: r.durationLabel,
    durationSeconds: r.durationSeconds,
    viewCount: r.viewCount,
    recordedAtIso: r.recordedAt.toISOString(),
    productIds: r.productIds,
    liveStreamId: r.liveStreamId,
  };
}

router.get("/replays", async (_req, res) => {
  const rows = await db.select().from(schema.replaysTable).orderBy(desc(schema.replaysTable.recordedAt));
  res.json(rows.map(rowToReplay));
});

router.get("/replays/:replayId", async (req, res) => {
  const [row] = await db
    .select()
    .from(schema.replaysTable)
    .where(eq(schema.replaysTable.id, req.params.replayId))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(rowToReplay(row));
});

export default router;
