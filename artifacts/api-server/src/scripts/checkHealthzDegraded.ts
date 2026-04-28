/**
 * checkHealthzDegraded — uptime probe that pages on-call when /healthz
 * has reported `rateLimitStore.state === "degraded"` for longer than a
 * configurable threshold.
 *
 * Why this exists (see docs/runbooks/rate-limit-store.md):
 * The Sentry-side alert
 * (`rate_limit_redis_failure_threshold_breached`) fires on failure
 * *rate* — i.e. >N failures per rolling minute. That works for a
 * cliff-edge outage but misses a slow trickle of failures that keeps
 * the watcher in `degraded` for many minutes without ever crossing the
 * per-minute rate threshold. This probe complements that by alerting
 * on streak *duration*: if /healthz keeps reporting `degraded` and the
 * streak that began at `firstFailureAt` exceeds the threshold, exit
 * non-zero so the surrounding cron / uptime check pages on-call.
 *
 * Usage (cron / scheduled job / external uptime probe):
 *
 *   HEALTHZ_URL=https://api.example.com/api/healthz \
 *   HEALTHZ_DEGRADED_ALERT_THRESHOLD_MS=300000 \
 *     pnpm --filter @workspace/api-server exec tsx \
 *       src/scripts/checkHealthzDegraded.ts
 *
 * Exit codes (chosen so an external probe can wire alerting on "any
 * non-zero" without distinguishing — but the codes are still distinct
 * for log triage):
 *   0  healthy or short-lived degraded streak (under the threshold)
 *   1  probe error (network failure, non-2xx, malformed body) — does
 *      not necessarily mean the api is broken; the probe itself failed
 *   2  page on-call: state=degraded AND streak duration > threshold
 *
 * The script writes a single JSON line to stdout describing what it
 * observed so the surrounding wrapper (cron log, PagerDuty event
 * transformer, etc.) can include it in the page body. Errors go to
 * stderr.
 */

const DEFAULT_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/**
 * Sanitise a numeric env var. Mirrors the helper in routes/health.ts:
 * a missing, non-numeric, zero, or negative value falls back to
 * `fallbackMs` so a typo doesn't silently turn the alert into either
 * a flapping page (zero-ms threshold) or a permanently-silent one.
 */
export function parseDurationMs(
  raw: string | undefined,
  fallbackMs: number,
): number {
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallbackMs;
}

/**
 * Shape of the relevant slice of the /healthz response. Kept narrow
 * (only the fields the alert evaluator needs) so a future addition to
 * the response body doesn't require a code change here.
 */
export interface HealthzBody {
  status?: unknown;
  rateLimitStore?: {
    state?: unknown;
    firstFailureAt?: unknown;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export type EvaluationOutcome = "healthy" | "below_threshold" | "page";

export interface EvaluationResult {
  outcome: EvaluationOutcome;
  /** Human-readable reason — included verbatim in the structured log
   *  line so the on-call page body explains *why* it fired. */
  reason: string;
  /** ms since `firstFailureAt`, or null when not in a degraded streak
   *  or when the field is missing/invalid. */
  durationMs: number | null;
  /** Raw values surfaced for log triage. */
  state: string | null;
  firstFailureAt: number | null;
  thresholdMs: number;
}

/**
 * Pure evaluator: decide whether the observed /healthz body should
 * page on-call. Split out from the runner so it can be unit-tested
 * without spinning an HTTP server.
 *
 * Decision matrix:
 *   state missing / unrecognised   -> page (treat as actionable;
 *                                     either /healthz changed shape
 *                                     or someone is serving an
 *                                     unexpected response and we want
 *                                     a human to look)
 *   state === "healthy"            -> healthy
 *   state === "degraded" but
 *     firstFailureAt missing/bad   -> page (the watcher should always
 *                                     set firstFailureAt while
 *                                     degraded; missing it means
 *                                     either a code regression or
 *                                     something stripping fields in
 *                                     the response path — either way,
 *                                     escalate)
 *   state === "degraded" and
 *     duration > threshold         -> page
 *   state === "degraded" and
 *     duration <= threshold        -> below_threshold (no page)
 */
export function evaluateHealthz(
  body: HealthzBody,
  nowMs: number,
  thresholdMs: number,
): EvaluationResult {
  const store = body.rateLimitStore;
  const rawState = store?.state;
  const state = typeof rawState === "string" ? rawState : null;

  const rawFirst = store?.firstFailureAt;
  const firstFailureAt =
    typeof rawFirst === "number" && Number.isFinite(rawFirst) ? rawFirst : null;

  if (state === "healthy") {
    return {
      outcome: "healthy",
      reason: "rateLimitStore.state=healthy",
      durationMs: null,
      state,
      firstFailureAt,
      thresholdMs,
    };
  }

  if (state !== "degraded") {
    return {
      outcome: "page",
      reason: `rateLimitStore.state missing or unrecognised (got ${JSON.stringify(rawState)})`,
      durationMs: null,
      state,
      firstFailureAt,
      thresholdMs,
    };
  }

  if (firstFailureAt === null) {
    return {
      outcome: "page",
      reason:
        "rateLimitStore.state=degraded but firstFailureAt missing/invalid — cannot compute streak duration",
      durationMs: null,
      state,
      firstFailureAt,
      thresholdMs,
    };
  }

  // Clamp negatives in case clock skew between the api host and the
  // probe host produces a "negative" duration; report 0 rather than a
  // confusing negative number, but still treat it as below threshold.
  const durationMs = Math.max(0, nowMs - firstFailureAt);

  if (durationMs > thresholdMs) {
    return {
      outcome: "page",
      reason: `rateLimitStore degraded for ${durationMs}ms (> threshold ${thresholdMs}ms)`,
      durationMs,
      state,
      firstFailureAt,
      thresholdMs,
    };
  }
  return {
    outcome: "below_threshold",
    reason: `rateLimitStore degraded for ${durationMs}ms (<= threshold ${thresholdMs}ms)`,
    durationMs,
    state,
    firstFailureAt,
    thresholdMs,
  };
}

/**
 * Map an evaluation outcome to a process exit code. Centralised so
 * the test suite and the runner stay in sync.
 */
export function exitCodeFor(outcome: EvaluationOutcome): 0 | 2 {
  return outcome === "page" ? 2 : 0;
}

interface ProbeOk {
  ok: true;
  body: HealthzBody;
  httpStatus: number;
}
interface ProbeErr {
  ok: false;
  error: string;
}
type ProbeResult = ProbeOk | ProbeErr;

/**
 * Fetch /healthz with an explicit timeout. Returns a discriminated
 * union rather than throwing so the caller can produce a structured
 * stderr line instead of a stack trace.
 */
async function fetchHealthz(
  url: string,
  timeoutMs: number,
): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      return {
        ok: false,
        error: `non-2xx response: HTTP ${res.status}`,
      };
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      return {
        ok: false,
        error: `failed to parse JSON body: ${(err as Error).message}`,
      };
    }
    if (parsed === null || typeof parsed !== "object") {
      return { ok: false, error: "response body is not a JSON object" };
    }
    return { ok: true, body: parsed as HealthzBody, httpStatus: res.status };
  } catch (err) {
    const e = err as Error & { name?: string };
    if (e.name === "AbortError") {
      return { ok: false, error: `probe timeout after ${timeoutMs}ms` };
    }
    return { ok: false, error: `fetch failed: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * CLI entrypoint. Exported so tests can drive it with mocked
 * dependencies, but the bottom of the file actually invokes it when
 * the module is run directly.
 */
export async function main(
  deps: {
    env?: NodeJS.ProcessEnv;
    now?: () => number;
    fetchImpl?: (url: string, timeoutMs: number) => Promise<ProbeResult>;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
  } = {},
): Promise<0 | 1 | 2> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? fetchHealthz;
  const stdout = deps.stdout ?? ((line: string) => process.stdout.write(line + "\n"));
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(line + "\n"));

  const url = env.HEALTHZ_URL;
  if (!url || url.trim() === "") {
    stderr(
      "HEALTHZ_URL is required (e.g. https://api.example.com/api/healthz)",
    );
    return 1;
  }
  const thresholdMs = parseDurationMs(
    env.HEALTHZ_DEGRADED_ALERT_THRESHOLD_MS,
    DEFAULT_THRESHOLD_MS,
  );
  const probeTimeoutMs = parseDurationMs(
    env.HEALTHZ_PROBE_TIMEOUT_MS,
    DEFAULT_PROBE_TIMEOUT_MS,
  );

  const probe = await fetchImpl(url, probeTimeoutMs);
  if (!probe.ok) {
    stderr(
      JSON.stringify({
        check: "healthz_degraded",
        outcome: "probe_error",
        url,
        error: probe.error,
        thresholdMs,
        probeTimeoutMs,
      }),
    );
    return 1;
  }

  const result = evaluateHealthz(probe.body, now(), thresholdMs);
  stdout(
    JSON.stringify({
      check: "healthz_degraded",
      outcome: result.outcome,
      reason: result.reason,
      url,
      httpStatus: probe.httpStatus,
      state: result.state,
      firstFailureAt: result.firstFailureAt,
      durationMs: result.durationMs,
      thresholdMs: result.thresholdMs,
    }),
  );
  return exitCodeFor(result.outcome);
}

const isDirectInvocation =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  // tsx / node both set argv[1] to the resolved entry path; this file
  // is only ever the entry when run as a CLI.
  /checkHealthzDegraded(\.[mc]?[jt]s)?$/.test(process.argv[1]);

if (isDirectInvocation) {
  void main().then(
    (code) => {
      process.exit(code);
    },
    (err: unknown) => {
      // Defensive: any unexpected throw exits 1 (probe error) rather
      // than 0, so the cron wrapper still sees a failure.
      process.stderr.write(
        `checkHealthzDegraded crashed: ${(err as Error).message}\n`,
      );
      process.exit(1);
    },
  );
}
