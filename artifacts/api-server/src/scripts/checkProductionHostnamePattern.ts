/**
 * checkProductionHostnamePattern — post-deploy / scheduled verifier
 * that pages on-call when a production-shaped api-server is running
 * without `PRODUCTION_HOSTNAME_PATTERN` configured.
 *
 * Why this exists (task #89):
 * `PRODUCTION_HOSTNAME_PATTERN` is the strongest backstop in
 * `assertRehearsalKillSwitchSafe`: even if `NODE_ENV` /
 * `REPLIT_DEPLOYMENT` / `DEPLOYMENT_ENVIRONMENT` all drift, a deploy
 * whose container `HOSTNAME` matches the operator-configured
 * production-hostname regex still refuses to boot with the rehearsal
 * injector enabled. That whole layer is silently absent if no operator
 * ever set the env var on a production deploy.
 *
 * The boot-time check `assertProductionHostnamePatternConfigured`
 * (`routes/healthzRehearsal.ts`) already emits a structured warn-log
 * when the pattern is missing on a production-shaped boot — but
 * warning logs are easy to lose in a noisy aggregator and don't page
 * on-call. This probe turns the warn-log signal into an actionable
 * external check by polling `/readyz`'s `config` block (see
 * `getReadyzConfigBlock` in `routes/health.ts`) and exiting non-zero
 * when the production deploy reports `productionHostnamePattern ===
 * "missing"`. The surrounding GitHub Actions cron / post-deploy
 * workflow then forwards the failure to Sentry the same way the
 * stuck-degraded probe does.
 *
 * Why /readyz and not /healthz: /readyz already runs operator-only
 * checks (DB + Redis reachability) and was the natural surface for
 * adding a config block without changing the established /healthz
 * shape that older probes / dashboards depend on. The config block is
 * informational — it does NOT influence the ready/not_ready decision
 * (that would drain the replica out of rotation for a configuration
 * warning, which is more disruptive than the marginal security gain).
 *
 * Usage (CI cron, post-deploy step, ad-hoc verify):
 *
 *   READYZ_URL=https://api.example.com/api/readyz \
 *     pnpm --filter @workspace/api-server exec tsx \
 *       src/scripts/checkProductionHostnamePattern.ts
 *
 * Exit codes (chosen so an external probe can wire alerting on "any
 * non-zero" without distinguishing — but the codes are still distinct
 * for log triage; matches `checkHealthzDegraded.ts`):
 *   0  configured (production-shaped deploy with the pattern set)
 *      OR not_required (non-production deploy — staging / dev /
 *      preview where the backstop is optional)
 *   1  probe error (network failure, non-2xx, malformed body, missing
 *      config block) — does not necessarily mean the api is broken;
 *      the probe itself failed
 *   2  page on-call: the production deploy reports the hostname
 *      pattern is missing
 *
 * The script writes a single JSON line to stdout describing what it
 * observed so the surrounding wrapper (cron log, Sentry event
 * transformer, etc.) can include it in the page body. Errors go to
 * stderr.
 */

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/**
 * Sanitise a numeric env var. Mirrors the helper in
 * `checkHealthzDegraded.ts` so a typo doesn't silently turn the
 * timeout into either a fire-immediately timer (NaN / 0) or a
 * permanently-blocking probe (negative).
 */
export function parseTimeoutMs(
  raw: string | undefined,
  fallbackMs: number,
): number {
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallbackMs;
}

/**
 * Shape of the relevant slice of the `/readyz` response. Kept narrow
 * (only the `config` block this probe needs) so a future addition to
 * the response body — e.g. another boot-time-config check, a new
 * dependency check — doesn't require a code change here.
 *
 * `config.productionHostnamePattern` is the field the probe pages on.
 * The other readyz fields (`status`, `checks`, `failures`,
 * `rateLimitStore`) are intentionally NOT inspected: this probe is
 * scoped to the configuration check, and dependency-health failures
 * are already paged by the LB drain + the stuck-degraded probe.
 */
export interface ReadyzConfigBlockShape {
  productionHostnamePattern?: unknown;
  [k: string]: unknown;
}
export interface ReadyzBody {
  config?: ReadyzConfigBlockShape | unknown;
  [k: string]: unknown;
}

export type EvaluationOutcome =
  | "configured"
  | "not_required"
  | "missing"
  | "probe_error";

export interface EvaluationResult {
  outcome: EvaluationOutcome;
  /** Human-readable reason — included verbatim in the structured log
   *  line so the on-call page body explains *why* it fired. */
  reason: string;
  /** The raw value observed at `body.config.productionHostnamePattern`,
   *  preserved for log triage when the value is unrecognised. */
  observed: unknown;
}

/**
 * Pure evaluator: decide whether the observed `/readyz` body should
 * page on-call.
 *
 * Decision matrix:
 *   body.config missing / not an object         -> probe_error (the
 *                                                  api-server we hit is
 *                                                  serving an
 *                                                  unexpected /readyz
 *                                                  shape — either a
 *                                                  rolling-deploy
 *                                                  version skew or
 *                                                  the route was
 *                                                  changed; either way
 *                                                  the check can't
 *                                                  decide and a human
 *                                                  should look)
 *   productionHostnamePattern === "configured"  -> configured (healthy)
 *   productionHostnamePattern === "not_required"-> not_required
 *                                                  (non-prod deploy;
 *                                                  the backstop is
 *                                                  optional here)
 *   productionHostnamePattern === "missing"     -> missing (page)
 *   anything else                               -> probe_error (an
 *                                                  unrecognised value
 *                                                  is a response-shape
 *                                                  regression — escalate
 *                                                  rather than silently
 *                                                  treating it as
 *                                                  configured)
 */
export function evaluateReadyz(body: ReadyzBody): EvaluationResult {
  const config = body.config;
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return {
      outcome: "probe_error",
      reason:
        "/readyz body is missing the `config` block (or it is not an object) — the api-server we probed is serving an unexpected response shape",
      observed: config,
    };
  }
  const value = (config as ReadyzConfigBlockShape).productionHostnamePattern;
  if (value === "configured") {
    return {
      outcome: "configured",
      reason:
        "production deploy has PRODUCTION_HOSTNAME_PATTERN configured — hostname backstop active",
      observed: value,
    };
  }
  if (value === "not_required") {
    return {
      outcome: "not_required",
      reason:
        "deploy is not production-shaped (staging / dev / preview) — hostname backstop not required",
      observed: value,
    };
  }
  if (value === "missing") {
    return {
      outcome: "missing",
      reason:
        "PRODUCTION_HOSTNAME_PATTERN is unset on this production deploy — the hostname backstop in assertRehearsalKillSwitchSafe is silently disabled. Set the env var on the production deploy and restart. See docs/runbooks/staging-only-endpoints.md (post-deploy verifier).",
      observed: value,
    };
  }
  return {
    outcome: "probe_error",
    reason: `unrecognised value at config.productionHostnamePattern (got ${JSON.stringify(value)}) — response-shape regression`,
    observed: value,
  };
}

/**
 * Map an evaluation outcome to a process exit code. Centralised so
 * the test suite and the runner stay in sync.
 *
 * `not_required` and `configured` both exit 0 — the probe is
 * intentionally silent on healthy production AND on staging deploys,
 * because the same workflow file may be configured to fan out across
 * multiple environments.
 */
export function exitCodeFor(outcome: EvaluationOutcome): 0 | 1 | 2 {
  if (outcome === "missing") return 2;
  if (outcome === "probe_error") return 1;
  return 0;
}

interface ProbeOk {
  ok: true;
  body: ReadyzBody;
  httpStatus: number;
}
interface ProbeErr {
  ok: false;
  error: string;
}
type ProbeResult = ProbeOk | ProbeErr;

/**
 * Fetch /readyz with an explicit timeout. Returns a discriminated
 * union rather than throwing so the caller can produce a structured
 * stderr line instead of a stack trace.
 *
 * Crucially, this probe accepts BOTH a 200 ready response AND a 503
 * not_ready response: /readyz includes the `config` block on both
 * paths (so this check can still page on a missing pattern even while
 * the replica is draining), and gating on a 200 here would silently
 * paper over the misconfiguration during a downstream outage — the
 * worst-possible time to lose the page.
 */
async function fetchReadyz(
  url: string,
  timeoutMs: number,
): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    // Accept any HTTP status that returned a JSON body — see comment
    // above about 200 + 503 both being valid for this probe.
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      return {
        ok: false,
        error: `failed to parse JSON body (HTTP ${res.status}): ${(err as Error).message}`,
      };
    }
    if (parsed === null || typeof parsed !== "object") {
      return {
        ok: false,
        error: `response body is not a JSON object (HTTP ${res.status})`,
      };
    }
    return { ok: true, body: parsed as ReadyzBody, httpStatus: res.status };
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
    fetchImpl?: (url: string, timeoutMs: number) => Promise<ProbeResult>;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
  } = {},
): Promise<0 | 1 | 2> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetchReadyz;
  const stdout =
    deps.stdout ?? ((line: string) => process.stdout.write(line + "\n"));
  const stderr =
    deps.stderr ?? ((line: string) => process.stderr.write(line + "\n"));

  const url = env.READYZ_URL;
  if (!url || url.trim() === "") {
    stderr(
      "READYZ_URL is required (e.g. https://api.example.com/api/readyz)",
    );
    return 1;
  }
  const probeTimeoutMs = parseTimeoutMs(
    env.READYZ_PROBE_TIMEOUT_MS,
    DEFAULT_PROBE_TIMEOUT_MS,
  );

  const probe = await fetchImpl(url, probeTimeoutMs);
  if (!probe.ok) {
    stderr(
      JSON.stringify({
        check: "production_hostname_pattern",
        outcome: "probe_error",
        url,
        error: probe.error,
        probeTimeoutMs,
      }),
    );
    return 1;
  }

  const result = evaluateReadyz(probe.body);
  stdout(
    JSON.stringify({
      check: "production_hostname_pattern",
      outcome: result.outcome,
      reason: result.reason,
      observed: result.observed,
      url,
      httpStatus: probe.httpStatus,
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
  /checkProductionHostnamePattern(\.[mc]?[jt]s)?$/.test(process.argv[1]);

if (isDirectInvocation) {
  void main().then(
    (code) => {
      process.exit(code);
    },
    (err: unknown) => {
      // Defensive: any unexpected throw exits 1 (probe error) rather
      // than 0, so the cron wrapper still sees a failure.
      process.stderr.write(
        `checkProductionHostnamePattern crashed: ${(err as Error).message}\n`,
      );
      process.exit(1);
    },
  );
}
