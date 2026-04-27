import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { requireUserId } from "../lib/auth";

const router: IRouter = Router();

async function listWishlist(userId: string): Promise<string[]> {
  const rows = await db
    .select()
    .from(schema.wishlistTable)
    .where(eq(schema.wishlistTable.userId, userId))
    .orderBy(desc(schema.wishlistTable.createdAt));
  return rows.map((r) => r.productId);
}

router.get("/wishlist", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  res.json(await listWishlist(userId));
});

router.delete("/wishlist", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  await db.delete(schema.wishlistTable).where(eq(schema.wishlistTable.userId, userId));
  res.status(204).end();
});

router.post("/wishlist/:productId", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  await db
    .insert(schema.wishlistTable)
    .values({ userId, productId: req.params.productId })
    .onConflictDoNothing();
  res.json(await listWishlist(userId));
});

router.delete("/wishlist/:productId", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  await db
    .delete(schema.wishlistTable)
    .where(and(eq(schema.wishlistTable.userId, userId), eq(schema.wishlistTable.productId, req.params.productId)));
  res.json(await listWishlist(userId));
});

export default router;
