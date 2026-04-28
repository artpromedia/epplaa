import type { Request, RequestHandler } from "express";
import { sql } from "drizzle-orm";
import { db } from "../lib/db";
import { newSafeId } from "../lib/ids";
import { logger } from "../lib/logger";
import { getUserId } from "../lib/auth";
import { userHasAnyRole } from "../lib/roles";

/**
 * Per-route + per-identity rate limiter.
 *
 * Tiers (per minute, configurable via env):
 *   anon   — 60   (no Clerk session, IP-keyed)
 *   buyer  — 240  (signed in, no seller/admin role)
 *   seller — 600  (signed in seller — generous for live ops)
 *   admin  — 1200 (back-office — only realistic ceiling for paginating
 *            very large result sets)
 *
 * In-memory bucket. For multi-instance deployments swap the `BucketStore`
 * impl with a Redis-backed one (see comment at the bottom). The interface
 * is deliberately tiny so the swap is mechanical.
 */

type Tier = "anon" | "buyer" | "seller" | "admin";

interface Bucket {
  hits: number[];
}

interface BucketStore {
  bump(key: string, now: number, windowMs: number, max: number): { allowed: boolean; retryAfterMs: number };
}

class InMemoryStore implements BucketStore {
  private readonly map = new Map<string, Bucket>();
  bump(key: string, now: number, windowMs: number, max: number): { allowed: boolean; retryAfterMs: number } {
    const cutoff = now - windowMs;
    let bucket = this.map.get(key);
    if (!bucket) {
      bucket = { hits: [] };
      this.map.set(key, bucket);
    }
    bucket.hits = bucket.hits.filter((t) => t > cutoff);
    if (bucket.hits.length >= max) {
      const retryAfterMs = bucket.hits[0]! + windowMs - now;
      return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 1000) };
    }
    bucket.hits.push(now);
    return { allowed: true, retryAfterMs: 0 };
  }
  sweep(now: number, windowMs: number): void {
    const cutoff = now - windowMs;
    for (const [k, b] of this.map) {
      const newest = b.hits[b.hits.length - 1] ?? 0;
      if (newest < cutoff) this.map.delete(k);
    }
  }
}

const store = new InMemoryStore();
const SWEEP_MS = 10 * 60 * 1000;
if (process.env.NODE_ENV !== "test") {
  setInterval(() => store.sweep(Date.now(), SWEEP_MS), SWEEP_MS).unref?.();
}

const DEFAULTS: Record<Tier, number> = {
  anon: Number(process.env.RATE_LIMIT_ANON_PER_MIN ?? "60"),
  buyer: Number(process.env.RATE_LIMIT_BUYER_PER_MIN ?? "240"),
  seller: Number(process.env.RATE_LIMIT_SELLER_PER_MIN ?? "600"),
  admin: Number(process.env.RATE_LIMIT_ADMIN_PER_MIN ?? "1200"),
};

function clientIp(req: Request): string {
  if (process.env.IP_RATE_LIMIT_TRUST_PROXY === "1") {
    const xff = req.headers["x-forwarded-for"];
    const first = Array.isArray(xff) ? xff[0] : xff?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

async function resolveTier(req: Request): Promise<{ tier: Tier; identity: string }> {
  const userId = getUserId(req);
  if (!userId) return { tier: "anon", identity: `ip:${clientIp(req)}` };
  // Admin check is cheap and cached by Clerk's middleware in roles.ts. If
  // it ever becomes hot-path expensive we can inline an in-memory LRU.
  try {
    const isAdmin = await userHasAnyRole(userId, ["admin", "moderator", "finance_ops", "support"]);
    if (isAdmin) return { tier: "admin", identity: `user:${userId}` };
  } catch {
    // Failure to resolve admin role doesn't unblock — fall through to
    // buyer tier so we don't accidentally elevate a degraded request.
  }
  // Seller tier MUST be derived from a server-verified row, not a
  // client-supplied header. Earlier prototype trusted `x-app-context`
  // which let any authenticated buyer self-elevate. We now check the
  // `sellers` table for an `active` status; manufacturers are also
  // captured because manufacturer roles are stored in user_roles and
  // already match the admin branch above for finance_ops/admin staff.
  try {
    const row = await db.execute<{ status: string }>(
      sql`SELECT status FROM sellers WHERE user_id = ${userId} LIMIT 1;`,
    );
    const status = row.rows[0]?.status ?? null;
    if (status === "active" || status === "approved") {
      return { tier: "seller", identity: `user:${userId}` };
    }
  } catch {
    // Degrade closed to buyer tier if the lookup fails.
  }
  return { tier: "buyer", identity: `user:${userId}` };
}

export interface ApiRateLimitOptions {
  /** Logical name used in 429 body + audit row. */
  name?: string;
  /** Window in ms — defaults to 60_000. */
  windowMs?: number;
  /** Per-tier override (multiplied against base). */
  tierMultiplier?: Partial<Record<Tier, number>>;
}

export function apiRateLimit(opts: ApiRateLimitOptions = {}): RequestHandler {
  const name = opts.name ?? "api";
  const windowMs = opts.windowMs ?? 60_000;
  const mult = opts.tierMultiplier ?? {};
  return (req, res, next) => {
    void (async () => {
      const { tier, identity } = await resolveTier(req);
      const base = DEFAULTS[tier];
      const max = Math.max(1, Math.floor(base * (mult[tier] ?? 1)));
      const key = `${name}:${tier}:${identity}`;
      const result = store.bump(key, Date.now(), windowMs, max);
      if (!result.allowed) {
        res.setHeader("Retry-After", Math.ceil(result.retryAfterMs / 1000));
        res.status(429).json({
          error: "rate_limited",
          detail: "Request rate exceeded. Slow down and retry.",
        });
        // Fire-and-forget audit row; failure to record is non-fatal.
        void db
          .execute(
            sql`INSERT INTO rate_limit_events (id, identity, route, tier) VALUES (${newSafeId("rle_")}, ${identity}, ${req.path}, ${tier});`,
          )
          .catch((err) =>
            logger.warn({ err: (err as Error).message }, "rate_limit_event_insert_failed"),
          );
        return;
      }
      next();
    })().catch((err) => {
      logger.error({ err: (err as Error).message }, "rate_limit_unhandled");
      next();
    });
  };
}

/*
 * Redis swap-in (future):
 *   class RedisStore implements BucketStore {
 *     constructor(private readonly redis: RedisClient) {}
 *     async bump(key, now, windowMs, max) {
 *       // ZADD key now now; ZREMRANGEBYSCORE key 0 (now - windowMs); ZCARD
 *       // EXPIRE key windowMs/1000; compare against max in a Lua script
 *       // for atomicity.
 *     }
 *   }
 *   Replace the `store` const with `new RedisStore(redis)` behind an env
 *   gate; no change needed at call sites.
 */

export const __test__ = { resolveTier, store, InMemoryStore };
