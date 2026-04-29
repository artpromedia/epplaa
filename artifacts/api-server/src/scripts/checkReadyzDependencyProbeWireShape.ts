/**
 * checkReadyzDependencyProbeWireShape — post-deploy / scheduled
 * verifier that pages on-call when the per-probe wire-shape fields
 * surfaced by the optional /readyz dependency probes (Clerk,
 * Paystack, Flutterwave) drift from the contract documented in
 * `docs/runbooks/readyz-dependency-probes.md`.
 *
 * Why this exists (task #122):
 * `lib/dependencyProbes.ts` and `routes/health.ts` have unit tests
 * that stub `fetch` via `vi.stubGlobal` and therefore can't catch
 * wire-shape regressions that only show up on the deployed surface
 * — a route-side refactor that renamed a `checks.<name>` value,
 * dropped a `config.dependencyProbes.<name>` field, stopped emitting
 * the `http_probe_timeout_after_<n>ms` marker, or silently flipped
 * a default would slip past unit tests and only surface the next
 * time a probe was enabled in production (exactly the failure mode
 * where on-call most needs the probes to work). This probe hits the
 * deployed /readyz URL and asserts the per-probe wire shape per the
 * runbook contract for every probe in lockstep.
 *
 * Per-probe assertions (applied to each of clerk, paystack,
 * flutterwave — iterating over the closed probe set is the
 * "toggles each probe in turn" the task describes; toggling env
 * vars on a deployed service from outside isn't possible without an
 * admin-side fixture endpoint, which is deferred as a follow-up):
 *
 *   - `checks.<name>` ∈ {"ok", "failed", "skipped"}.
 *   - `config.dependencyProbes.<name>` has shape
 *     { enabled: boolean, url: string, timeoutMs: number }.
 *   - When `checks.<name> === "skipped"`:
 *       - `failures.<name>` is absent.
 *       - `config.dependencyProbes.<name>.enabled === false`.
 *   - When `checks.<name> === "ok"`:
 *       - `failures.<name>` is absent.
 *       - `config.dependencyProbes.<name>.enabled === true`.
 *   - When `checks.<name> === "failed"`:
 *       - `failures.<name>` is a non-empty string.
 *       - `config.dependencyProbes.<name>.enabled === true`.
 *       - When the failure string CLAIMS a timeout (starts with
 *         `http_probe_timeout_after_`), it MUST match the documented
 *         marker shape `/^http_probe_timeout_after_\d+ms$/` —
 *         uniform with the rate-limit redis probe so log-aggregator
 *         queries on the prefix `*_timeout_after_*ms` work across
 *         probe types. A malformed marker (e.g. ms suffix dropped)
 *         is escalated to `probe_error`.
 *
 * Runbook coverage maximisation:
 * The runbook's "Post-deploy wire-shape smoke check" section
 * recommends that staging deploys configure all three probes
 * (READYZ_PROBE_<NAME>=1 with a real third-party probe URL) so each
 * probe returns either "ok" or "failed" rather than "skipped" — the
 * latter exercises the most-skipped branch of the assertion matrix.
 * The probe still passes when one or more probes are skipped (that's
 * a valid documented state); the runbook is a guideline for
 * maximising the assertion surface, not a precondition for the
 * gate.
 *
 * Exit codes (matches `checkReadyzConfig.ts` /
 * `checkProductionHostnamePattern.ts` conventions so the
 * surrounding cron / workflow wrapper can wire alerting on "any
 * non-zero" without distinguishing, and a human triaging the
 * failure can read intent from the code):
 *
 *   0  every probe matches the documented wire shape
 *   1  probe error: network failure, non-2xx body that won't parse,
 *      missing `config.dependencyProbes` block, or a probe field is
 *      in an unrecognised shape (response-shape regression —
 *      escalate rather than silently treating it as healthy)
 *   2  page on-call: at least ONE probe is in a wire-shape-
 *      regressed state. The structured stdout line lists every
 *      regressed probe with the observed value so the page body
 *      identifies the regression without the on-call having to
 *      re-run by hand.
 */

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/**
 * Sanitise a numeric env var. Mirrors the helper in
 * `checkReadyzConfig.ts` / `checkProductionHostnamePattern.ts` so a
 * typo doesn't silently turn the timeout into either a fire-
 * immediately timer (NaN / 0) or a permanently-blocking probe
 * (negative).
 */
export function parseTimeoutMs(
  raw: string | undefined,
  fallbackMs: number,
): number {
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallbackMs;
}

/**
 * Closed set of probes the gate evaluates. Keeping it as a literal
 * union (rather than `string`) means a typo'd probe name in the
 * matrix below is a TypeScript error, not a silent dropped check.
 * A future fourth dependency probe MUST extend both this list and
 * the runbook section so the gate stays in lockstep with the route.
 */
export type ProbeName = "clerk" | "paystack" | "flutterwave";
export const PROBES: readonly ProbeName[] = [
  "clerk",
  "paystack",
  "flutterwave",
];

/**
 * Shape of the relevant slice of the `/readyz` response. Kept narrow
 * (only the fields this probe needs) so a future addition to the
 * response body — e.g. a new dependency probe, another config-block
 * field — doesn't require a code change here. Per-field types are
 * `unknown` so the per-probe evaluator can defensively reject
 * unrecognised values rather than silently passing them through as
 * "wire-shape ok".
 */
export interface ReadyzBody {
  checks?: unknown;
  failures?: unknown;
  config?: unknown;
  [k: string]: unknown;
}

/**
 * Per-probe outcome enum. The top-level evaluator folds the matrix
 * into a single exit code via `exitCodeFor` — same severity ladder
 * as `checkReadyzConfig.ts`:
 *
 *   probe_error > page > ok
 *
 * `probe_error` outranks `page` because an unrecognised /readyz
 * shape means the gate itself can't make a trustworthy decision —
 * escalating to "probe error" is more informative than silently
 * picking one interpretation. Both are non-zero exits so the cron
 * wrapper pages on either; the distinction matters for log triage.
 */
export type ProbeOutcome = "ok" | "page" | "probe_error";

export interface ProbeWireShapeObserved {
  /** The value at `body.checks[<probe>]`, preserved as-is so the
   *  log triage path can see exactly what the route emitted. */
  check: unknown;
  /** The value at `body.failures[<probe>]`. `undefined` when the
   *  failures map is missing the key (the documented absent state). */
  failure: unknown;
  /** The full `body.config.dependencyProbes[<probe>]` sub-object,
   *  preserved as-is. */
  config: unknown;
}

export interface ProbeEvaluation {
  probe: ProbeName;
  outcome: ProbeOutcome;
  /** Human-readable reason — included verbatim in the structured
   *  stdout line so the on-call page body explains why it fired. */
  reason: string;
  observed: ProbeWireShapeObserved;
}

function ok(
  probe: ProbeName,
  observed: ProbeWireShapeObserved,
  reason: string,
): ProbeEvaluation {
  return { probe, outcome: "ok", reason, observed };
}
function page(
  probe: ProbeName,
  observed: ProbeWireShapeObserved,
  reason: string,
): ProbeEvaluation {
  return { probe, outcome: "page", reason, observed };
}
function probeError(
  probe: ProbeName,
  observed: ProbeWireShapeObserved,
  reason: string,
): ProbeEvaluation {
  return { probe, outcome: "probe_error", reason, observed };
}

function asObject(v: unknown): Record<string, unknown> | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

/**
 * Evaluate a single probe. Pure: no I/O, no globals — every test
 * exercises a single probe state without setting up the full body.
 */
export function evaluateProbe(
  probe: ProbeName,
  body: ReadyzBody,
): ProbeEvaluation {
  const checks = asObject(body.checks) ?? {};
  const failures = asObject(body.failures) ?? {};
  const config = asObject(body.config);
  const dependencyProbes =
    config === null ? null : asObject(config.dependencyProbes);
  const probeConfigRaw =
    dependencyProbes === null ? undefined : dependencyProbes[probe];
  const probeConfig = asObject(probeConfigRaw);

  const observed: ProbeWireShapeObserved = {
    check: checks[probe],
    // `Object.prototype.hasOwnProperty.call` so we differentiate
    // "key absent" (the documented state on non-failed checks) from
    // "key present with value undefined" (a route-side regression).
    failure: Object.prototype.hasOwnProperty.call(failures, probe)
      ? (failures as Record<string, unknown>)[probe]
      : undefined,
    config: probeConfigRaw,
  };

  // -- always-run shape assertion on config.dependencyProbes.<name> --
  // The route assembles this block unconditionally; if it goes
  // missing we cannot trust ANY downstream assertion (we'd be
  // probing a body shape that's already broken), so escalate to
  // probe_error rather than picking a silent "page" interpretation.
  if (dependencyProbes === null) {
    return probeError(
      probe,
      observed,
      `body.config.dependencyProbes is missing or not an object — response-shape regression in routes/health.ts`,
    );
  }
  if (probeConfig === null) {
    return probeError(
      probe,
      observed,
      `body.config.dependencyProbes.${probe} is missing or not an object — the route stopped emitting the per-probe config sub-block`,
    );
  }
  if (typeof probeConfig.enabled !== "boolean") {
    return probeError(
      probe,
      observed,
      `body.config.dependencyProbes.${probe}.enabled is not a boolean (got ${typeof probeConfig.enabled}: ${JSON.stringify(probeConfig.enabled)}) — getDependencyProbeConfig type contract regressed`,
    );
  }
  if (typeof probeConfig.url !== "string" || probeConfig.url.length === 0) {
    return probeError(
      probe,
      observed,
      `body.config.dependencyProbes.${probe}.url is not a non-empty string (got ${JSON.stringify(probeConfig.url)}) — the documented base URL fallback regressed`,
    );
  }
  if (
    typeof probeConfig.timeoutMs !== "number" ||
    !Number.isFinite(probeConfig.timeoutMs) ||
    probeConfig.timeoutMs <= 0
  ) {
    return probeError(
      probe,
      observed,
      `body.config.dependencyProbes.${probe}.timeoutMs is not a positive finite number (got ${JSON.stringify(probeConfig.timeoutMs)}) — the parseTimeoutMs sanitisation regressed`,
    );
  }

  // -- enum assertion on checks.<name> --
  const check = observed.check;
  if (check !== "ok" && check !== "failed" && check !== "skipped") {
    return probeError(
      probe,
      observed,
      `checks.${probe} is not one of {"ok","failed","skipped"} (got ${JSON.stringify(check)}) — route-side regression in the per-probe assignment loop in routes/health.ts`,
    );
  }

  // -- per-state assertions --
  switch (check) {
    case "skipped":
      if (observed.failure !== undefined) {
        return page(
          probe,
          observed,
          `failures.${probe} is set on a skipped probe (got ${JSON.stringify(observed.failure)}) — a probe an operator opted out of is leaking a failure into the page surface`,
        );
      }
      if (probeConfig.enabled !== false) {
        return page(
          probe,
          observed,
          `config.dependencyProbes.${probe}.enabled is true on a skipped probe — the env-flag gating regressed (a typo'd value or default flipped to enabled), the in-incident escape hatch documented in the runbook would no longer disable the probe`,
        );
      }
      return ok(
        probe,
        observed,
        `checks.${probe}=skipped, config.enabled=false, no failures entry`,
      );
    case "ok":
      if (observed.failure !== undefined) {
        return page(
          probe,
          observed,
          `failures.${probe} is set on a probe whose check is "ok" (got ${JSON.stringify(observed.failure)}) — the route is leaking failure state across probe results`,
        );
      }
      if (probeConfig.enabled !== true) {
        return page(
          probe,
          observed,
          `config.dependencyProbes.${probe}.enabled is false on a probe whose check is "ok" — the route emitted a probe result for an env-disabled probe, defeating the opt-in contract`,
        );
      }
      return ok(
        probe,
        observed,
        `checks.${probe}=ok, config.enabled=true, no failures entry`,
      );
    case "failed":
      if (typeof observed.failure !== "string" || observed.failure.length === 0) {
        return probeError(
          probe,
          observed,
          `failures.${probe} is missing or not a non-empty string on a failed probe (got ${JSON.stringify(observed.failure)}) — the underlying error message was lost on its way to failures.<name> and the on-call would have nothing to act on`,
        );
      }
      if (probeConfig.enabled !== true) {
        return page(
          probe,
          observed,
          `config.dependencyProbes.${probe}.enabled is false on a failed probe — the route emitted a failure result for an env-disabled probe, defeating the opt-in contract`,
        );
      }
      // When the failure string CLAIMS a timeout, validate the
      // marker shape. A "raw aborted" or a marker missing the ms
      // suffix would silently break the log-aggregator queries on
      // `*_timeout_after_*ms` that the runbook documents — the
      // queries would no longer match this probe's timeouts and
      // on-call dashboards would silently lose a row.
      if (
        observed.failure.startsWith("http_probe_timeout_after_") &&
        !/^http_probe_timeout_after_\d+ms$/.test(observed.failure)
      ) {
        return probeError(
          probe,
          observed,
          `failures.${probe} claims a timeout but does not match the documented marker shape /^http_probe_timeout_after_\\d+ms$/ (got ${JSON.stringify(observed.failure)}) — log-aggregator queries on the "*_timeout_after_*ms" prefix would no longer match this probe's timeouts`,
        );
      }
      return ok(
        probe,
        observed,
        `checks.${probe}=failed, failures.${probe}=${JSON.stringify(observed.failure)}, config.enabled=true`,
      );
  }
}

export interface AggregateEvaluation {
  /** Highest-severity outcome across every probe — drives the exit
   *  code via `exitCodeFor`. */
  worstOutcome: ProbeOutcome;
  /** Per-probe evaluations in PROBES order. The cron wrapper
   *  serialises this verbatim into the structured stdout line so
   *  the page body says exactly which probes are wrong. */
  probes: ProbeEvaluation[];
}

/**
 * Pure aggregator: evaluate every probe on the readyz body and fold
 * the per-probe outcomes into a single worst-outcome decision.
 *
 * Severity ordering matches `checkReadyzConfig.ts`:
 *   probe_error > page > ok
 */
export function evaluateReadyzDependencyProbes(
  body: ReadyzBody,
): AggregateEvaluation {
  const probes: ProbeEvaluation[] = PROBES.map((probe) =>
    evaluateProbe(probe, body),
  );
  let worstOutcome: ProbeOutcome = "ok";
  for (const p of probes) {
    if (p.outcome === "probe_error") {
      worstOutcome = "probe_error";
      break;
    }
    if (p.outcome === "page") worstOutcome = "page";
  }
  return { worstOutcome, probes };
}

/**
 * Map an aggregate outcome to a process exit code. Centralised so
 * the test suite and the runner stay in sync; mirrors
 * `checkReadyzConfig.ts::exitCodeFor`.
 */
export function exitCodeFor(outcome: ProbeOutcome): 0 | 1 | 2 {
  if (outcome === "page") return 2;
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
type ProbeFetchResult = ProbeOk | ProbeErr;

/**
 * Fetch /readyz with an explicit timeout. Returns a discriminated
 * union rather than throwing so the caller can produce a structured
 * stderr line instead of a stack trace. Mirrors
 * `checkReadyzConfig.ts::fetchReadyz`.
 *
 * Crucially, this gate accepts BOTH a 200 ready response AND a 503
 * not_ready response: /readyz includes the `checks` / `failures` /
 * `config` blocks on both paths (so this gate can still page on a
 * wire-shape regression even while the replica is draining), and
 * gating on a 200 here would silently paper over the wire-shape
 * regression during a downstream outage — the worst-possible time
 * to lose the page.
 */
async function fetchReadyz(
  url: string,
  timeoutMs: number,
): Promise<ProbeFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
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
    return {
      ok: true,
      body: parsed as ReadyzBody,
      httpStatus: res.status,
    };
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
    fetchImpl?: (
      url: string,
      timeoutMs: number,
    ) => Promise<ProbeFetchResult>;
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
        check: "readyz_dependency_probe_wire_shape",
        outcome: "probe_error",
        url,
        error: probe.error,
        probeTimeoutMs,
      }),
    );
    return 1;
  }

  const result = evaluateReadyzDependencyProbes(probe.body);
  // The structured stdout line lists every probe with its outcome
  // so the page body identifies the regression without the on-call
  // having to manually diff /readyz. `ok` probes are included so
  // the page body distinguishes "everything wrong" from "one probe
  // wrong" at a glance.
  stdout(
    JSON.stringify({
      check: "readyz_dependency_probe_wire_shape",
      outcome: result.worstOutcome,
      probes: result.probes.map((p) => ({
        probe: p.probe,
        outcome: p.outcome,
        reason: p.reason,
        observed: p.observed,
      })),
      url,
      httpStatus: probe.httpStatus,
    }),
  );
  return exitCodeFor(result.worstOutcome);
}

const isDirectInvocation =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /checkReadyzDependencyProbeWireShape(\.[mc]?[jt]s)?$/.test(
    process.argv[1],
  );

if (isDirectInvocation) {
  void main().then(
    (code) => {
      process.exit(code);
    },
    (err: unknown) => {
      // Defensive: any unexpected throw exits 1 (probe error) rather
      // than 0, so the cron wrapper still sees a failure.
      process.stderr.write(
        `checkReadyzDependencyProbeWireShape crashed: ${(err as Error).message}\n`,
      );
      process.exit(1);
    },
  );
}
