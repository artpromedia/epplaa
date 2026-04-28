import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { logger } from "../lib/logger";
import { dbHealthWatcher } from "../lib/subsystemHealth";
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
 *     body: { subsystem: "rateLimitStore" | "db",
 *             firstFailureAt: number (ms epoch),
 *             failureCount?: number (default 1) }
 *
 *   POST /_rehearsal/clear-stuck-degraded
 *     body: { subsystem: "rateLimitStore" | "db" }
 *
 * Both endpoints return 404 unless `HEALTHZ_REHEARSAL_ENABLED=1`, so
 * the route is invisible in production. When enabled they additionally
 * require an `X-Rehearsal-Token` header that timing-safely matches
 * `HEALTHZ_REHEARSAL_TOKEN` so that even if a staging URL leaks, the
 * endpoint can't be abused to induce false pages on the real on-call
 * channel. A 401 is returned when the token is missing or wrong.
 */

type SubsystemName = "rateLimitStore" | "db";

const ALLOWED_SUBSYSTEMS: readonly SubsystemName[] = ["rateLimitStore", "db"];

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
