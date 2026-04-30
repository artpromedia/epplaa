import type { Request, Response, NextFunction, RequestHandler } from "express";
import { logger } from "../lib/logger";
import { bumpRateLimitBucket } from "./apiRateLimit";

/**
 * Lightweight IP-keyed rate limiter for high-cost public endpoints
 * (e.g. OTP send, which incurs SMS/WhatsApp provider charges per call).
 *
 * Per-phone throttling alone is not enough: an attacker can rotate
 * phone numbers to drain provider credit. We layer an IP/device-level
 * bucket on top so a single source has a hard ceiling regardless of
 * phone variation.
 *
 * Backing store:
 *   This middleware delegates to the SHARED rate-limit bucket store
 *   exported by `apiRateLimit.bumpRateLimitBucket`. That store is the
 *   atomic Redis Lua sliding-window log when `RATE_LIMIT_STORE=redis`
 *   is set (production), and falls back to the same in-process
 *   `InMemoryStore` instance the api limiter uses in dev /
 *   single-replica deploys.
 *
 *   Sharing matters for multi-replica deploys: before this swap (task
 *   #33) `ipRateLimit` owned its own per-process `Map`, so an attacker
 *   spreading OTP-send traffic across N api-server replicas would see
 *   the effective per-IP cap multiplied by N. With Redis as the shared
 *   counter store every replica reads / writes the same sliding-window
 *   log, so the cap holds at the configured value regardless of
 *   replica count. Cross-replica behaviour is now identical to a
 *   single-replica deploy. See `docs/runbooks/rate-limit-store.md`.
 *
 *   Degrade posture is inherited from the shared store: a Redis outage
 *   degrades open (allow the request) and pages on-call via the
 *   `RedisFailureWatcher` rather than 429ing legitimate traffic.
 *
 *   `x-forwarded-for` is honoured ONLY when `IP_RATE_LIMIT_TRUST_PROXY=1`
 *   to avoid spoofing on direct deployments. Replit's proxy is trusted
 *   infra so we enable it in prod via env.
 */

function clientIp(req: Request): string {
  if (process.env.IP_RATE_LIMIT_TRUST_PROXY === "1") {
    const xff = req.headers["x-forwarded-for"];
    const first = Array.isArray(xff) ? xff[0] : xff?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

export interface IpRateLimitOptions {
  /** Logical name used in error responses + bucket key. */
  name: string;
  /** Window length in ms. */
  windowMs: number;
  /** Max requests per window. */
  max: number;
}

export function ipRateLimit(opts: IpRateLimitOptions): RequestHandler {
  const { name, windowMs, max } = opts;
  return (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const ip = clientIp(req);
      // Namespace the bucket key with `iprl:` so it cannot collide
      // with the `apiRateLimit` keys (which are
      // `${name}:${tier}:${routeKey}:${identity}`). Without the
      // namespace prefix an `apiRateLimit` mount with the literal name
      // `"otp_start"` and tier `"anon"` could share a key with this
      // middleware on a coincidence — the `iprl:` guard makes that
      // impossible by construction.
      const key = `iprl:${name}:${ip}`;
      const result = await bumpRateLimitBucket(key, windowMs, max);
      if (!result.allowed) {
        res.setHeader(
          "Retry-After",
          Math.ceil(Math.max(result.retryAfterMs, 1000) / 1000),
        );
        res.status(429).json({
          error: "rate_limited",
          detail:
            "Too many requests from this network. Try again later.",
        });
        return;
      }
      next();
    })().catch((err) => {
      // Same posture as `apiRateLimit`: a bug in the rate-limit path
      // must not 5xx legitimate traffic. The shared bucket store
      // already degrades open on a Redis outage and pages on-call via
      // the failure watcher; this catch is for unexpected throws
      // (e.g. reading req.headers crashed) so they don't bubble out
      // as a 500.
      logger.error(
        { err: (err as Error).message, name },
        "ip_rate_limit_unhandled",
      );
      next();
    });
  };
}
