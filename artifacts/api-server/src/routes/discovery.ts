import { Router, type IRouter } from "express";
import { eq, desc, sql } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { requireUserId } from "../lib/auth";
import { forYouProducts, trendingStreams } from "../lib/recommender";

const router: IRouter = Router();

const RECENT_VIEW_MAX = 12;
const RECENT_SEARCH_MAX = 8;

async function listRecentlyViewed(userId: string): Promise<string[]> {
  const rows = await db
    .select()
    .from(schema.recentlyViewedTable)
    .where(eq(schema.recentlyViewedTable.userId, userId))
    .orderBy(desc(schema.recentlyViewedTable.viewedAt))
    .limit(RECENT_VIEW_MAX);
  return rows.map((r) => r.productId);
}

router.get("/recently-viewed", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  res.json(await listRecentlyViewed(userId));
});

router.delete("/recently-viewed", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  await db.delete(schema.recentlyViewedTable).where(eq(schema.recentlyViewedTable.userId, userId));
  res.status(204).end();
});

router.post("/recently-viewed/:productId", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const productId = req.params.productId;
  await db
    .insert(schema.recentlyViewedTable)
    .values({ userId, productId })
    .onConflictDoUpdate({
      target: [schema.recentlyViewedTable.userId, schema.recentlyViewedTable.productId],
      set: { viewedAt: new Date() },
    });
  res.json(await listRecentlyViewed(userId));
});

async function listRecentSearches(userId: string): Promise<string[]> {
  const rows = await db
    .select()
    .from(schema.recentSearchesTable)
    .where(eq(schema.recentSearchesTable.userId, userId))
    .orderBy(desc(schema.recentSearchesTable.searchedAt))
    .limit(RECENT_SEARCH_MAX);
  return rows.map((r) => r.query);
}

router.get("/recent-searches", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  res.json(await listRecentSearches(userId));
});

router.delete("/recent-searches", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  await db.delete(schema.recentSearchesTable).where(eq(schema.recentSearchesTable.userId, userId));
  res.status(204).end();
});

router.post("/recent-searches", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const query = String((req.body as { query?: string }).query ?? "").trim();
  if (!query) {
    res.json(await listRecentSearches(userId));
    return;
  }
  await db
    .delete(schema.recentSearchesTable)
    .where(
      sql`${schema.recentSearchesTable.userId} = ${userId} AND lower(${schema.recentSearchesTable.query}) = lower(${query})`,
    );
  await db.insert(schema.recentSearchesTable).values({ userId, query });
  res.json(await listRecentSearches(userId));
});

router.get("/discovery/for-you", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const country = typeof req.query.country === "string" ? req.query.country.trim() : "";
  const items = await forYouProducts(userId, country || null, clampLimit(req.query.limit, 12, 50));
  res.json({ items });
});

router.get("/discovery/trending-streams", async (req, res) => {
  const items = await trendingStreams(clampLimit(req.query.limit, 10, 50));
  res.json({ items });
});

function clampLimit(raw: unknown, def: number, max: number): number {
  const n = Number(raw ?? def);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

export default router;
