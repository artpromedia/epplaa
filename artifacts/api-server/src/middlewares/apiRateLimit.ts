import type { Request, RequestHandler } from "express";
import { sql } from "drizzle-orm";
import IORedis, { type Redis } from "ioredis";
import { db } from "../lib/db";
import { newSafeId } from "../lib/ids";
import { logger } from "../lib/logger";
import { getUserId } from "../lib/auth";
import { userHasAnyRole } from "../lib/roles";
import { captureException, captureMessage } from "../lib/sentry";

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
  readonly kind: "memory" | "redis";
  bump(key: string, now: number, windowMs: number, max: number): Promise<BumpResult>;
}

/**
 * Watches RedisStore failure log keys and forwards them to Sentry so the
 * "degrade open" branch never goes unnoticed. Two signals are emitted:
 *
 *   1. Per-failure `captureException` with `tags.kind` set to one of the
 *      log keys ("rate_limit_redis_bump_failed" or
 *      "rate_limit_redis_client_error"). A Sentry alert rule keyed off
 *      `tags.subsystem == "rate_limit"` can fire above any chosen
 *      events-per-minute threshold.
 *   2. An in-process sliding-minute counter that, when it crosses
 *      `RATE_LIMIT_REDIS_FAILURE_ALERT_PER_MIN` (default 5), emits a
 *      `level: "fatal"` `captureMessage` with a stable fingerprint.
 *      Sentry's default new-issue notification fires on the first such
 *      event so we get an alert even when no project-specific rule has
 *      been configured. The breach is throttled to one event per
 *      `RATE_LIMIT_REDIS_FAILURE_ALERT_COOLDOWN_MS` (default 60s) to
 *      avoid spamming on-call during a sustained outage.
 */
class RedisFailureWatcher {
  // Breach detection state — rate-based, untouched by recordSuccess so a
  // partial outage where Redis flaps still trips the alert when the
  // failure rate over the rolling 60s window crosses threshold.
  private timestamps: number[] = [];
  private lastBreachAt = 0;
  // Recovery-incident state — describes the current "streak" between the
  // last clean state and the next success. Reset on every recordSuccess
  // independently of the breach detector above.
  //   firstFailureAt          — when this streak began (for durationMs)
  //   failuresSinceFirstFailure — how many failures it spans (for failureCount)
  //   breachedThisIncident    — gates whether we actually emit recovery
  //                             on the next success (avoid noise for blips)
  private firstFailureAt: number | null = null;
  private failuresSinceFirstFailure = 0;
  private breachedThisIncident = false;
  readonly thresholdPerMin: number;
  readonly cooldownMs: number;

  constructor(opts?: { threshold?: number; cooldownMs?: number }) {
    this.thresholdPerMin =
      opts?.threshold ??
      Number(process.env.RATE_LIMIT_REDIS_FAILURE_ALERT_PER_MIN ?? "5");
    this.cooldownMs =
      opts?.cooldownMs ??
      Number(process.env.RATE_LIMIT_REDIS_FAILURE_ALERT_COOLDOWN_MS ?? "60000");
  }

  record(
    kind: "rate_limit_redis_bump_failed" | "rate_limit_redis_client_error",
    err: unknown,
    now: number = Date.now(),
  ): void {
    captureException(err, {
      tags: { subsystem: "rate_limit", kind },
      level: "error",
    });
    if (this.firstFailureAt === null) {
      this.firstFailureAt = now;
      this.failuresSinceFirstFailure = 0;
    }
    this.failuresSinceFirstFailure += 1;
    const cutoff = now - 60_000;
    this.timestamps.push(now);
    while (this.timestamps.length > 0 && this.timestamps[0]! <= cutoff) {
      this.timestamps.shift();
    }
    if (
      this.timestamps.length >= this.thresholdPerMin &&
      now - this.lastBreachAt >= this.cooldownMs
    ) {
      this.lastBreachAt = now;
      this.breachedThisIncident = true;
      logger.error(
        { count: this.timestamps.length, threshold: this.thresholdPerMin },
        "rate_limit_redis_failure_threshold_breached",
      );
      captureMessage("rate_limit_redis_failure_threshold_breached", {
        level: "fatal",
        tags: {
          subsystem: "rate_limit",
          alert: "rate_limit_store_degraded",
        },
        extra: {
          count: this.timestamps.length,
          threshold: this.thresholdPerMin,
          windowSeconds: 60,
        },
        // Stable fingerprint so all breaches roll up into a single Sentry
        // issue instead of one issue per cooldown tick.
        fingerprint: ["rate-limit-redis-failure-threshold"],
      });
    }
  }

  /**
   * Called by `RedisStore.bump` after a successful Lua roundtrip. If we
   * previously crossed the degraded-alert threshold (i.e. on-call was
   * paged with `rate_limit_store_degraded`), emit a paired
   * `rate_limit_store_recovered` signal so the incident timeline closes
   * itself instead of relying on Sentry's auto-resolve / a manual
   * `/healthz` poke.
   *
   * Recovery only fires for incidents we actually paged on. Sub-threshold
   * blips reset the streak silently — emitting a "recovered" event for
   * a degradation the team never saw would be pure noise.
   */
  recordSuccess(now: number = Date.now()): void {
    const hadBreach = this.breachedThisIncident;
    const startedAt = this.firstFailureAt;
    const failureCount = this.failuresSinceFirstFailure;
    // Reset recovery-incident state up front so a misbehaving Sentry
    // transport can't leave us pinned in a degraded state. Note we do
    // NOT touch `timestamps` or `lastBreachAt` here — those belong to
    // the rate-based breach detector and must keep their rolling-minute
    // semantics across partial outages where Redis flaps. See class doc.
    this.firstFailureAt = null;
    this.failuresSinceFirstFailure = 0;
    this.breachedThisIncident = false;
    if (!hadBreach || startedAt === null) return;
    // Recovery is the true close of an alert window: drop the cooldown
    // gate so a fresh outage right after recovery can re-page on-call
    // instead of being silenced by leftover within-incident throttling.
    this.lastBreachAt = 0;
    const durationMs = Math.max(0, now - startedAt);
    logger.info(
      { durationMs, failureCount },
      "rate_limit_redis_recovered",
    );
    captureMessage("rate_limit_redis_recovered", {
      level: "info",
      tags: {
        subsystem: "rate_limit",
        alert: "rate_limit_store_recovered",
      },
      extra: {
        durationMs,
        failureCount,
      },
      // Pair with the breach fingerprint so dashboards can correlate
      // degraded↔recovered transitions for the same logical incident.
      fingerprint: ["rate-limit-redis-recovered"],
    });
  }

  /** Test-only: reset internal counters between cases. */
  __reset(): void {
    this.timestamps = [];
    this.lastBreachAt = 0;
    this.firstFailureAt = null;
    this.failuresSinceFirstFailure = 0;
    this.breachedThisIncident = false;
  }
}

const redisFailureWatcher = new RedisFailureWatcher();

interface Bucket {
  hits: number[];
}

class InMemoryStore implements BucketStore {
  readonly kind = "memory" as const;
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
  readonly kind = "redis" as const;
  private readonly redis: RateLimitRedis;
  private memberSeq = 0;
  constructor(redis: Redis) {
    redis.defineCommand("rateLimitBump", {
      numberOfKeys: 1,
      lua: RATE_LIMIT_LUA,
    });
    this.redis = redis as RateLimitRedis;
  }
  /**
   * Issues a `PING` against the underlying Redis client with a hard
   * timeout. Used by the `/readyz` probe so the load balancer can drain
   * a replica whose backing Redis is unreachable instead of letting it
   * keep degrading-open silently. We don't reuse `enableReadyCheck`
   * here because that only fires once at connect time — we want a live
   * round-trip per probe call.
   */
  async ping(timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.redis.ping(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`redis_ping_timeout_after_${timeoutMs}ms`)),
            timeoutMs,
          );
          timer.unref?.();
        }),
      ]);
      if (result !== "PONG") {
        throw new Error(`unexpected_ping_response:${String(result)}`);
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
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
      // Notify the failure watcher that Redis is healthy again. The
      // watcher only emits a recovery signal when the prior streak
      // actually crossed the degraded-alert threshold, so the common
      // happy path is an O(1) bookkeeping reset.
      redisFailureWatcher.recordSuccess(now);
      return {
        allowed: Number(allowed) === 1,
        retryAfterMs: Number(retryAfter),
      };
    } catch (err) {
      // Degrade open if Redis is unreachable — better to serve than to
      // 429 every request because of a backing-store outage. The error
      // is logged AND forwarded to Sentry (see RedisFailureWatcher) so
      // on-call notices instead of the rate limiter silently disabling
      // itself.
      logger.error(
        { err: (err as Error).message },
        "rate_limit_redis_bump_failed",
      );
      // Thread the bump's `now` so the watcher's first-failure timestamp
      // and the eventual recovery `durationMs` share a clock — important
      // for tests that drive synthetic time, and harmless in production
      // where `now` is always Date.now().
      redisFailureWatcher.record("rate_limit_redis_bump_failed", err, now);
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
      redisFailureWatcher.record("rate_limit_redis_client_error", err);
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

/**
 * Returns the configured bucket store kind ("memory" | "redis"). Exposed
 * via /healthz so operators can verify a running replica is using the
 * intended backend without grepping env vars on the host.
 */
export function getRateLimitStoreKind(): "memory" | "redis" {
  return store.kind;
}

/**
 * Lightweight Redis liveness probe used by `/readyz`. Returns:
 *   - `null` when the rate-limit store is in-memory (no Redis to probe).
 *   - `{ ok: true }` when a `PING` round-trips successfully.
 *   - `{ ok: false, error }` when the ping fails or times out — the
 *     readyz handler surfaces this so on-call can debug without shell.
 *
 * The default timeout is intentionally short (2s) because readiness
 * probes are called frequently by the platform load balancer. Override
 * via `READYZ_REDIS_TIMEOUT_MS` if your network has higher RTT. The
 * env var is sanitised: a missing, non-numeric, zero, or negative
 * value falls back to the 2000ms default rather than producing a NaN
 * timer (which would fire immediately and break every probe).
 */
function readyzRedisTimeoutMs(): number {
  const raw = process.env.READYZ_REDIS_TIMEOUT_MS;
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 2000;
}

export async function pingRateLimitRedis(
  timeoutMs: number = readyzRedisTimeoutMs(),
): Promise<{ ok: true } | { ok: false; error: string } | null> {
  if (!(store instanceof RedisStore)) return null;
  try {
    await store.ping(timeoutMs);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export const __test__ = {
  resolveTier,
  store,
  InMemoryStore,
  RedisStore,
  RedisFailureWatcher,
  redisFailureWatcher,
};
