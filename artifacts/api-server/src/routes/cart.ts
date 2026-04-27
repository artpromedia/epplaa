import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { requireUserId } from "../lib/auth";

const router: IRouter = Router();

async function readCart(userId: string) {
  const rows = await db.select().from(schema.cartItemsTable).where(eq(schema.cartItemsTable.userId, userId));
  return {
    items: rows.map((r) => ({ productId: r.productId, qty: r.qty, variantNotes: r.variantNotes })),
  };
}

router.get("/cart", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  res.json(await readCart(userId));
});

router.delete("/cart", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  await db.delete(schema.cartItemsTable).where(eq(schema.cartItemsTable.userId, userId));
  res.status(204).end();
});

router.put("/cart/items/:productId", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const { productId } = req.params;
  const body = req.body as { qty?: number; variantNotes?: string };
  const qty = Math.max(0, Number(body.qty ?? 0));
  if (qty === 0) {
    await db
      .delete(schema.cartItemsTable)
      .where(and(eq(schema.cartItemsTable.userId, userId), eq(schema.cartItemsTable.productId, productId)));
  } else {
    await db
      .insert(schema.cartItemsTable)
      .values({ userId, productId, qty, variantNotes: body.variantNotes ?? null })
      .onConflictDoUpdate({
        target: [schema.cartItemsTable.userId, schema.cartItemsTable.productId],
        set: { qty, variantNotes: body.variantNotes ?? null },
      });
  }
  res.json(await readCart(userId));
});

router.delete("/cart/items/:productId", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  await db
    .delete(schema.cartItemsTable)
    .where(and(eq(schema.cartItemsTable.userId, userId), eq(schema.cartItemsTable.productId, req.params.productId)));
  res.json(await readCart(userId));
});

export default router;
