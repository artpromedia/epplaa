import { sql } from "drizzle-orm";
import { db } from "./db";
import { logger } from "./logger";

export type ProductSort = "relevance" | "price_asc" | "price_desc" | "rating" | "popular";

export interface ProductSearchFilters {
  q: string;
  countryCode: string | null;
  category: string | null;
  minPriceMinor: number | null;
  maxPriceMinor: number | null;
  freeShippingOnly: boolean;
  liveOnly: boolean;
  minRating: number | null;
  sort: ProductSort;
  limit: number;
  offset: number;
}

export interface SearchProductRow {
  id: string;
  title: string;
  priceMinor: number;
  originalPriceMinor: number | null;
  originCountry: string;
  originLabel: string;
  sellerName: string;
  sellerAvatar: string;
  rating: number;
  soldCount: number;
  isLiveNow: boolean;
  images: string[];
  variants: unknown;
  category: string;
  countryCode: string;
  freeShipping: boolean;
  rank: number;
}

export interface CategoryFacet {
  category: string;
  count: number;
}

export interface SearchProductsResult {
  items: SearchProductRow[];
  totalCount: number;
  facets: { categories: CategoryFacet[] };
  degraded: boolean;
}

let providerDegraded = false;

export function getProviderInfo(): { provider: string; degraded: boolean } {
  return { provider: "postgres-fts", degraded: providerDegraded };
}

function buildTsQuery(q: string): string {
  // websearch_to_tsquery handles user input safely (quotes, OR, NOT).
  return q.trim();
}

export async function searchProducts(f: ProductSearchFilters): Promise<SearchProductsResult> {
  const q = buildTsQuery(f.q);
  const hasQuery = q.length > 0;
  const orderClause = sortFragment(f.sort, hasQuery);
  const limit = Math.max(1, Math.min(100, f.limit));
  const offset = Math.max(0, f.offset);
  try {
    const rows = await db.execute(sql`
      WITH base AS (
        SELECT
          p.id, p.title, p.price_minor AS "priceMinor",
          p.original_price_minor AS "originalPriceMinor",
          p.origin_country AS "originCountry", p.origin_label AS "originLabel",
          p.seller_name AS "sellerName", p.seller_avatar AS "sellerAvatar",
          p.rating, p.sold_count AS "soldCount", p.is_live_now AS "isLiveNow",
          p.images, p.variants, p.category, p.country_code AS "countryCode",
          p.free_shipping AS "freeShipping",
          ${hasQuery
            ? sql`ts_rank_cd(p.search_vector, websearch_to_tsquery('simple', ${q}))`
            : sql`0::real`} AS rank
        FROM products p
        WHERE 1=1
        ${hasQuery ? sql`AND p.search_vector @@ websearch_to_tsquery('simple', ${q})` : sql``}
        ${f.countryCode ? sql`AND p.country_code = ${f.countryCode}` : sql``}
        ${f.category ? sql`AND lower(p.category) = lower(${f.category})` : sql``}
        ${f.minPriceMinor !== null ? sql`AND p.price_minor >= ${f.minPriceMinor}` : sql``}
        ${f.maxPriceMinor !== null ? sql`AND p.price_minor <= ${f.maxPriceMinor}` : sql``}
        ${f.freeShippingOnly ? sql`AND p.free_shipping = true` : sql``}
        ${f.liveOnly ? sql`AND p.is_live_now = true` : sql``}
        ${f.minRating !== null ? sql`AND p.rating >= ${f.minRating}` : sql``}
      )
      SELECT *, COUNT(*) OVER() AS total_count
      FROM base
      ${orderClause}
      LIMIT ${limit} OFFSET ${offset}
    `);
    const items = (rows.rows as unknown as Array<SearchProductRow & { total_count: number | string }>)
      .map((r) => stripTotal(r));
    const totalCount = rows.rows.length > 0
      ? Number((rows.rows[0] as Record<string, unknown>).total_count)
      : 0;
    const facets = await categoryFacets(f);
    providerDegraded = false;
    return { items, totalCount, facets, degraded: false };
  } catch (err) {
    providerDegraded = true;
    logger.error({ err: (err as Error).message }, "search_products_degraded");
    return await fallbackProducts(f);
  }
}

function stripTotal(r: SearchProductRow & { total_count: number | string }): SearchProductRow {
  const { total_count: _ignore, ...rest } = r;
  void _ignore;
  return rest;
}

function sortFragment(sort: ProductSort, hasQuery: boolean) {
  switch (sort) {
    case "price_asc":
      return sql`ORDER BY "priceMinor" ASC`;
    case "price_desc":
      return sql`ORDER BY "priceMinor" DESC`;
    case "rating":
      return sql`ORDER BY rating DESC, "soldCount" DESC`;
    case "popular":
      return sql`ORDER BY "soldCount" DESC, rating DESC`;
    default:
      return hasQuery
        ? sql`ORDER BY rank DESC, "soldCount" DESC`
        : sql`ORDER BY "soldCount" DESC, rating DESC`;
  }
}

async function categoryFacets(f: ProductSearchFilters): Promise<{ categories: CategoryFacet[] }> {
  const q = buildTsQuery(f.q);
  const hasQuery = q.length > 0;
  const rows = await db.execute<{ category: string; count: string }>(sql`
    SELECT category, COUNT(*)::text AS count
    FROM products p
    WHERE 1=1
    ${hasQuery ? sql`AND p.search_vector @@ websearch_to_tsquery('simple', ${q})` : sql``}
    ${f.countryCode ? sql`AND p.country_code = ${f.countryCode}` : sql``}
    ${f.minPriceMinor !== null ? sql`AND p.price_minor >= ${f.minPriceMinor}` : sql``}
    ${f.maxPriceMinor !== null ? sql`AND p.price_minor <= ${f.maxPriceMinor}` : sql``}
    ${f.freeShippingOnly ? sql`AND p.free_shipping = true` : sql``}
    ${f.liveOnly ? sql`AND p.is_live_now = true` : sql``}
    ${f.minRating !== null ? sql`AND p.rating >= ${f.minRating}` : sql``}
    GROUP BY category
    ORDER BY COUNT(*) DESC
    LIMIT 12
  `);
  return {
    categories: rows.rows.map((r) => ({ category: r.category, count: Number(r.count) })),
  };
}

// Postgres FTS is the always-on path; fallback runs only if the FTS query
// itself errors. The fallback honors the same filter set as the primary path
// so degraded results still respect the user's criteria.
async function fallbackProducts(f: ProductSearchFilters): Promise<SearchProductsResult> {
  const like = f.q ? `%${f.q.toLowerCase()}%` : null;
  const rows = await db.execute(sql`
    WITH base AS (
      SELECT
        p.id, p.title, p.price_minor AS "priceMinor",
        p.original_price_minor AS "originalPriceMinor",
        p.origin_country AS "originCountry", p.origin_label AS "originLabel",
        p.seller_name AS "sellerName", p.seller_avatar AS "sellerAvatar",
        p.rating, p.sold_count AS "soldCount", p.is_live_now AS "isLiveNow",
        p.images, p.variants, p.category, p.country_code AS "countryCode",
        p.free_shipping AS "freeShipping",
        0::real AS rank
      FROM products p
      WHERE 1=1
      ${like ? sql`AND lower(p.title) LIKE ${like}` : sql``}
      ${f.countryCode ? sql`AND p.country_code = ${f.countryCode}` : sql``}
      ${f.category ? sql`AND lower(p.category) = lower(${f.category})` : sql``}
      ${f.minPriceMinor !== null ? sql`AND p.price_minor >= ${f.minPriceMinor}` : sql``}
      ${f.maxPriceMinor !== null ? sql`AND p.price_minor <= ${f.maxPriceMinor}` : sql``}
      ${f.freeShippingOnly ? sql`AND p.free_shipping = true` : sql``}
      ${f.liveOnly ? sql`AND p.is_live_now = true` : sql``}
      ${f.minRating !== null ? sql`AND p.rating >= ${f.minRating}` : sql``}
    ),
    facets AS (
      SELECT category, COUNT(*)::int AS count
      FROM base
      GROUP BY category
      ORDER BY count DESC
    )
    SELECT b.*, (SELECT COUNT(*) FROM base) AS total_count
    FROM base b
    ORDER BY b."soldCount" DESC
    LIMIT ${f.limit} OFFSET ${f.offset}
  `);
  const items = (rows.rows as unknown as Array<SearchProductRow & { total_count: number | string }>)
    .map(stripTotal);
  const totalCount = rows.rows.length > 0
    ? Number((rows.rows[0] as Record<string, unknown>).total_count)
    : 0;
  // Compute facets in a separate query to keep the row shape stable.
  const facets = await safeFallbackFacets(f).catch(() => ({ categories: [] }));
  return {
    items,
    totalCount,
    facets,
    degraded: true,
  };
}

async function safeFallbackFacets(f: ProductSearchFilters): Promise<SearchProductsResult["facets"]> {
  const like = f.q ? `%${f.q.toLowerCase()}%` : null;
  const rows = await db.execute<{ category: string; count: number | string }>(sql`
    SELECT p.category AS category, COUNT(*)::int AS count
    FROM products p
    WHERE 1=1
    ${like ? sql`AND lower(p.title) LIKE ${like}` : sql``}
    ${f.countryCode ? sql`AND p.country_code = ${f.countryCode}` : sql``}
    ${f.minPriceMinor !== null ? sql`AND p.price_minor >= ${f.minPriceMinor}` : sql``}
    ${f.maxPriceMinor !== null ? sql`AND p.price_minor <= ${f.maxPriceMinor}` : sql``}
    ${f.freeShippingOnly ? sql`AND p.free_shipping = true` : sql``}
    ${f.liveOnly ? sql`AND p.is_live_now = true` : sql``}
    ${f.minRating !== null ? sql`AND p.rating >= ${f.minRating}` : sql``}
    GROUP BY p.category
    ORDER BY count DESC
    LIMIT 20
  `);
  return {
    categories: rows.rows.map((r) => ({ category: r.category, count: Number(r.count) })),
  };
}

export interface SellerHit {
  sellerName: string;
  sellerAvatar: string;
  productCount: number;
  totalSold: number;
}

export async function searchSellers(q: string, limit = 20): Promise<SellerHit[]> {
  const like = q.trim() ? `%${q.trim().toLowerCase()}%` : null;
  const rows = await db.execute<{
    seller_name: string;
    seller_avatar: string;
    product_count: string;
    total_sold: string;
  }>(sql`
    SELECT seller_name,
           MIN(seller_avatar) AS seller_avatar,
           COUNT(*)::text AS product_count,
           SUM(sold_count)::text AS total_sold
    FROM products
    WHERE 1=1 ${like ? sql`AND lower(seller_name) LIKE ${like}` : sql``}
    GROUP BY seller_name
    ORDER BY SUM(sold_count) DESC
    LIMIT ${Math.max(1, Math.min(50, limit))}
  `);
  return rows.rows.map((r) => ({
    sellerName: r.seller_name,
    sellerAvatar: r.seller_avatar ?? "",
    productCount: Number(r.product_count),
    totalSold: Number(r.total_sold ?? 0),
  }));
}

export interface StreamHit {
  id: string;
  title: string;
  hostName: string;
  hostAvatar: string;
  posterImage: string;
  isLive: boolean;
  currentViewers: number;
}

export async function searchStreams(q: string, limit = 20): Promise<StreamHit[]> {
  const like = q.trim() ? `%${q.trim().toLowerCase()}%` : null;
  const rows = await db.execute<{
    id: string;
    title: string;
    host_name: string;
    host_avatar: string;
    poster_image: string;
    is_live: boolean;
    current_viewers: number;
  }>(sql`
    SELECT id, title, host_name, host_avatar, poster_image, is_live, current_viewers
    FROM streams
    WHERE 1=1 ${like ? sql`AND (lower(title) LIKE ${like} OR lower(host_name) LIKE ${like})` : sql``}
    ORDER BY is_live DESC, current_viewers DESC, created_at DESC
    LIMIT ${Math.max(1, Math.min(50, limit))}
  `);
  return rows.rows.map((r) => ({
    id: r.id,
    title: r.title,
    hostName: r.host_name,
    hostAvatar: r.host_avatar ?? "",
    posterImage: r.poster_image ?? "",
    isLive: !!r.is_live,
    currentViewers: Number(r.current_viewers ?? 0),
  }));
}
