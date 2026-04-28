import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db } from "../lib/db";
import { logger } from "../lib/logger";
import {
  getRateLimitStoreKind,
  pingRateLimitRedis,
} from "../middlewares/apiRateLimit";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  // Liveness probe — intentionally cheap and always-200 so the platform
  // doesn't kill replicas during transient backing-store blips. Use
  // `/readyz` for the dependency-aware probe that drains a replica
  // out of rotation when DB or Redis is unreachable.
  //
  // `rateLimitStore` lets ops verify a live replica is using the intended
  // bucket backend (see docs/runbooks/rate-limit-store.md). It's a tiny,
  // non-sensitive string so we expose it on the unauthenticated endpoint
  // rather than gating it behind admin auth.
  res.json({
    status: "ok",
    rateLimitStore: getRateLimitStoreKind(),
  });
});

/**
 * Per-dependency timeout for `/readyz`. Kept short because the load
 * balancer calls this on a tight cadence — a slow probe would itself
 * take a replica out of rotation. Override via `READYZ_DB_TIMEOUT_MS`
 * if your DB has unusually high RTT.
 *
 * The env var is sanitised: a missing, non-numeric, zero, or negative
 * value falls back to the 2000ms default rather than producing a NaN
 * timer (which would fire immediately and turn every probe into a
 * 503). We accept any finite positive integer.
 */
function parseTimeoutMs(raw: string | undefined, fallbackMs: number): number {
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallbackMs;
}
const READYZ_DB_TIMEOUT_MS = parseTimeoutMs(process.env.READYZ_DB_TIMEOUT_MS, 2000);

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label}_timeout_after_${ms}ms`)),
      ms,
    );
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/**
 * Readiness probe — returns 200 only when every backing dependency a
 * replica needs to serve traffic is reachable. Returns 503 with a JSON
 * body listing which dependency failed so the platform load balancer
 * can drain the replica AND on-call can debug without container shell
 * access.
 *
 * Checks (in order):
 *   - DB: `SELECT 1` via the shared drizzle pool. Always run.
 *   - Redis: `PING` against the rate-limit store, BUT only when the
 *     replica is actually configured for redis (`RATE_LIMIT_STORE=redis`).
 *     A memory-store replica reports `redis: "skipped"` and stays ready.
 *
 * We deliberately do NOT touch the audit chain, Sentry, or external
 * payment gateways here — readiness is "can this replica serve a
 * request at all", not "is every downstream healthy". Coupling readyz
 * to flaky third parties would cause cascading drains.
 */
router.get("/readyz", (_req, res) => {
  void (async () => {
    const checks: Record<string, "ok" | "failed" | "skipped"> = {};
    const failures: Record<string, string> = {};

    try {
      await withTimeout(db.execute(sql`SELECT 1`), READYZ_DB_TIMEOUT_MS, "db");
      checks.db = "ok";
    } catch (err) {
      checks.db = "failed";
      failures.db = (err as Error).message;
    }

    const redisResult = await pingRateLimitRedis();
    if (redisResult === null) {
      checks.redis = "skipped";
    } else if (redisResult.ok) {
      checks.redis = "ok";
    } else {
      checks.redis = "failed";
      failures.redis = redisResult.error;
    }

    const ready = Object.keys(failures).length === 0;
    if (!ready) {
      logger.warn(
        { checks, failures },
        "readyz_unhealthy",
      );
      res.status(503).json({
        status: "not_ready",
        checks,
        failures,
        rateLimitStore: getRateLimitStoreKind(),
      });
      return;
    }
    res.json({
      status: "ready",
      checks,
      rateLimitStore: getRateLimitStoreKind(),
    });
  })().catch((err) => {
    // Belt-and-braces: any unexpected throw still fails closed so the
    // load balancer drains us instead of routing into a broken replica.
    logger.error({ err: (err as Error).message }, "readyz_unhandled");
    res.status(503).json({
      status: "not_ready",
      checks: {},
      failures: { unhandled: (err as Error).message },
    });
  });
});

export default router;
