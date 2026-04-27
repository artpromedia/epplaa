import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, schema } from "../lib/db";

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

export default router;
