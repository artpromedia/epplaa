/**
 * checkHealthzDegraded — uptime probe that pages on-call when /healthz
 * has reported any backing subsystem in `state === "degraded"` for
 * longer than a configurable threshold.
 *
 * Why this exists (see docs/runbooks/rate-limit-store.md):
 * The Sentry-side alert
 * (`rate_limit_redis_failure_threshold_breached`) fires on failure
 * *rate* — i.e. >N failures per rolling minute. That works for a
 * cliff-edge outage but misses a slow trickle of failures that keeps
 * a watcher in `degraded` for many minutes without ever crossing the
 * per-minute rate threshold. This probe complements that by alerting
 * on streak *duration*: if /healthz keeps reporting `degraded` for
 * any subsystem and the streak that began at `firstFailureAt` exceeds
 * the threshold, exit non-zero so the surrounding cron / uptime check
 * pages on-call.
 *
 * The probe walks every entry in `body.subsystems` (rate-limit store,
 * DB, ...future audit chain / payment circuit breakers) and pages on
 * the worst one — naming the offending subsystem in the page reason
 * so on-call doesn't have to re-curl /healthz to know where to start
 * digging. For backwards compatibility with /healthz responses that
 * pre-date the subsystems map, the probe also accepts the legacy
 * top-level `rateLimitStore` field as a single-subsystem source.
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
 *   2  page on-call: at least one subsystem state=degraded AND streak
 *      duration > threshold
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
 *
 * `subsystems` is the canonical multi-subsystem map. `rateLimitStore`
 * is preserved as a back-compat alternative for /healthz responses
 * served by an api-server version that pre-dates the subsystems map.
 */
export interface SubsystemEntry {
  state?: unknown;
  firstFailureAt?: unknown;
  [k: string]: unknown;
}
export interface HealthzBody {
  status?: unknown;
  subsystems?: Record<string, SubsystemEntry> | unknown;
  rateLimitStore?: SubsystemEntry | unknown;
  [k: string]: unknown;
}

export type EvaluationOutcome = "healthy" | "below_threshold" | "page";

/** Per-subsystem evaluation. Combined into a single overall result. */
export interface SubsystemEvaluation {
  name: string;
  outcome: EvaluationOutcome;
  reason: string;
  /** ms since `firstFailureAt`, or null when not in a degraded streak
   *  or when the field is missing/invalid. */
  durationMs: number | null;
  state: string | null;
  firstFailureAt: number | null;
}

export interface EvaluationResult {
  outcome: EvaluationOutcome;
  /** Human-readable reason — included verbatim in the structured log
   *  line so the on-call page body explains *why* it fired. Names
   *  the offending subsystem when the outcome is `page`. */
  reason: string;
  /** ms since `firstFailureAt` of the worst subsystem, or null. */
  durationMs: number | null;
  /** Name of the subsystem driving the outcome, or null when no
   *  evaluable subsystem was present in the body (response-shape
   *  regression). */
  subsystem: string | null;
  /** Per-subsystem detail surfaced for log triage. Empty list when
   *  the response had no recognisable subsystems block at all. */
  subsystems: SubsystemEvaluation[];
  thresholdMs: number;
}

/**
 * Per-subsystem decision matrix:
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
function evaluateSubsystem(
  name: string,
  entry: SubsystemEntry | undefined,
  nowMs: number,
  thresholdMs: number,
): SubsystemEvaluation {
  const rawState = entry?.state;
  const state = typeof rawState === "string" ? rawState : null;
  const rawFirst = entry?.firstFailureAt;
  const firstFailureAt =
    typeof rawFirst === "number" && Number.isFinite(rawFirst) ? rawFirst : null;

  if (state === "healthy") {
    return {
      name,
      outcome: "healthy",
      reason: `${name}.state=healthy`,
      durationMs: null,
      state,
      firstFailureAt,
    };
  }

  if (state !== "degraded") {
    return {
      name,
      outcome: "page",
      reason: `${name}.state missing or unrecognised (got ${JSON.stringify(rawState)})`,
      durationMs: null,
      state,
      firstFailureAt,
    };
  }

  if (firstFailureAt === null) {
    return {
      name,
      outcome: "page",
      reason: `${name}.state=degraded but firstFailureAt missing/invalid — cannot compute streak duration`,
      durationMs: null,
      state,
      firstFailureAt,
    };
  }

  // Clamp negatives in case clock skew between the api host and the
  // probe host produces a "negative" duration; report 0 rather than a
  // confusing negative number, but still treat it as below threshold.
  const durationMs = Math.max(0, nowMs - firstFailureAt);

  if (durationMs > thresholdMs) {
    return {
      name,
      outcome: "page",
      reason: `${name} degraded for ${durationMs}ms (> threshold ${thresholdMs}ms)`,
      durationMs,
      state,
      firstFailureAt,
    };
  }
  return {
    name,
    outcome: "below_threshold",
    reason: `${name} degraded for ${durationMs}ms (<= threshold ${thresholdMs}ms)`,
    durationMs,
    state,
    firstFailureAt,
  };
}

function isSubsystemEntry(v: unknown): v is SubsystemEntry {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Extract the per-subsystem entries from /healthz. Prefers the
 * canonical `subsystems` map; falls back to the legacy top-level
 * `rateLimitStore` field for /healthz responses that pre-date the map.
 *
 * Returns an empty list when neither shape is present — the caller
 * treats that as a response-shape regression and pages on it.
 */
function extractSubsystems(body: HealthzBody): Array<[string, SubsystemEntry]> {
  const out: Array<[string, SubsystemEntry]> = [];
  const map = body.subsystems;
  if (typeof map === "object" && map !== null && !Array.isArray(map)) {
    for (const [name, entry] of Object.entries(map as Record<string, unknown>)) {
      if (isSubsystemEntry(entry)) out.push([name, entry]);
    }
  }
  if (out.length === 0) {
    // Back-compat: older /healthz responses only exposed the rate-limit
    // store at the top level. Treat it as a single-subsystem map so
    // the duration alert still works during a rolling deploy.
    const legacy = body.rateLimitStore;
    if (isSubsystemEntry(legacy)) {
      out.push(["rateLimitStore", legacy]);
    }
  }
  return out;
}

/**
 * Severity ranking used to pick the worst per-subsystem outcome. The
 * "page" with the longest known degradation wins (so on-call sees the
 * subsystem that's been broken the longest); ties fall back to name
 * order for deterministic test output.
 */
function outcomeRank(o: EvaluationOutcome): number {
  if (o === "page") return 2;
  if (o === "below_threshold") return 1;
  return 0;
}

/**
 * Pure evaluator: decide whether the observed /healthz body should
 * page on-call. Walks every subsystem and returns the worst outcome,
 * naming the offending subsystem in the reason so the page body is
 * actionable.
 *
 * Special cases:
 *   - No subsystems present at all (neither `subsystems` map nor the
 *     legacy `rateLimitStore` field) -> page. The response shape
 *     regressed and a human should look.
 */
export function evaluateHealthz(
  body: HealthzBody,
  nowMs: number,
  thresholdMs: number,
): EvaluationResult {
  const entries = extractSubsystems(body);

  if (entries.length === 0) {
    return {
      outcome: "page",
      reason:
        "no recognisable subsystems in /healthz body (neither `subsystems` map nor legacy `rateLimitStore` field present)",
      durationMs: null,
      subsystem: null,
      subsystems: [],
      thresholdMs,
    };
  }

  const evaluations = entries
    .map(([name, entry]) => evaluateSubsystem(name, entry, nowMs, thresholdMs))
    // Stable name ordering so when several subsystems share the worst
    // outcome the page reason is deterministic across probe runs.
    .sort((a, b) => a.name.localeCompare(b.name));

  // Pick the worst outcome; among equally-bad outcomes prefer the
  // subsystem with the largest known durationMs so on-call sees the
  // one that's been broken longest first.
  let worst = evaluations[0]!;
  for (const e of evaluations) {
    const rankCmp = outcomeRank(e.outcome) - outcomeRank(worst.outcome);
    if (rankCmp > 0) {
      worst = e;
      continue;
    }
    if (rankCmp === 0) {
      const wDur = worst.durationMs ?? -1;
      const eDur = e.durationMs ?? -1;
      if (eDur > wDur) worst = e;
    }
  }

  // If the worst outcome is `page`, list every subsystem that's
  // currently page-worthy so the reason captures all simultaneously
  // failing dependencies (not just the longest one). Common case is
  // one offender, but a correlated outage should not silently hide
  // siblings.
  let reason = worst.reason;
  if (worst.outcome === "page") {
    const offenders = evaluations.filter((e) => e.outcome === "page");
    if (offenders.length > 1) {
      reason =
        `multiple subsystems page-worthy: ` +
        offenders.map((o) => o.reason).join("; ");
    }
  }

  return {
    outcome: worst.outcome,
    reason,
    durationMs: worst.durationMs,
    subsystem: worst.name,
    subsystems: evaluations,
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
      subsystem: result.subsystem,
      subsystems: result.subsystems,
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
