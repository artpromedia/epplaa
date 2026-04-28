import type { Request, RequestHandler } from "express";
import { sql } from "drizzle-orm";
import IORedis, { type Redis } from "ioredis";
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
 * Bucket store is selected by `RATE_LIMIT_STORE`:
 *   - unset / "memory" — process-local sliding window log. Fine for a
 *     single api-server replica.
 *   - "redis"          — sliding window log stored in Redis via an
 *     atomic Lua script. Required before scaling horizontally because
 *     each in-memory replica would otherwise own its own quota,
 *     effectively multiplying the cap by the replica count.
 */

type Tier = "anon" | "buyer" | "seller" | "admin";

interface BumpResult {
  allowed: boolean;
  retryAfterMs: number;
}

interface BucketStore {
  bump(key: string, now: number, windowMs: number, max: number): Promise<BumpResult>;
}

interface Bucket {
  hits: number[];
}

class InMemoryStore implements BucketStore {
  private readonly map = new Map<string, Bucket>();
  async bump(key: string, now: number, windowMs: number, max: number): Promise<BumpResult> {
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

/**
 * Lua-backed sliding-window log. We use a sorted set per key:
 *   score  = hit timestamp (ms)
 *   member = unique nonce per insert (ts + nonce) so ZADD never collides
 *
 * The script atomically:
 *   1. Drops scores <= now - windowMs (matches InMemoryStore's strict
 *      `t > cutoff` filter).
 *   2. Returns 429 + a Retry-After hint when ZCARD >= max.
 *   3. Otherwise ZADDs the new hit and refreshes PEXPIRE.
 *
 * Atomicity matters: without the script, two concurrent requests at
 * `max - 1` could each read the count, both decide they're allowed,
 * and both write — slipping a request past the cap.
 */
const RATE_LIMIT_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local max = tonumber(ARGV[3])
local member = ARGV[4]
local cutoff = now - windowMs
redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)
local count = redis.call('ZCARD', key)
if count >= max then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retryAfter = (tonumber(oldest[2]) + windowMs) - now
  if retryAfter < 1000 then retryAfter = 1000 end
  return {0, retryAfter}
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, windowMs + 1000)
return {1, 0}
`;

interface RateLimitRedis extends Redis {
  rateLimitBump(
    key: string,
    now: string,
    windowMs: string,
    max: string,
    member: string,
  ): Promise<[number, number]>;
}

class RedisStore implements BucketStore {
  private readonly redis: RateLimitRedis;
  private memberSeq = 0;
  constructor(redis: Redis) {
    redis.defineCommand("rateLimitBump", {
      numberOfKeys: 1,
      lua: RATE_LIMIT_LUA,
    });
    this.redis = redis as RateLimitRedis;
  }
  async bump(key: string, now: number, windowMs: number, max: number): Promise<BumpResult> {
    // Unique member to avoid ZADD score collisions when two hits land on
    // the same millisecond. Process pid + monotonic counter is enough —
    // a redis-side INCR would add a round-trip and break atomicity.
    this.memberSeq = (this.memberSeq + 1) >>> 0;
    const member = `${now}:${process.pid}:${this.memberSeq}`;
    try {
      const [allowed, retryAfter] = await this.redis.rateLimitBump(
        key,
        String(now),
        String(windowMs),
        String(max),
        member,
      );
      return {
        allowed: Number(allowed) === 1,
        retryAfterMs: Number(retryAfter),
      };
    } catch (err) {
      // Degrade open if Redis is unreachable — better to serve than to
      // 429 every request because of a backing-store outage. The error
      // is logged so on-call can react.
      logger.error(
        { err: (err as Error).message },
        "rate_limit_redis_bump_failed",
      );
      return { allowed: true, retryAfterMs: 0 };
    }
  }
}

function createBucketStore(): BucketStore {
  const kind = (process.env.RATE_LIMIT_STORE ?? "memory").toLowerCase();
  if (kind === "redis") {
    const url = process.env.REDIS_URL;
    if (!url) {
      throw new Error(
        "RATE_LIMIT_STORE=redis requires REDIS_URL to be set",
      );
    }
    const client = new IORedis(url, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
    });
    client.on("error", (err) => {
      logger.error(
        { err: err.message },
        "rate_limit_redis_client_error",
      );
    });
    return new RedisStore(client);
  }
  if (kind !== "memory") {
    logger.warn(
      { kind },
      "rate_limit_store_unknown_kind_falling_back_to_memory",
    );
  }
  return new InMemoryStore();
}

const store: BucketStore = createBucketStore();
const SWEEP_MS = 10 * 60 * 1000;
if (store instanceof InMemoryStore && process.env.NODE_ENV !== "test") {
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
  /**
   * When true (default for the un-named global mount), the bucket is
   * additionally keyed by `${method}:${path}` so abuse on one endpoint
   * cannot exhaust quota for the rest of the API. Per-route mounts
   * (those passing an explicit `name`) opt out by default since their
   * bucket name is already route-scoped.
   */
  perRoute?: boolean;
}

export function apiRateLimit(opts: ApiRateLimitOptions = {}): RequestHandler {
  const name = opts.name ?? "api";
  const windowMs = opts.windowMs ?? 60_000;
  const mult = opts.tierMultiplier ?? {};
  const perRoute = opts.perRoute ?? opts.name === undefined;
  return (req, res, next) => {
    void (async () => {
      const { tier, identity } = await resolveTier(req);
      const base = DEFAULTS[tier];
      const max = Math.max(1, Math.floor(base * (mult[tier] ?? 1)));
      // Per-route + per-identity key. Using `req.route?.path` would be
      // ideal but it's only populated after the matching layer runs;
      // `req.path` is stable here. We strip query string to avoid
      // unbounded cardinality on attacker-controlled query params.
      const routeKey = perRoute ? `${req.method}:${req.path.split("?")[0]}` : "*";
      const key = `${name}:${tier}:${routeKey}:${identity}`;
      const result = await store.bump(key, Date.now(), windowMs, max);
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

export const __test__ = { resolveTier, store, InMemoryStore, RedisStore };
