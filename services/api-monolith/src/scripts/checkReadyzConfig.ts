/**
 * checkReadyzConfig — post-deploy / scheduled verifier that pages
 * on-call when ANY high-risk operator-set boot-time setting is in a
 * dangerous state on a production-shaped api-server deploy.
 *
 * Why this exists (task #101):
 * The original `checkProductionHostnamePattern` probe (task #89) only
 * paged on `PRODUCTION_HOSTNAME_PATTERN` being unset on a production
 * deploy. That was the right minimum bar at the time, but four other
 * boot-time settings carry similar latent-risk profiles:
 *
 *   1. `HEALTHZ_REHEARSAL_ENABLED=1` on production (the rehearsal
 *      injector arms a synthetic-failure surface that would corrupt
 *      real /healthz signals if it leaks into a prod replica).
 *   2. `STUB_FULFILLMENT=1` on production (the carrier stub fallback
 *      is the misconfiguration the boot guard in task #83 hardened
 *      against — the runtime guard refuses the fallback, but the env
 *      var itself being set is still a deploy hygiene issue).
 *   3. Rate-limit store on memory in production without an explicit
 *      `RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION=1` opt-out (the
 *      effective per-user rate limit becomes N×replicas; auth-gate
 *      brute-force protection is silently weakened).
 *   4. `SENTRY_DSN` unset on production (the no-op Sentry shim
 *      silently drops every captureException — the rate-limit Redis
 *      breach event, audit-chain verification failures, and every
 *      other Sentry-routed alert no-op).
 *
 * Each of those settings has a boot-time guard that already
 * crash-loops the dangerous combination on a clean restart — but
 * a hot env-var rotation, a platform-side env-var change without
 * restart, or an emergency rollback via the platform UI that
 * skipped the boot guard can still leave a running replica in the
 * dangerous state. This probe turns the readyz `config` block into
 * an actionable external check by polling every field independently
 * and exiting non-zero when ANY setting is in a paging combination —
 * not just hostname pattern.
 *
 * Why /readyz and not /healthz: /readyz already runs operator-only
 * checks (DB + Redis reachability) and was the natural surface for
 * the config block in task #89. Reusing the same body avoids a
 * second probe endpoint and keeps the staging-only-endpoints runbook
 * focused on a single contract. The config block is informational —
 * it does NOT influence the ready/not_ready decision; this probe
 * runs out-of-band of normal request handling so a paged warning
 * never affects user traffic.
 *
 * Why not delete the old `checkProductionHostnamePattern` probe:
 * `.github/workflows/check-production-hostname-pattern.yml` already
 * wires the old probe into a schedule; removing it would silently
 * drop the existing alert until the new workflow lands. The old
 * probe is intentionally left in place as a narrowly-scoped
 * single-field check. New deployments should wire the generalised
 * probe instead — see the runbook.
 *
 * Usage (CI cron, post-deploy step, ad-hoc verify):
 *
 *   READYZ_URL=https://api.example.com/api/readyz \
 *     pnpm --filter @workspace/api-server exec tsx \
 *       src/scripts/checkReadyzConfig.ts
 *
 * Exit codes (matches `checkProductionHostnamePattern.ts` /
 * `checkHealthzDegraded.ts` conventions so the surrounding cron
 * wrapper can wire alerting on "any non-zero" without distinguishing,
 * and a human triaging the failure can read intent from the code):
 *   0  every field is in a non-paging state — production deploy is
 *      healthy OR non-production deploy where most fields default to
 *      a non-required value
 *   1  probe error: network failure, non-2xx body that won't parse,
 *      missing config block, or a config field is in an unrecognised
 *      shape (response-shape regression — escalate rather than
 *      silently treating it as healthy)
 *   2  page on-call: at least ONE field is in a paging state. The
 *      structured stdout line lists every paging field so the page
 *      body says exactly which env vars are wrong rather than just
 *      "something is wrong" — the on-call doesn't have to manually
 *      diff /readyz to identify the misconfiguration.
 */

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/**
 * Sanitise a numeric env var. Mirrors the helper in
 * `checkProductionHostnamePattern.ts` / `checkHealthzDegraded.ts` so
 * a typo doesn't silently turn the timeout into either a fire-
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
 * Shape of the relevant slice of the `/readyz` response. Kept narrow
 * (only the `config` block this probe needs) so a future addition
 * to the response body — e.g. yet another boot-time-config check, a
 * new dependency check — doesn't require a code change here. The
 * config block fields are typed as `unknown` so the per-field
 * evaluator can defensively reject unrecognised values rather than
 * silently passing them through as "not paging".
 */
export interface ReadyzConfigBlockShape {
  productionHostnamePattern?: unknown;
  rehearsalInjectorEnabled?: unknown;
  stubFulfillmentEnabled?: unknown;
  rateLimitStore?: unknown;
  sentryDsn?: unknown;
  // Task #103 — generalised post-deploy gate now also covers every
  // remaining operator-set boot-time secret / provider whose
  // missing-on-production state is page-worthy.
  mfaEncryptionKey?: unknown;
  clerkSecretKey?: unknown;
  termiiApiKey?: unknown;
  moderationProvider?: unknown;
  sanctionsProvider?: unknown;
  [k: string]: unknown;
}
export interface ReadyzBody {
  config?: ReadyzConfigBlockShape | unknown;
  [k: string]: unknown;
}

/**
 * Per-field outcome enum. Every helper returns one of these so the
 * top-level evaluator can fold the matrix into a single exit code +
 * a structured per-field stdout line. The values are aligned across
 * fields so the surrounding cron / alert transformer can pivot on
 * the field name and outcome together (e.g. "missing on hostname",
 * "enabled_in_production on rehearsal").
 *
 * Mapping to exit code — see `outcomeIsPaging`:
 *   page              -> exit 2 (page on-call)
 *   probe_error       -> exit 1 (response-shape regression / probe
 *                                itself failed)
 *   ok / informational-> exit 0 (silent)
 */
export type FieldOutcome =
  | "ok"
  | "page"
  | "probe_error";

/**
 * The closed set of fields the probe evaluates. Keeping it as a
 * literal union (rather than `string`) means a typo'd field name
 * in the matrix below is a TypeScript error, not a silent dropped
 * check.
 */
export type FieldName =
  | "productionHostnamePattern"
  | "rehearsalInjectorEnabled"
  | "stubFulfillmentEnabled"
  | "rateLimitStore"
  | "sentryDsn"
  | "mfaEncryptionKey"
  | "clerkSecretKey"
  | "termiiApiKey"
  | "moderationProvider"
  | "sanctionsProvider";

export interface FieldEvaluation {
  field: FieldName;
  outcome: FieldOutcome;
  /** Human-readable reason — included verbatim in the structured log
   *  line so the on-call page body explains *why* it fired. */
  reason: string;
  /** The raw value observed at `body.config[field]`, preserved for
   *  log triage when the value is unrecognised. */
  observed: unknown;
}

/**
 * Per-field evaluator matrix. Each entry maps the closed set of
 * known status values to either `ok` (silent) or `page` (exit 2).
 * Any value not in the entry's known-set degrades to `probe_error`
 * (exit 1) so a /readyz response-shape regression escalates rather
 * than silently treats an unknown value as healthy.
 *
 * Each entry also carries a `pageReason` template — a tightly
 * scoped sentence the cron / Sentry transformer can copy verbatim
 * into the page body so the on-call sees *which env var* to fix and
 * *which runbook section* to consult, without having to cross-
 * reference the readyz body manually.
 */
interface FieldRule {
  /** Status values that are considered healthy / non-paging. */
  okValues: readonly string[];
  /** Status values that should page on-call. Each maps to its own
   *  reason string so e.g. `memory_misconfigured` and
   *  `enabled_in_production` are not collapsed into a single message. */
  pageValues: Readonly<Record<string, string>>;
}

const FIELD_RULES: Readonly<Record<FieldName, FieldRule>> = {
  productionHostnamePattern: {
    okValues: ["configured", "not_required"],
    pageValues: {
      missing:
        "PRODUCTION_HOSTNAME_PATTERN is unset on this production deploy — the hostname backstop in assertRehearsalKillSwitchSafe is silently disabled. Set the env var on the production deploy and restart. See docs/runbooks/staging-only-endpoints.md.",
    },
  },
  rehearsalInjectorEnabled: {
    okValues: ["disabled", "enabled_non_production"],
    pageValues: {
      enabled_in_production:
        "HEALTHZ_REHEARSAL_ENABLED=1 is set on this production deploy — the synthetic-failure injector would corrupt real /healthz signals. Unset HEALTHZ_REHEARSAL_ENABLED on the production deploy and restart. See docs/runbooks/staging-only-endpoints.md.",
    },
  },
  stubFulfillmentEnabled: {
    okValues: ["disabled", "enabled_non_production"],
    pageValues: {
      enabled_in_production:
        "STUB_FULFILLMENT=1 is set on this production deploy — the carrier stub fallback is a deploy-hygiene misconfiguration even though the runtime guard (task #83) refuses the fallback. Unset STUB_FULFILLMENT on the production deploy and restart. See docs/runbooks/staging-only-endpoints.md.",
    },
  },
  rateLimitStore: {
    // `memory_opt_out_acknowledged` is intentionally NOT a page
    // condition — single-replica production canaries explicitly opt
    // into the in-process bucket via
    // RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION=1, mirroring the
    // boot-time warn-vs-error distinction.
    okValues: ["redis", "memory_not_required", "memory_opt_out_acknowledged"],
    pageValues: {
      memory_misconfigured:
        "Rate-limit store is in-process memory on this production deploy without RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION=1 opt-out — per-user rate limits become N×replicas and the auth-gate brute-force protection is silently weakened. Either set RATE_LIMIT_STORE=redis (preferred) or, if this deploy is single-replica by design, set RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION=1 and restart. See docs/runbooks/staging-only-endpoints.md.",
    },
  },
  sentryDsn: {
    okValues: ["configured", "not_required"],
    pageValues: {
      missing:
        "SENTRY_DSN is unset on this production deploy — every captureException / captureMessage silently drops, including the rate-limit Redis breach event, audit-chain verification failures, and every other Sentry-routed alert. Set SENTRY_DSN on the production deploy and restart. See docs/runbooks/staging-only-endpoints.md.",
    },
  },
  // Task #103 — five additional fields covering the remaining
  // operator-set boot-time secrets / providers whose missing-on-
  // production state is page-worthy. Each rule mirrors the matching
  // `assertXxxConfiguredForProduction` helper's failure mode: the
  // page text names the env var the operator must set AND points
  // back at the runbook so the on-call sees exactly what to fix
  // without diffing /readyz manually.
  mfaEncryptionKey: {
    okValues: ["configured", "not_required"],
    pageValues: {
      missing:
        "MFA_ENCRYPTION_KEY is unset on this production deploy — TOTP secrets are encrypted under a SESSION_SECRET-derived fallback key (only enforced when NODE_ENV=production; other production-shape signals would silently use the fallback). Set MFA_ENCRYPTION_KEY (32+ random bytes, base64 / hex) on the production deploy and restart. See docs/runbooks/staging-only-endpoints.md.",
    },
  },
  clerkSecretKey: {
    okValues: ["configured", "not_required"],
    pageValues: {
      missing:
        "CLERK_SECRET_KEY is unset on this production deploy — the Clerk Frontend API proxy passes through unauthenticated, /auth/otp/verify returns the noClerk:true stub, and Socket.IO connections silently join as anonymous viewers. Set CLERK_SECRET_KEY on the production deploy and restart. See docs/runbooks/staging-only-endpoints.md.",
    },
  },
  termiiApiKey: {
    okValues: ["configured", "not_required"],
    pageValues: {
      missing:
        "TERMII_API_KEY is unset on this production deploy — the Termii adapter logs and returns success without sending the SMS, AND the OTP issuer flips into devEcho mode (the OTP code is returned in the API response, trivially bypassing phone verification). Set TERMII_API_KEY on the production deploy and restart. See docs/runbooks/staging-only-endpoints.md.",
    },
  },
  moderationProvider: {
    okValues: ["configured", "not_required"],
    pageValues: {
      missing:
        "MODERATION_PROVIDER is unset / stub / set-but-deps-missing / set-to-unknown-value on this production deploy — every uploaded image / stream poster / chat message silently bypasses real moderation. Set MODERATION_PROVIDER=hive (with HIVE_API_KEY) or MODERATION_PROVIDER=sightengine (with SIGHTENGINE_API_USER, SIGHTENGINE_API_SECRET, and PHOTODNA_API_KEY for NCMEC-grade CSAM hash matching) on the production deploy and restart. See docs/runbooks/staging-only-endpoints.md.",
    },
  },
  sanctionsProvider: {
    okValues: ["configured", "not_required"],
    pageValues: {
      missing:
        "SANCTIONS_PROVIDER is unset or set to stub on this production deploy — screenSubject() fail-closes every screen to status=blocked, halting every payout until a real provider is wired. Set SANCTIONS_PROVIDER to a real provider value on the production deploy (and ensure the matching dispatch in screenSubject() is wired) and restart. See docs/runbooks/staging-only-endpoints.md.",
    },
  },
};

/**
 * Evaluate a single field by looking up its rule and matching the
 * observed value. Pure: no I/O, no globals — every test exercises
 * a single rule entry without setting up the full probe.
 */
export function evaluateField(
  field: FieldName,
  observed: unknown,
): FieldEvaluation {
  const rule = FIELD_RULES[field];
  if (typeof observed !== "string") {
    return {
      field,
      outcome: "probe_error",
      reason: `unrecognised type at config.${field} (got ${typeof observed}: ${JSON.stringify(observed)}) — response-shape regression`,
      observed,
    };
  }
  if (rule.okValues.includes(observed)) {
    return {
      field,
      outcome: "ok",
      reason: `config.${field}=${observed}`,
      observed,
    };
  }
  const pageReason = rule.pageValues[observed];
  if (pageReason !== undefined) {
    return {
      field,
      outcome: "page",
      reason: pageReason,
      observed,
    };
  }
  return {
    field,
    outcome: "probe_error",
    reason: `unrecognised value at config.${field} (got ${JSON.stringify(observed)}) — response-shape regression`,
    observed,
  };
}

export interface AggregateEvaluation {
  /** Highest-severity outcome across every field — drives the exit
   *  code via `exitCodeFor`. */
  worstOutcome: FieldOutcome;
  /** Per-field evaluations in field-name order. The cron wrapper
   *  serialises this verbatim into the structured stdout line so
   *  the page body says exactly which fields are wrong. */
  fields: FieldEvaluation[];
}

/**
 * Pure aggregator: evaluate every field on the readyz body and
 * fold the per-field outcomes into a single worst-outcome decision.
 *
 * Severity ordering (worst-wins so a single misconfigured field
 * still pages even when others are healthy):
 *   probe_error > page > ok
 *
 * `probe_error` is intentionally ranked above `page` because an
 * unrecognised /readyz shape means the probe itself can't make a
 * trustworthy decision — escalating to "probe error" is more
 * informative than silently picking one interpretation. The cron
 * wrapper still pages on either non-zero, so the operator sees both
 * regardless; the distinction matters for log triage.
 */
export function evaluateReadyz(body: ReadyzBody): AggregateEvaluation {
  const config = body.config;
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return {
      worstOutcome: "probe_error",
      fields: (Object.keys(FIELD_RULES) as FieldName[]).map((field) => ({
        field,
        outcome: "probe_error" as const,
        reason:
          "/readyz body is missing the `config` block (or it is not an object) — the api-server we probed is serving an unexpected response shape",
        observed: undefined,
      })),
    };
  }
  const fields: FieldEvaluation[] = (
    Object.keys(FIELD_RULES) as FieldName[]
  ).map((field) =>
    evaluateField(field, (config as ReadyzConfigBlockShape)[field]),
  );

  let worstOutcome: FieldOutcome = "ok";
  for (const f of fields) {
    if (f.outcome === "probe_error") {
      worstOutcome = "probe_error";
      break;
    }
    if (f.outcome === "page") worstOutcome = "page";
  }
  return { worstOutcome, fields };
}

/**
 * Map an aggregate outcome to a process exit code. Centralised so
 * the test suite and the runner stay in sync; mirrors
 * `checkProductionHostnamePattern.ts::exitCodeFor`.
 */
export function exitCodeFor(outcome: FieldOutcome): 0 | 1 | 2 {
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
type ProbeResult = ProbeOk | ProbeErr;

/**
 * Fetch /readyz with an explicit timeout. Returns a discriminated
 * union rather than throwing so the caller can produce a structured
 * stderr line instead of a stack trace.
 *
 * Crucially, this probe accepts BOTH a 200 ready response AND a 503
 * not_ready response: /readyz includes the `config` block on both
 * paths (so this check can still page on misconfiguration even
 * while the replica is draining), and gating on a 200 here would
 * silently paper over the misconfiguration during a downstream
 * outage — the worst-possible time to lose the page.
 */
async function fetchReadyz(
  url: string,
  timeoutMs: number,
): Promise<ProbeResult> {
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
        check: "readyz_config",
        outcome: "probe_error",
        url,
        error: probe.error,
        probeTimeoutMs,
      }),
    );
    return 1;
  }

  const result = evaluateReadyz(probe.body);
  // The structured stdout line lists every paging / errored field
  // so the page body identifies the misconfiguration without the
  // on-call having to manually diff /readyz. `ok` fields are
  // included so the page body distinguishes "everything wrong" from
  // "one field wrong" at a glance.
  stdout(
    JSON.stringify({
      check: "readyz_config",
      outcome: result.worstOutcome,
      fields: result.fields.map((f) => ({
        field: f.field,
        outcome: f.outcome,
        reason: f.reason,
        observed: f.observed,
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
  /checkReadyzConfig(\.[mc]?[jt]s)?$/.test(process.argv[1]);

if (isDirectInvocation) {
  void main().then(
    (code) => {
      process.exit(code);
    },
    (err: unknown) => {
      // Defensive: any unexpected throw exits 1 (probe error) rather
      // than 0, so the cron wrapper still sees a failure.
      process.stderr.write(
        `checkReadyzConfig crashed: ${(err as Error).message}\n`,
      );
      process.exit(1);
    },
  );
}
