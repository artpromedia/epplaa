import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { requireUserId } from "../lib/auth";

const router: IRouter = Router();

router.get("/checkout-draft", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const [row] = await db
    .select()
    .from(schema.checkoutDraftsTable)
    .where(eq(schema.checkoutDraftsTable.userId, userId))
    .limit(1);
  res.json(row?.draft ?? {});
});

router.put("/checkout-draft", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const draft = req.body ?? {};
  const [row] = await db
    .insert(schema.checkoutDraftsTable)
    .values({ userId, draft })
    .onConflictDoUpdate({ target: schema.checkoutDraftsTable.userId, set: { draft } })
    .returning();
  res.json(row.draft);
});

router.delete("/checkout-draft", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  await db.delete(schema.checkoutDraftsTable).where(eq(schema.checkoutDraftsTable.userId, userId));
  res.status(204).end();
});

export default router;
