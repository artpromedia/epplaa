import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { requireUserId } from "../lib/auth";

const router: IRouter = Router();

async function listFollows(userId: string): Promise<string[]> {
  const rows = await db.select().from(schema.followsTable).where(eq(schema.followsTable.userId, userId));
  return rows.map((r) => r.sellerName);
}

router.get("/follows", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  res.json(await listFollows(userId));
});

router.post("/follows/:sellerName", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  await db
    .insert(schema.followsTable)
    .values({ userId, sellerName: req.params.sellerName })
    .onConflictDoNothing();
  res.json(await listFollows(userId));
});

router.delete("/follows/:sellerName", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  await db
    .delete(schema.followsTable)
    .where(and(eq(schema.followsTable.userId, userId), eq(schema.followsTable.sellerName, req.params.sellerName)));
  res.json(await listFollows(userId));
});

export default router;
