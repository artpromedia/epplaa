import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db } from "../lib/db";
import { logger } from "../lib/logger";
import { dbHealthWatcher, type SubsystemSnapshot } from "../lib/subsystemHealth";
import {
  getRateLimitStoreKind,
  getRateLimitStoreStatus,
  pingRateLimitRedis,
} from "../middlewares/apiRateLimit";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  // Liveness probe — intentionally cheap and always-200 so the platform
  // doesn't kill replicas during transient backing-store blips. Use
  // `/readyz` for the dependency-aware probe that drains a replica
  // out of rotation when DB or Redis is unreachable.
  //
  // The response now exposes a `subsystems` map so the duration-based
  // stuck-degraded probe (scripts/checkHealthzDegraded.ts) can iterate
  // over every backing service that tracks a failure streak — not just
  // the rate-limit store. Each entry has the same `{ state,
  // firstFailureAt, ... }` shape so dashboards and probes can parse a
  // uniform schema.
  //
  // The legacy top-level `rateLimitStore` field is preserved (and
  // mirrors `subsystems.rateLimitStore` plus its `kind`) for back-compat
  // with the previous probe + dashboards. Removing it would silently
  // break older callers; the duplication is cheap.
  const rateLimitStatus = getRateLimitStoreStatus();
  const dbStatus: SubsystemSnapshot = dbHealthWatcher.getSnapshot();
  const subsystems: Record<string, SubsystemSnapshot> = {
    // Strip `kind` from the rate-limit snapshot so every subsystem
    // entry has an identical shape — `kind` stays on the top-level
    // legacy field for callers that need it.
    rateLimitStore: {
      state: rateLimitStatus.state,
      failureCount: rateLimitStatus.failureCount,
      firstFailureAt: rateLimitStatus.firstFailureAt,
      lastRecoveredAt: rateLimitStatus.lastRecoveredAt,
    },
    db: dbStatus,
  };
  res.json({
    status: "ok",
    rateLimitStore: rateLimitStatus,
    subsystems,
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
 * The DB check also feeds `dbHealthWatcher`: every probe records either
 * success or failure, which is what gives /healthz the
 * `subsystems.db.firstFailureAt` streak that the duration alert reads.
 * The platform LB hits /readyz on an O(seconds) cadence so the
 * watcher's resolution is plenty for a "stuck for minutes" alert. We
 * do not also wire per-request DB errors into the watcher: that would
 * conflate "this one statement failed" with "the pool is unreachable",
 * and the probe is meant to surface the latter.
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
      dbHealthWatcher.recordSuccess();
    } catch (err) {
      checks.db = "failed";
      failures.db = (err as Error).message;
      dbHealthWatcher.record();
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
