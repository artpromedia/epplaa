import type { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * Lightweight in-memory IP rate limiter for high-cost public endpoints
 * (e.g. OTP send, which incurs SMS/WhatsApp provider charges per call).
 *
 * Per-phone throttling alone is not enough: an attacker can rotate phone
 * numbers to drain provider credit. We layer an IP/device-level bucket on
 * top so a single source has a hard ceiling regardless of phone variation.
 *
 * Implementation notes:
 *  - Sliding window via a list of recent timestamps per key.
 *  - Map is bounded by sweeping entries whose oldest hit is older than the
 *    window; a periodic timer also runs a full sweep to bound memory under
 *    sustained low-cardinality traffic.
 *  - Multi-instance deployments will get per-instance limits (so the real
 *    aggregate cap is roughly windowMax * replicas). For Epplaa's current
 *    single-process API server this is exact; for horizontal scale-out a
 *    Redis-backed limiter would be a future swap-in behind this same API.
 *  - We honor x-forwarded-for ONLY if IP_RATE_LIMIT_TRUST_PROXY=1 to avoid
 *    spoofing on direct deployments. Replit's proxy is trusted infra so we
 *    enable it in prod via env.
 */

interface Bucket {
  hits: number[];
}

const buckets = new Map<string, Bucket>();

function clientIp(req: Request): string {
  if (process.env.IP_RATE_LIMIT_TRUST_PROXY === "1") {
    const xff = req.headers["x-forwarded-for"];
    const first = Array.isArray(xff) ? xff[0] : xff?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

export interface IpRateLimitOptions {
  /** Logical name used in error responses + sweeper logs. */
  name: string;
  /** Window length in ms. */
  windowMs: number;
  /** Max requests per window. */
  max: number;
}

export function ipRateLimit(opts: IpRateLimitOptions): RequestHandler {
  const { name, windowMs, max } = opts;
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = clientIp(req);
    const key = `${name}:${ip}`;
    const now = Date.now();
    const cutoff = now - windowMs;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { hits: [] };
      buckets.set(key, bucket);
    }
    // Drop expired hits in-place.
    bucket.hits = bucket.hits.filter((t) => t > cutoff);
    if (bucket.hits.length >= max) {
      const retryAfterMs = bucket.hits[0]! + windowMs - now;
      res.setHeader("Retry-After", Math.ceil(Math.max(retryAfterMs, 1000) / 1000));
      res
        .status(429)
        .json({ error: "rate_limited", detail: "Too many requests from this network. Try again later." });
      return;
    }
    bucket.hits.push(now);
    next();
  };
}

// Background sweeper: drops buckets whose newest hit is older than 10 min so
// the map can't grow unbounded under churn (e.g. NAT rotation).
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const STALE_AFTER_MS = 10 * 60 * 1000;
if (process.env.NODE_ENV !== "test") {
  setInterval(() => {
    const cutoff = Date.now() - STALE_AFTER_MS;
    for (const [key, bucket] of buckets) {
      const newest = bucket.hits[bucket.hits.length - 1] ?? 0;
      if (newest < cutoff) buckets.delete(key);
    }
  }, SWEEP_INTERVAL_MS).unref?.();
}
