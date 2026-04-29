import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { logger } from "../lib/logger";
import {
  detectNonHostnameProductionSignals,
  detectProductionSignals,
} from "../lib/productionSignals";
import { auditHealthWatcher, dbHealthWatcher } from "../lib/subsystemHealth";
import { __getRedisFailureWatcherForRehearsal } from "../middlewares/apiRateLimit";

/**
 * Healthz rehearsal route — staging-only injector for the
 * stuck-degraded duration alert.
 *
 * Why this exists (see docs/runbooks/rate-limit-store.md Step 5):
 * Task #56 wired the `checkHealthzDegraded` probe into a GitHub
 * Actions cron that pages on-call via Sentry when /healthz reports a
 * subsystem stuck in `degraded` for too long. The runbook documented
 * a manual dry-run procedure but nothing in CI actually exercises the
 * end-to-end pager path. Until the first real outage we can't
 * actually know whether:
 *
 *   - Sentry's "new fatal-level issue" rule still pages on-call for
 *     events with the alert tags,
 *   - The fingerprint really collapses N iterations into one issue,
 *   - The probe's JSON line survives Sentry's PII scrubber and is
 *     readable in the page body,
 *   - The GitHub-failure notification still reaches the right channel
 *     when the Sentry forwarder is misconfigured.
 *
 * The rehearsal workflow (`.github/workflows/rehearse-healthz-degraded.yml`)
 * runs weekly against staging and uses these endpoints to inject a
 * synthetic `degraded` streak with a `firstFailureAt` older than the
 * threshold, runs the probe, asserts the expected Sentry event, and
 * then clears the streak so staging is left healthy.
 *
 * Endpoints (mounted at `/api/_rehearsal/*`):
 *
 *   POST /_rehearsal/inject-stuck-degraded
 *     body: { subsystem: "rateLimitStore" | "db" | "auditChain",
 *             firstFailureAt: number (ms epoch),
 *             failureCount?: number (default 1) }
 *
 *   POST /_rehearsal/clear-stuck-degraded
 *     body: { subsystem: "rateLimitStore" | "db" | "auditChain" }
 *
 * Both endpoints return 404 unless `HEALTHZ_REHEARSAL_ENABLED=1`, so
 * the route is invisible in production. When enabled they additionally
 * require an `X-Rehearsal-Token` header that timing-safely matches
 * `HEALTHZ_REHEARSAL_TOKEN` so that even if a staging URL leaks, the
 * endpoint can't be abused to induce false pages on the real on-call
 * channel. A 401 is returned when the token is missing or wrong.
 */

type SubsystemName = "rateLimitStore" | "db" | "auditChain";

const ALLOWED_SUBSYSTEMS: readonly SubsystemName[] = [
  "rateLimitStore",
  "db",
  "auditChain",
];

interface RehearsalGuardConfig {
  enabled: boolean;
  token: string | null;
}

/**
 * Read the guard config from process.env on every request rather than
 * caching at module load. The rehearsal endpoint is exercised so
 * infrequently (weekly cron) that the cost is negligible, and re-
 * reading lets a staging operator flip the kill switch without a
 * deploy if the rehearsal ever misbehaves.
 */
function readGuardConfig(): RehearsalGuardConfig {
  return {
    enabled: process.env.HEALTHZ_REHEARSAL_ENABLED === "1",
    token: process.env.HEALTHZ_REHEARSAL_TOKEN ?? null,
  };
}

/**
 * Boot-time defense-in-depth guard. The runtime gate above (404 unless
 * HEALTHZ_REHEARSAL_ENABLED=1) plus the human runbook ("enable on
 * staging only — never production") is a *process* control: it relies
 * on operators not copy-pasting the staging env file into a production
 * deploy. That has gone wrong before in other systems, and the cost of
 * the failure is high — a successful inject from a leaked production
 * URL would page real on-call with a synthetic outage and erode trust
 * in the alerting channel.
 *
 * To turn that into a *technical* control we additionally fail-fast at
 * boot: if `HEALTHZ_REHEARSAL_ENABLED=1` is observed alongside *any*
 * production-only signal, the process refuses to start and logs a
 * clear error instructing the operator to unset the kill switch.
 *
 * Production signals (any one of these is sufficient to trip the guard
 * when the kill switch is on):
 *   1. `NODE_ENV=production` — the original signal.
 *   2. `HOSTNAME` matches the regex in `PRODUCTION_HOSTNAME_PATTERN`
 *      — operator-configured pattern that names known production
 *      hostnames. Backstops a deploy that runs with `NODE_ENV=staging`
 *      (or unset) but is reachable as the real production host.
 *   3. `REPLIT_DEPLOYMENT=1` — set by the Replit platform on
 *      production deployments (vs. dev workspaces).
 *   4. `DEPLOYMENT_ENVIRONMENT=production` — generic deployment-env
 *      env var some platforms / IaC stacks set independently of
 *      `NODE_ENV`.
 *
 * Staging hosts (no production signal) continue to opt in normally.
 *
 * This is intentionally checked before the HTTP listener binds so a
 * misconfigured deploy crash-loops loudly in the platform health
 * checks rather than silently exposing the injector.
 *
 * Pure function — takes `env` and a `log` sink so the unit test can
 * exercise both the staging-allowed and production-rejected paths
 * without poisoning `process.env` or piping pino output. Returns the
 * outcome instead of calling `process.exit` so the caller (and the
 * test) controls termination.
 */
export type RehearsalBootGuardOutcome =
  | { ok: true }
  | { ok: false; reason: string };

export function assertRehearsalKillSwitchSafe(
  env: NodeJS.ProcessEnv,
  log: { error: (obj: unknown, msg: string) => void },
): RehearsalBootGuardOutcome {
  const enabled = env.HEALTHZ_REHEARSAL_ENABLED === "1";
  if (!enabled) return { ok: true };

  const signals = detectProductionSignals(env, log);
  if (signals.length === 0) return { ok: true };

  const signalDetails = signals.map((s) => s.detail).join("; ");
  const reason =
    "HEALTHZ_REHEARSAL_ENABLED=1 must never be set on a production deploy. " +
    `Detected production signal(s): ${signalDetails}. ` +
    "The /api/_rehearsal/* injector is staging-only — see " +
    "docs/runbooks/rate-limit-store.md (boot-time guard). " +
    "Unset HEALTHZ_REHEARSAL_ENABLED on this deploy and restart.";
  log.error(
    {
      node_env: env.NODE_ENV,
      hostname: env.HOSTNAME,
      production_hostname_pattern: env.PRODUCTION_HOSTNAME_PATTERN,
      replit_deployment: env.REPLIT_DEPLOYMENT,
      deployment_environment: env.DEPLOYMENT_ENVIRONMENT,
      healthz_rehearsal_enabled: env.HEALTHZ_REHEARSAL_ENABLED,
      production_signals: signals.map((s) => s.signal),
    },
    `healthz_rehearsal_kill_switch_on_in_production: ${reason}`,
  );
  return { ok: false, reason };
}

/**
 * Boot-time sanity check: production deploys MUST set
 * `PRODUCTION_HOSTNAME_PATTERN`.
 *
 * The hostname signal in `assertRehearsalKillSwitchSafe` is the
 * strongest backstop — even if `NODE_ENV` / `REPLIT_DEPLOYMENT` /
 * `DEPLOYMENT_ENVIRONMENT` all drift, a deploy whose container
 * `HOSTNAME` matches the operator-configured production-hostname
 * regex will still refuse to boot with the rehearsal injector enabled.
 *
 * That whole layer is silently absent if no operator ever configured
 * `PRODUCTION_HOSTNAME_PATTERN` on the production deploy: the runbook
 * recommends setting it but nothing in the platform enforces it. Until
 * task #84 the only feedback an operator got was a runbook prose
 * sentence — easy to miss across env-var rotations and platform
 * migrations.
 *
 * This check turns the runbook recommendation into an automated boot-
 * time signal:
 *
 *   - If a production-shaped deploy is detected (any of `NODE_ENV=production`,
 *     `REPLIT_DEPLOYMENT=1`, `DEPLOYMENT_ENVIRONMENT=production`),
 *   - AND `PRODUCTION_HOSTNAME_PATTERN` is unset / empty,
 *   - THEN emit a loud structured warning naming the missing env var,
 *     the production signals that triggered the check, and the
 *     runbook section to read.
 *
 * The check deliberately determines production-ness via the OTHER
 * signals — using the hostname pattern itself would be circular (the
 * whole point is to detect when the pattern is missing).
 *
 * This is a warning, not a hard failure: the existing layered defence
 * (the runtime 404, the rehearsal token guard, and the kill-switch
 * boot guard via the other signals) already prevents a leaked URL
 * from inducing a real page even without the hostname backstop, so
 * crash-looping every existing production deploy that never set
 * `PRODUCTION_HOSTNAME_PATTERN` would be more disruptive than the
 * marginal security gain. The warning is structured (`pino` warn
 * level + dedicated message identifier) so an operator can configure
 * a Sentry / log-aggregator alert on
 * `production_hostname_pattern_missing` to catch the misconfiguration
 * within minutes of the next deploy.
 *
 * Pure function — takes `env` and a `log` sink so the unit test can
 * exercise both the staging-skipped, production-warned, and
 * production-configured paths without poisoning `process.env` or
 * piping pino output. Returns the outcome instead of side-effects so
 * the caller can decide what to do (today: log + continue; in the
 * future a deploy gate could reject).
 */
export type HostnamePatternConfigOutcome =
  | { ok: true }
  | { ok: false; reason: string };

export function assertProductionHostnamePatternConfigured(
  env: NodeJS.ProcessEnv,
  log: { warn: (obj: unknown, msg: string) => void },
): HostnamePatternConfigOutcome {
  const productionSignals = detectNonHostnameProductionSignals(env);
  if (productionSignals.length === 0) {
    // Not a production deploy — the hostname pattern is optional on
    // staging / dev / preview environments. Nothing to warn about.
    return { ok: true };
  }

  const raw = env.PRODUCTION_HOSTNAME_PATTERN;
  if (raw && raw.trim() !== "") {
    // Configured. We deliberately do NOT re-validate the regex here —
    // `compileHostnamePattern` (in `lib/productionSignals.ts`) already
    // logs `production_hostname_pattern_invalid` when the pattern is
    // malformed, and surfacing a second error from this check would
    // be noisy duplication. A typo'd pattern still counts as "the
    // operator configured it" for the purposes of this sanity check;
    // the malformed-regex log is the actionable signal.
    return { ok: true };
  }

  const signalDetails = productionSignals.map((s) => s.detail).join("; ");
  const reason =
    "PRODUCTION_HOSTNAME_PATTERN is not set on this production deploy. " +
    `Detected production signal(s): ${signalDetails}. ` +
    "Without this env var the hostname-based backstop in " +
    "assertRehearsalKillSwitchSafe is silently disabled — see " +
    "docs/runbooks/rate-limit-store.md (boot-time guard) for the " +
    "recommended pattern (e.g. PRODUCTION_HOSTNAME_PATTERN='^api\\.epplaa\\.com$').";
  log.warn(
    {
      node_env: env.NODE_ENV,
      hostname: env.HOSTNAME,
      replit_deployment: env.REPLIT_DEPLOYMENT,
      deployment_environment: env.DEPLOYMENT_ENVIRONMENT,
      production_hostname_pattern: env.PRODUCTION_HOSTNAME_PATTERN ?? null,
      production_signals: productionSignals.map((s) => s.signal),
    },
    `production_hostname_pattern_missing: ${reason}`,
  );
  return { ok: false, reason };
}

/**
 * Constant-time token compare. Buffers must have equal length for
 * `timingSafeEqual` so we pre-pad the supplied token to the expected
 * length and reject mismatched lengths separately.
 */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Express middleware that gates every rehearsal endpoint on:
 *   1. HEALTHZ_REHEARSAL_ENABLED=1     -> otherwise 404 (invisible)
 *   2. HEALTHZ_REHEARSAL_TOKEN set     -> otherwise 503 (misconfigured)
 *   3. X-Rehearsal-Token header matches -> otherwise 401
 *
 * Returning 404 (not 401/403) when the kill switch is off keeps the
 * existence of the endpoint hidden from anyone scanning a production
 * host, which matters because a successful inject would page real
 * on-call.
 */
function rehearsalGuard(req: Request, res: Response, next: NextFunction): void {
  const cfg = readGuardConfig();
  if (!cfg.enabled) {
    // Pretend the route doesn't exist on production hosts.
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (!cfg.token || cfg.token.trim() === "") {
    // Enabled but no token configured — treat as a misconfiguration.
    // We do NOT silently allow the request because that would defang
    // the second line of defence if HEALTHZ_REHEARSAL_ENABLED ever
    // got flipped on a host where the token wasn't also set.
    logger.error(
      { path: req.path },
      "healthz_rehearsal_misconfigured_no_token",
    );
    res.status(503).json({
      error: "rehearsal_misconfigured",
      detail: "HEALTHZ_REHEARSAL_TOKEN is not set on this server",
    });
    return;
  }
  const headerVal = req.header("x-rehearsal-token");
  if (!headerVal || !tokenMatches(headerVal, cfg.token)) {
    logger.warn(
      { path: req.path, hasHeader: typeof headerVal === "string" },
      "healthz_rehearsal_unauthorized",
    );
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

interface InjectBody {
  subsystem?: unknown;
  firstFailureAt?: unknown;
  failureCount?: unknown;
}

interface ClearBody {
  subsystem?: unknown;
}

function parseSubsystem(raw: unknown): SubsystemName | null {
  if (typeof raw !== "string") return null;
  return ALLOWED_SUBSYSTEMS.includes(raw as SubsystemName)
    ? (raw as SubsystemName)
    : null;
}

function watcherFor(subsystem: SubsystemName): {
  __injectStreak(firstFailureAt: number, failureCount: number): void;
  __reset(): void;
} {
  if (subsystem === "rateLimitStore") {
    return __getRedisFailureWatcherForRehearsal();
  }
  if (subsystem === "auditChain") {
    return auditHealthWatcher;
  }
  return dbHealthWatcher;
}

const router: IRouter = Router();

router.use("/_rehearsal", rehearsalGuard);

router.post("/_rehearsal/inject-stuck-degraded", (req, res) => {
  const body = (req.body ?? {}) as InjectBody;
  const subsystem = parseSubsystem(body.subsystem);
  if (!subsystem) {
    res.status(400).json({
      error: "invalid_subsystem",
      detail: `subsystem must be one of: ${ALLOWED_SUBSYSTEMS.join(", ")}`,
    });
    return;
  }
  const firstFailureAtRaw = body.firstFailureAt;
  const firstFailureAt =
    typeof firstFailureAtRaw === "number" && Number.isFinite(firstFailureAtRaw)
      ? firstFailureAtRaw
      : null;
  if (firstFailureAt === null) {
    res.status(400).json({
      error: "invalid_firstFailureAt",
      detail: "firstFailureAt must be a finite number (ms epoch)",
    });
    return;
  }
  // Reject in-the-future timestamps — the probe clamps negative
  // durations to 0 (clock skew tolerance) but a synthetic future
  // value would silently never page, defeating the rehearsal.
  const now = Date.now();
  if (firstFailureAt > now) {
    res.status(400).json({
      error: "invalid_firstFailureAt",
      detail: "firstFailureAt must be in the past (otherwise the probe will never page)",
    });
    return;
  }
  const failureCountRaw = body.failureCount;
  const failureCount =
    typeof failureCountRaw === "number" &&
    Number.isFinite(failureCountRaw) &&
    failureCountRaw > 0
      ? Math.floor(failureCountRaw)
      : 1;

  const watcher = watcherFor(subsystem);
  watcher.__injectStreak(firstFailureAt, failureCount);

  const durationMs = now - firstFailureAt;
  logger.warn(
    { subsystem, firstFailureAt, failureCount, durationMs },
    "healthz_rehearsal_injected_stuck_degraded",
  );
  res.json({
    status: "injected",
    subsystem,
    firstFailureAt,
    failureCount,
    // Echo durationMs so the rehearsal workflow can sanity-check that
    // the streak it just injected actually exceeds whatever threshold
    // the probe is configured with on the same staging deployment.
    durationMs,
  });
});

router.post("/_rehearsal/clear-stuck-degraded", (req, res) => {
  const body = (req.body ?? {}) as ClearBody;
  const subsystem = parseSubsystem(body.subsystem);
  if (!subsystem) {
    res.status(400).json({
      error: "invalid_subsystem",
      detail: `subsystem must be one of: ${ALLOWED_SUBSYSTEMS.join(", ")}`,
    });
    return;
  }
  const watcher = watcherFor(subsystem);
  watcher.__reset();
  logger.info({ subsystem }, "healthz_rehearsal_cleared_stuck_degraded");
  res.json({ status: "cleared", subsystem });
});

export default router;
