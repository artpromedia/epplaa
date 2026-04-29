import { sql } from "drizzle-orm";
import { db } from "./db";
import { toDateOrNull } from "./dbTimestamps";
import { logger } from "./logger";
import type { SearchProductRow } from "./search";

export interface ForYouProduct extends SearchProductRow {
  reasons: string[];
  score: number;
}

// Heuristic v1: blend (followed-seller) + (wishlist-category) + (recently-viewed-category) +
// (country match) + (popularity). Pure SQL so we can revisit later behind the same interface.
export async function forYouProducts(
  userId: string | null,
  countryCode: string | null,
  limit = 12,
): Promise<ForYouProduct[]> {
  const cap = Math.max(1, Math.min(48, limit));
  try {
    const rows = await db.execute<{
      id: string;
      title: string;
      price_minor: number;
      original_price_minor: number | null;
      origin_country: string;
      origin_label: string;
      seller_name: string;
      seller_avatar: string;
      rating: number;
      sold_count: number;
      is_live_now: boolean;
      images: string[];
      variants: unknown;
      category: string;
      country_code: string;
      free_shipping: boolean;
      score: number;
      reasons: string[] | null;
    }>(sql`
      WITH followed AS (
        SELECT seller_name FROM follows WHERE user_id = ${userId ?? ""}
      ),
      wished AS (
        SELECT DISTINCT p.category
        FROM wishlist w JOIN products p ON p.id = w.product_id
        WHERE w.user_id = ${userId ?? ""}
      ),
      viewed AS (
        SELECT DISTINCT p.category
        FROM recently_viewed rv JOIN products p ON p.id = rv.product_id
        WHERE rv.user_id = ${userId ?? ""}
      ),
      scored AS (
        SELECT
          p.*,
          (
            (CASE WHEN p.seller_name IN (SELECT seller_name FROM followed) THEN 50 ELSE 0 END)
          + (CASE WHEN p.category IN (SELECT category FROM wished) THEN 25 ELSE 0 END)
          + (CASE WHEN p.category IN (SELECT category FROM viewed) THEN 15 ELSE 0 END)
          + (CASE WHEN ${countryCode ?? ""} <> '' AND p.country_code = ${countryCode ?? ""} THEN 10 ELSE 0 END)
          + LEAST(p.sold_count::float / 50.0, 20)
          + LEAST(p.rating * 2, 10)
          + LEAST(p.view_count::float / 100.0, 5)
          )::real AS score,
          ARRAY_REMOVE(ARRAY[
            CASE WHEN p.seller_name IN (SELECT seller_name FROM followed) THEN 'follows' END,
            CASE WHEN p.category IN (SELECT category FROM wished) THEN 'wishlist' END,
            CASE WHEN p.category IN (SELECT category FROM viewed) THEN 'recently_viewed' END,
            CASE WHEN ${countryCode ?? ""} <> '' AND p.country_code = ${countryCode ?? ""} THEN 'country' END,
            CASE WHEN p.sold_count > 25 THEN 'trending' END
          ], NULL) AS reasons
        FROM products p
      )
      SELECT * FROM scored
      ORDER BY score DESC, sold_count DESC
      LIMIT ${cap}
    `);
    return rows.rows.map((r) => ({
      id: r.id,
      title: r.title,
      priceMinor: r.price_minor,
      originalPriceMinor: r.original_price_minor,
      originCountry: r.origin_country,
      originLabel: r.origin_label,
      sellerName: r.seller_name,
      sellerAvatar: r.seller_avatar ?? "",
      rating: r.rating,
      soldCount: r.sold_count,
      isLiveNow: r.is_live_now,
      images: r.images,
      variants: r.variants,
      category: r.category,
      countryCode: r.country_code,
      freeShipping: r.free_shipping,
      rank: 0,
      score: r.score,
      reasons: r.reasons ?? [],
    }));
  } catch (err) {
    logger.error({ err: (err as Error).message }, "for_you_query_failed");
    return [];
  }
}

export interface TrendingStream {
  id: string;
  title: string;
  hostName: string;
  hostAvatar: string;
  posterImage: string;
  isLive: boolean;
  currentViewers: number;
  peakViewers: number;
  score: number;
}

interface CacheEntry { at: number; value: TrendingStream[]; }
/**
 * Trending streams cache TTL. Trending is read on every discovery
 * page open and live presence churn (joins/leaves) bumps the
 * underlying `current_viewers` integer many times per second per
 * stream, so we cap the recompute frequency at this interval.
 *
 * The cache is also explicitly flushed by `invalidateTrendingCache()`
 * whenever a stream transitions live/ended (see `streamLifecycle.ts`)
 * so a brand-new live stream — or a just-ended one — never has to
 * wait the full TTL to appear/disappear from the rail.
 */
export const TRENDING_TTL_MS = 15_000;
let cache: CacheEntry | null = null;

/**
 * Drop the trending-streams cache so the next caller recomputes from
 * Postgres. Safe to call from any code path that materially changes
 * what trending should rank (go-live, end, viewer thrash that crosses
 * a meaningful threshold). No-op when the cache is already cold.
 */
export function invalidateTrendingCache(): void {
  cache = null;
}

export async function trendingStreams(limit = 10): Promise<TrendingStream[]> {
  const now = Date.now();
  if (cache && now - cache.at < TRENDING_TTL_MS) {
    return cache.value.slice(0, limit);
  }
  try {
    // Note: `started_at` is typed as `Date | string | null` because raw
    // `db.execute` SQL returns TIMESTAMPTZ as the pg driver string, NOT
    // as a `Date` (the typed query builder is what runs the column type
    // parser). Always normalise via `toDateOrNull()` before doing date
    // arithmetic — see `./dbTimestamps` for the full pitfall write-up.
    const rows = await db.execute<{
      id: string;
      title: string;
      host_name: string;
      host_avatar: string;
      poster_image: string;
      is_live: boolean;
      current_viewers: number;
      peak_viewers: number;
      started_at: Date | string | null;
    }>(sql`
      SELECT id, title, host_name, host_avatar, poster_image, is_live,
             current_viewers, peak_viewers, started_at
      FROM streams
      WHERE status = 'live'
         OR is_live = true
         OR (ended_at IS NOT NULL AND ended_at > NOW() - INTERVAL '15 minutes')
         OR (created_at > NOW() - INTERVAL '15 minutes')
      ORDER BY is_live DESC, current_viewers DESC
      LIMIT 100
    `);
    const scored: TrendingStream[] = rows.rows.map((r) => {
      const startedAt = toDateOrNull(r.started_at);
      const ageSec = startedAt ? Math.max(1, (now - startedAt.getTime()) / 1000) : 900;
      const growth = r.current_viewers / Math.sqrt(ageSec / 60 + 1);
      const score = (r.is_live ? 100 : 0) + growth + r.peak_viewers * 0.05;
      return {
        id: r.id,
        title: r.title,
        hostName: r.host_name,
        hostAvatar: r.host_avatar ?? "",
        posterImage: r.poster_image ?? "",
        isLive: !!r.is_live,
        currentViewers: Number(r.current_viewers ?? 0),
        peakViewers: Number(r.peak_viewers ?? 0),
        score: Math.round(score * 100) / 100,
      };
    });
    scored.sort((a, b) => b.score - a.score);
    cache = { at: now, value: scored };
    return scored.slice(0, limit);
  } catch (err) {
    logger.error({ err: (err as Error).message }, "trending_streams_failed");
    return [];
  }
}
