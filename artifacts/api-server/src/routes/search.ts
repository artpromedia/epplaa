import { Router, type IRouter } from "express";
import {
  searchProducts,
  searchSellers,
  searchStreams,
  getProviderInfo,
  type ProductSort,
} from "../lib/search";

const router: IRouter = Router();

const ALLOWED_SORTS: ProductSort[] = ["relevance", "price_asc", "price_desc", "rating", "popular"];

router.get("/search/_provider/info", (_req, res) => {
  res.json(getProviderInfo());
});

router.get("/search/products", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const countryCode = optString(req.query.countryCode);
  const category = optString(req.query.category);
  const sortRaw = String(req.query.sort ?? "relevance") as ProductSort;
  const sort: ProductSort = ALLOWED_SORTS.includes(sortRaw) ? sortRaw : "relevance";
  const result = await searchProducts({
    q,
    countryCode,
    category,
    minPriceMinor: optInt(req.query.minPriceMinor),
    maxPriceMinor: optInt(req.query.maxPriceMinor),
    minRating: optFloat(req.query.minRating),
    freeShippingOnly: req.query.freeShippingOnly === "true",
    liveOnly: req.query.liveOnly === "true",
    sort,
    limit: clampInt(optInt(req.query.limit), 24, 1, 100),
    offset: clampInt(optInt(req.query.offset), 0, 0, 10_000),
  });
  res.json(result);
});

router.get("/search/sellers", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const limit = clampInt(optInt(req.query.limit), 20, 1, 50);
  res.json({ items: await searchSellers(q, limit) });
});

router.get("/search/streams", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const limit = clampInt(optInt(req.query.limit), 20, 1, 50);
  res.json({ items: await searchStreams(q, limit) });
});

function optString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function optInt(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function optFloat(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clampInt(v: number | null, def: number, min: number, max: number): number {
  const n = v ?? def;
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

export default router;
