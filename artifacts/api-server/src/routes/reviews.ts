import { Router, type IRouter } from "express";
import { eq, and, desc, SQL } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { getUserId, requireUserId } from "../lib/auth";
import { newReviewId } from "../lib/ids";

const router: IRouter = Router();

router.get("/reviews", async (req, res) => {
  const { productId, sellerName, orderId, mine } = req.query as {
    productId?: string;
    sellerName?: string;
    orderId?: string;
    mine?: string;
  };
  const conditions: SQL[] = [];
  if (productId) conditions.push(eq(schema.reviewsTable.productId, productId));
  if (sellerName) conditions.push(eq(schema.reviewsTable.sellerName, sellerName));
  if (orderId) conditions.push(eq(schema.reviewsTable.orderId, orderId));
  if (mine === "true") {
    const userId = getUserId(req);
    if (!userId) {
      res.json([]);
      return;
    }
    conditions.push(eq(schema.reviewsTable.userId, userId));
  }
  const rows = await db
    .select()
    .from(schema.reviewsTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.reviewsTable.createdAt));
  res.json(
    rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      orderId: r.orderId,
      productId: r.productId,
      sellerName: r.sellerName,
      rating: r.rating,
      text: r.text,
      createdAtIso: r.createdAt.toISOString(),
    })),
  );
});

router.post("/reviews", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const body = req.body as {
    orderId: string;
    productId: string;
    sellerName: string;
    rating: number;
    text?: string;
  };
  // dedupe per (orderId, productId, userId) — replace existing
  await db
    .delete(schema.reviewsTable)
    .where(
      and(
        eq(schema.reviewsTable.userId, userId),
        eq(schema.reviewsTable.orderId, body.orderId),
        eq(schema.reviewsTable.productId, body.productId),
      ),
    );
  const [row] = await db
    .insert(schema.reviewsTable)
    .values({
      id: newReviewId(),
      userId,
      orderId: body.orderId,
      productId: body.productId,
      sellerName: body.sellerName,
      rating: Math.max(1, Math.min(5, Number(body.rating))),
      text: body.text ?? "",
    })
    .returning();
  res.status(201).json({
    id: row.id,
    userId: row.userId,
    orderId: row.orderId,
    productId: row.productId,
    sellerName: row.sellerName,
    rating: row.rating,
    text: row.text,
    createdAtIso: row.createdAt.toISOString(),
  });
});

export default router;
