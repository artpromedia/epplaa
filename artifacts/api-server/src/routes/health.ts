import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db } from "../lib/db";
import { logger } from "../lib/logger";
import {
  getProductionHostnamePatternStatus,
  getRehearsalInjectorEnabledStatus,
  getSentryDsnStatus,
  getStubFulfillmentEnabledStatus,
  type ProductionHostnamePatternStatus,
  type RehearsalInjectorEnabledStatus,
  type SentryDsnStatus,
  type StubFulfillmentEnabledStatus,
} from "../lib/productionSignals";
import {
  auditHealthWatcher,
  dbHealthWatcher,
  getPaymentGatewaySubsystemSnapshots,
  type SubsystemSnapshot,
} from "../lib/subsystemHealth";
import {
  getRateLimitStoreKind,
  getRateLimitStoreReadyzStatus,
  getRateLimitStoreStatus,
  pingRateLimitRedis,
  type RateLimitStoreReadyzStatus,
} from "../middlewares/apiRateLimit";
import {
  getDependencyProbeConfigBlock,
  pingDependency,
  type DependencyProbeConfigBlock,
  type DependencyProbeName,
} from "../lib/dependencyProbes";

const router: IRouter = Router();

// Per-process identifier surfaced on /healthz + /readyz so callers
// (admin status panel, curl loops) can group probes by replica.
const REPLICA_ID: string =
  process.env.HOSTNAME && process.env.HOSTNAME.trim() !== ""
    ? process.env.HOSTNAME
    : `pid:${process.pid}`;

export function getReplicaId(): string {
  return REPLICA_ID;
}

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
  // `auditChain` mirrors the recordAudit success/failure streak. A
  // sustained DB-pressure outage that swallows audit writes (the path
  // that's intentionally best-effort so user requests don't fail) now
  // surfaces here within seconds and pages on-call via the duration
  // alert once it stays degraded longer than the configured threshold.
  const auditStatus: SubsystemSnapshot = auditHealthWatcher.getSnapshot();
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
    auditChain: auditStatus,
    // One entry per real, configured payment gateway (e.g.
    // `paymentGatewayPaystack`, `paymentGatewayFlutterwave`). Driven
    // by the same gateway success/failure stream that powers the
    // in-DB circuit-breaker counters in `gateway_health`. Per-gateway
    // (rather than a single combined `paymentGateway` entry) so the
    // duration alert pages on a stuck Paystack even while Flutterwave
    // continues to absorb failover traffic — see the comment block on
    // `paymentGatewayWatchers` in lib/subsystemHealth.ts. When no
    // real gateway is configured (dev-mock fallback), no entries are
    // exposed; the matching `payment_provider_missing_for_production`
    // boot warning is what surfaces that misconfiguration.
    ...getPaymentGatewaySubsystemSnapshots(),
  };
  res.json({
    status: "ok",
    replicaId: REPLICA_ID,
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
 * Build the boot-time-config block surfaced on `/readyz`.
 *
 * This block is informational only — it does NOT contribute to the
 * ready/not_ready decision. The motivating misconfiguration (task #89)
 * is `PRODUCTION_HOSTNAME_PATTERN` being unset on a production-shaped
 * deploy, which silently disables the hostname backstop in
 * `assertRehearsalKillSwitchSafe` but does not break a single request:
 * the existing layered defences (runtime 404 on the rehearsal route,
 * rehearsal-token guard, kill-switch boot guard via the other
 * production signals) still keep the injector inaccessible. Failing
 * `/readyz` would drain the replica out of rotation for a
 * configuration warning, which is more disruptive than the marginal
 * security gain — exactly the trade-off the boot-time check
 * `assertProductionHostnamePatternConfigured` already chose to log a
 * warning rather than crash-loop.
 *
 * Instead, we surface the status here so an external probe (see
 * `scripts/checkReadyzConfig.ts`, the generalised successor to
 * `scripts/checkProductionHostnamePattern.ts`) can poll the deploy
 * post-deploy / on a schedule and page on-call when any operator-
 * configurable boot-time setting is in a dangerous state. The probe
 * runs out-of-band of normal request handling so a paged warning
 * never affects user traffic, while making misconfigurations visible
 * within minutes of the next deploy.
 *
 * Task #101 generalised the block from a single `productionHostnamePattern`
 * field to the full set of high-risk boot-time settings (rehearsal
 * injector, stub fulfillment, rate-limit store, Sentry DSN). Most of
 * these have a boot-time guard that already crash-loops on the
 * dangerous combination — the readyz surface adds the runtime probe
 * so a hot env-var rotation, a platform-side env-var change without
 * restart, or a deploy that skipped the boot guard (e.g. emergency
 * rollback via the platform UI) is still caught. See the runbook
 * (`docs/runbooks/staging-only-endpoints.md`) for the per-setting
 * status semantics + which paging vs. informational.
 *
 * Each field is a tri-state status — see the helper TS docs for the
 * exact value semantics. Critically, every field defaults to a
 * non-paging value on a clean dev/staging env so the probe stays
 * silent unless something is actually wrong.
 *
 * Pure helper — reads `process.env` at call time (so a hot-reloaded
 * env var is picked up by the next probe) and returns a structured
 * shape rather than serialising directly so it can be unit-tested
 * without spinning up an Express app. The `currentRateLimitStoreKind`
 * parameter is injected so tests can drive every branch of the
 * rate-limit-store status without poisoning module state; in
 * production it defaults to `getRateLimitStoreKind()` so callers don't
 * have to thread the runtime kind through every probe.
 */
export interface ReadyzConfigBlock {
  productionHostnamePattern: ProductionHostnamePatternStatus;
  rehearsalInjectorEnabled: RehearsalInjectorEnabledStatus;
  stubFulfillmentEnabled: StubFulfillmentEnabledStatus;
  rateLimitStore: RateLimitStoreReadyzStatus;
  sentryDsn: SentryDsnStatus;
  /**
   * Per-dependency probe configuration (Clerk, Paystack, Flutterwave).
   * Each entry surfaces `{ enabled, url, timeoutMs }` so an external
   * dashboard can confirm at a glance which optional probes are wired
   * on a given replica without grepping env vars on the box. The
   * actual probe results are reported under the top-level `checks` /
   * `failures` maps; this block is purely the **config** side, and
   * — like `productionHostnamePattern` — does not influence the
   * ready/not_ready decision.
   */
  dependencyProbes: DependencyProbeConfigBlock;
}

export function getReadyzConfigBlock(
  env: NodeJS.ProcessEnv = process.env,
  currentRateLimitStoreKind: "memory" | "redis" = getRateLimitStoreKind(),
): ReadyzConfigBlock {
  return {
    productionHostnamePattern: getProductionHostnamePatternStatus(env),
    rehearsalInjectorEnabled: getRehearsalInjectorEnabledStatus(env),
    stubFulfillmentEnabled: getStubFulfillmentEnabledStatus(env),
    rateLimitStore: getRateLimitStoreReadyzStatus(
      currentRateLimitStoreKind,
      env,
    ),
    sentryDsn: getSentryDsnStatus(env),
    dependencyProbes: getDependencyProbeConfigBlock(env),
  };
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
 * The response body also carries a `config` block (see
 * `getReadyzConfigBlock`) that surfaces operator-set boot-time
 * configuration whose dangerous combinations on production don't
 * justify failing readyz — `productionHostnamePattern` (task #89),
 * plus `rehearsalInjectorEnabled`, `stubFulfillmentEnabled`,
 * `rateLimitStore`, and `sentryDsn` (task #101). External probes
 * consume this block to page on-call out of band; readiness itself
 * is unaffected.
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
 * We deliberately do NOT touch the audit chain or Sentry here —
 * readiness is "can this replica serve a request at all", not "is
 * every downstream healthy". Coupling readyz to flaky third parties
 * would cause cascading drains.
 *
 * Optional per-dependency probes (Clerk, Paystack, Flutterwave) ARE
 * supported but default OFF. They are gated behind explicit opt-in
 * env flags (`READYZ_PROBE_<NAME>=1`) precisely so an operator must
 * acknowledge the cascading-drain risk before enabling one. When a
 * probe is disabled it reports `<name>: "skipped"` and never
 * contributes to the 503 decision. See
 * `docs/runbooks/readyz-dependency-probes.md` for the in-incident
 * disable path and tuning guidance.
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

    // Optional per-dependency probes (task #91). Disabled by default;
    // each is opt-in via `READYZ_PROBE_<NAME>=1`. We run them in
    // parallel because they're independent network calls and the
    // platform LB cadence is tight — serialising would compound their
    // worst-case wait. The result map keeps each probe's response
    // under its own `checks.<name>` / `failures.<name>` key so the
    // shape stays uniform with `db` and `redis` above and external
    // dashboards don't need per-probe parsing branches.
    //
    // To disable a flaky probe during an incident, flip its env flag
    // to anything other than `"1"` (typically `"0"`) and the next
    // probe will report `<name>: "skipped"` instead of failing
    // readyz. See `docs/runbooks/readyz-dependency-probes.md`.
    const probeNames: DependencyProbeName[] = [
      "clerk",
      "paystack",
      "flutterwave",
    ];
    const probeResults = await Promise.all(
      probeNames.map(async (name) => ({
        name,
        result: await pingDependency(name),
      })),
    );
    for (const { name, result } of probeResults) {
      if (result === null) {
        checks[name] = "skipped";
      } else if (result.ok) {
        checks[name] = "ok";
      } else {
        checks[name] = "failed";
        failures[name] = result.error;
      }
    }

    const config = getReadyzConfigBlock();

    const ready = Object.keys(failures).length === 0;
    if (!ready) {
      logger.warn(
        { checks, failures },
        "readyz_unhealthy",
      );
      res.status(503).json({
        status: "not_ready",
        replicaId: REPLICA_ID,
        checks,
        failures,
        rateLimitStore: getRateLimitStoreKind(),
        config,
      });
      return;
    }
    res.json({
      status: "ready",
      replicaId: REPLICA_ID,
      checks,
      rateLimitStore: getRateLimitStoreKind(),
      config,
    });
  })().catch((err) => {
    // Belt-and-braces: any unexpected throw still fails closed so the
    // load balancer drains us instead of routing into a broken replica.
    logger.error({ err: (err as Error).message }, "readyz_unhandled");
    res.status(503).json({
      status: "not_ready",
      replicaId: REPLICA_ID,
      checks: {},
      failures: { unhandled: (err as Error).message },
    });
  });
});

export default router;
