/**
 * Production-shape detection for boot-time configuration checks.
 *
 * A growing family of boot-time guards (see
 * `routes/healthzRehearsal.ts` for the original — `assertRehearsalKillSwitchSafe`
 * and `assertProductionHostnamePatternConfigured`, and
 * `middlewares/apiRateLimit.ts` for `assertRateLimitStoreConfiguredForProduction`)
 * needs to answer the same question: "is this a production-shaped
 * deploy?" before it can decide whether a missing operator-only env
 * var is a real misconfiguration or just a benign staging boot.
 *
 * The signals are intentionally OR-ed together — any one of them is
 * sufficient to consider the deploy production-shaped — because a real
 * production environment can be missing any single one (e.g. an IaC
 * stack might set `DEPLOYMENT_ENVIRONMENT` but never touch `NODE_ENV`,
 * a Replit deployment sets `REPLIT_DEPLOYMENT=1` independently of
 * either, etc.). Requiring all of them would silently exempt a host
 * that's missing one signal from the boot check, which is the exact
 * misconfiguration the checks are meant to catch.
 *
 * Hostname matching (`PRODUCTION_HOSTNAME_PATTERN` + `HOSTNAME`) is
 * deliberately NOT included in `detectNonHostnameProductionSignals`.
 * Checks like `assertProductionHostnamePatternConfigured` exist
 * precisely to warn when the hostname pattern is missing on a
 * production deploy — using the hostname signal to decide
 * production-ness in those checks would be circular. Callers that
 * want the hostname signal too (e.g. `assertRehearsalKillSwitchSafe`,
 * carrier stub-fallback gating in `lib/fulfillment/*`) should call
 * `detectProductionSignals` / `isProductionEnvironment` below, which
 * layer the hostname check on top of the non-hostname signals.
 *
 * Task #83 audited the rest of the api-server for endpoints/feature
 * flags that gate behaviour on a single staging-only env var. Those
 * call sites use `isProductionEnvironment` so any future production
 * signal (new platform env var, additional hostname pattern, etc.)
 * only has to be added in one place.
 */

export interface ProductionSignal {
  /** Short identifier surfaced in the structured log + reason text. */
  signal: string;
  /** Human-readable detail (env var name + observed value). */
  detail: string;
}

export interface ProductionSignalLogSink {
  error: (obj: unknown, msg: string) => void;
}

/**
 * Returns the set of production-shape signals lit by the supplied env.
 *
 * Returns an empty array when no signal is set (i.e. the deploy is
 * staging / dev / preview / unknown — not production-shaped).
 *
 * Pure function so callers can unit-test their guard logic without
 * poisoning `process.env`.
 */
export function detectNonHostnameProductionSignals(
  env: NodeJS.ProcessEnv,
): ProductionSignal[] {
  const signals: ProductionSignal[] = [];

  if (env.NODE_ENV === "production") {
    signals.push({
      signal: "node_env",
      detail: "NODE_ENV=production",
    });
  }

  if (env.REPLIT_DEPLOYMENT === "1") {
    signals.push({
      signal: "replit_deployment",
      detail: "REPLIT_DEPLOYMENT=1 (Replit production deployment)",
    });
  }

  if (env.DEPLOYMENT_ENVIRONMENT === "production") {
    signals.push({
      signal: "deployment_environment",
      detail: "DEPLOYMENT_ENVIRONMENT=production",
    });
  }

  return signals;
}

/**
 * Module-level cache for the compiled hostname regex. Keyed on the
 * raw env value so a config change between calls is picked up, but
 * a stable raw value is parsed at most once per process. This also
 * bounds the "invalid pattern" error log to one line per unique
 * bad value rather than one line per request when this helper is
 * called from a hot path (e.g. carrier stub-fallback gating).
 */
interface HostnamePatternCacheEntry {
  raw: string | undefined;
  pattern: RegExp | null;
}
let hostnamePatternCache: HostnamePatternCacheEntry | null = null;

/**
 * Test-only: clear the compiled-regex cache between tests so a new
 * `PRODUCTION_HOSTNAME_PATTERN` value is recompiled and any "invalid
 * pattern" log assertion sees a fresh log call.
 */
export function __resetProductionEnvCacheForTests(): void {
  hostnamePatternCache = null;
}

/**
 * Compile the production-hostname regex from `PRODUCTION_HOSTNAME_PATTERN`.
 * An invalid pattern is treated as if no pattern were configured, but
 * we surface a structured warning so the operator notices that the
 * hostname check is silently disabled. We deliberately do NOT throw
 * here — a typo in the pattern shouldn't crash an otherwise-correct
 * production boot (NODE_ENV / REPLIT_DEPLOYMENT etc. would still trip
 * the guard if the kill switch were on).
 */
function compileHostnamePattern(
  raw: string | undefined,
  log: ProductionSignalLogSink,
): RegExp | null {
  if (hostnamePatternCache && hostnamePatternCache.raw === raw) {
    return hostnamePatternCache.pattern;
  }
  if (!raw || raw.trim() === "") {
    hostnamePatternCache = { raw, pattern: null };
    return null;
  }
  try {
    const compiled = new RegExp(raw);
    hostnamePatternCache = { raw, pattern: compiled };
    return compiled;
  } catch (err) {
    log.error(
      {
        production_hostname_pattern: raw,
        err: err instanceof Error ? err.message : String(err),
      },
      "production_hostname_pattern_invalid: PRODUCTION_HOSTNAME_PATTERN is not a valid regex; hostname check is disabled",
    );
    hostnamePatternCache = { raw, pattern: null };
    return null;
  }
}

/**
 * Return every production signal currently observed in `env`,
 * including the hostname-pattern signal layered on top of the
 * non-hostname signals.
 *
 * An empty list means the process is not running on a production-
 * looking deploy.
 *
 * Pure (apart from the once-per-bad-value `log.error` call when
 * `PRODUCTION_HOSTNAME_PATTERN` fails to compile, which is
 * intentional — operators must hear about a silently-disabled
 * defense-in-depth layer).
 */
export function detectProductionSignals(
  env: NodeJS.ProcessEnv,
  log: ProductionSignalLogSink,
): ProductionSignal[] {
  const signals = detectNonHostnameProductionSignals(env);

  const hostnamePattern = compileHostnamePattern(
    env.PRODUCTION_HOSTNAME_PATTERN,
    log,
  );
  const hostname = env.HOSTNAME;
  if (
    hostnamePattern &&
    typeof hostname === "string" &&
    hostname !== "" &&
    hostnamePattern.test(hostname)
  ) {
    signals.push({
      signal: "hostname",
      detail: `HOSTNAME=${hostname} matches PRODUCTION_HOSTNAME_PATTERN=${env.PRODUCTION_HOSTNAME_PATTERN}`,
    });
  }

  return signals;
}

/**
 * Convenience wrapper: true if any production signal is observed.
 * Intended for hot-path callers that don't need to enumerate the
 * triggered signals (e.g. a per-request "should I stub this?" check).
 */
export function isProductionEnvironment(
  env: NodeJS.ProcessEnv,
  log: ProductionSignalLogSink,
): boolean {
  return detectProductionSignals(env, log).length > 0;
}

/**
 * Tri-state status of `PRODUCTION_HOSTNAME_PATTERN` configuration —
 * mirrors the boot-time check `assertProductionHostnamePatternConfigured`
 * but is pure (no logging) so it can be safely called from hot paths
 * like the `/readyz` handler that the platform load balancer hits on
 * a tight cadence.
 *
 * The value is intended to be surfaced over the network (e.g. on
 * `/readyz`) so an external probe can verify the operator-configured
 * hostname backstop is in place on a production deploy without
 * shelling onto the box. See `scripts/checkProductionHostnamePattern.ts`
 * for the post-deploy verifier that consumes this signal.
 *
 * Values:
 *   - `"not_required"` — the deploy is not production-shaped (no
 *     non-hostname production signal lit). Staging / dev / preview
 *     environments don't need the backstop and the probe must treat
 *     a missing pattern as fine here.
 *   - `"configured"` — the deploy IS production-shaped AND
 *     `PRODUCTION_HOSTNAME_PATTERN` resolves to a non-empty value.
 *     Healthy state.
 *   - `"missing"` — the deploy IS production-shaped AND the env var
 *     is unset / empty / whitespace-only. The hostname backstop in
 *     `assertRehearsalKillSwitchSafe` is silently disabled and an
 *     external check should page on this so an operator notices
 *     within minutes of the deploy rather than waiting for a real
 *     outage.
 *
 * Note: a malformed regex (e.g. unbalanced bracket) still counts as
 * `"configured"` here — `compileHostnamePattern` already logs
 * `production_hostname_pattern_invalid` when the pattern fails to
 * parse, and emitting a second "missing" signal here would be
 * confusing (the operator DID set the env var, they just typo'd it).
 * The malformed-regex log is the actionable signal for that case.
 *
 * Pure function — takes `env` so callers can unit-test their probe
 * surface without poisoning `process.env`.
 */
export type ProductionHostnamePatternStatus =
  | "not_required"
  | "configured"
  | "missing";

export function getProductionHostnamePatternStatus(
  env: NodeJS.ProcessEnv,
): ProductionHostnamePatternStatus {
  const productionSignals = detectNonHostnameProductionSignals(env);
  if (productionSignals.length === 0) return "not_required";
  const raw = env.PRODUCTION_HOSTNAME_PATTERN;
  if (raw && raw.trim() !== "") return "configured";
  return "missing";
}

/**
 * Tri-state status of `HEALTHZ_REHEARSAL_ENABLED` configuration.
 *
 * The rehearsal injector (`/api/_rehearsal/*`) is staging-only — when
 * `HEALTHZ_REHEARSAL_ENABLED=1` is observed alongside any production
 * signal, the boot-time `assertRehearsalKillSwitchSafe` already
 * crash-loops the deploy. This status surfaces the *configuration*
 * itself on `/readyz` so an external probe can page on-call when the
 * dangerous combination is observed even before the next restart
 * (and so the post-deploy gate can verify "is this config sane?"
 * without waiting for the boot guard to bite).
 *
 * Values:
 *   - `"disabled"` — env var unset / not literal `"1"`. The injector
 *     route returns 404 in this state (via the runtime gate in
 *     `routes/healthzRehearsal.ts`); safe regardless of deploy shape.
 *   - `"enabled_non_production"` — `=1` on a non-production deploy.
 *     This is the intended state for staging — the rehearsal workflow
 *     deliberately flips the flag on staging so the GitHub Action can
 *     exercise the stuck-degraded probe end-to-end.
 *   - `"enabled_in_production"` — `=1` AND a production signal is
 *     lit. This is the dangerous combination; on-call must see this
 *     even though the boot guard would have already failed the
 *     deploy. A live read of /readyz catches the case where the env
 *     var was rotated post-boot via the platform UI without a
 *     restart.
 *
 * Pure function — takes `env` so the probe can be unit-tested
 * without poisoning `process.env`.
 */
export type RehearsalInjectorEnabledStatus =
  | "disabled"
  | "enabled_non_production"
  | "enabled_in_production";

export function getRehearsalInjectorEnabledStatus(
  env: NodeJS.ProcessEnv,
): RehearsalInjectorEnabledStatus {
  if (env.HEALTHZ_REHEARSAL_ENABLED !== "1") return "disabled";
  const productionSignals = detectNonHostnameProductionSignals(env);
  if (productionSignals.length === 0) return "enabled_non_production";
  return "enabled_in_production";
}

/**
 * Tri-state status of `STUB_FULFILLMENT` configuration.
 *
 * `STUB_FULFILLMENT=1` is the explicit escape hatch in
 * `lib/fulfillment/{gig,shipbubble,okhi}.ts` that allows the carrier
 * stub fallback to substitute synthetic quotes / labels / address
 * verifications when the real provider call fails. On a production
 * deploy with real credentials configured, that fallback would
 * silently charge buyers against shipments that don't exist (GIG /
 * Shipbubble) or pass an unverified address through the home-
 * delivery confidence gate (OkHi).
 *
 * Task #83 hardened the carriers to refuse the stub fallback in
 * production regardless of the env var, so the runtime impact is
 * already mitigated. This status surfaces the *misconfiguration
 * itself* — a staging→prod env-var copy-paste that left
 * `STUB_FULFILLMENT=1` set — so on-call sees the warning quickly
 * even though the runtime defence held.
 *
 * Values:
 *   - `"disabled"` — env var unset / not literal `"1"`. Carriers use
 *     the real provider path; safe regardless of deploy shape.
 *   - `"enabled_non_production"` — `=1` on a non-production deploy.
 *     This is the intended state for dev/CI where stub responses
 *     keep tests offline.
 *   - `"enabled_in_production"` — `=1` AND a production signal is
 *     lit. The runtime guard refuses the fallback, but the env var
 *     itself is wrong and should be unset on the next deploy. Page
 *     on-call so the misconfiguration is investigated rather than
 *     left as latent risk.
 */
export type StubFulfillmentEnabledStatus =
  | "disabled"
  | "enabled_non_production"
  | "enabled_in_production";

export function getStubFulfillmentEnabledStatus(
  env: NodeJS.ProcessEnv,
): StubFulfillmentEnabledStatus {
  if (env.STUB_FULFILLMENT !== "1") return "disabled";
  const productionSignals = detectNonHostnameProductionSignals(env);
  if (productionSignals.length === 0) return "enabled_non_production";
  return "enabled_in_production";
}

/**
 * Tri-state status of `SENTRY_DSN` configuration.
 *
 * `lib/sentry.ts` `initSentryServer()` installs a no-op shim when
 * `SENTRY_DSN` is unset — every `captureException` / `captureMessage`
 * silently drops on the floor. On a production deploy that's the
 * exact misconfiguration that turns "we paged on this last week"
 * into "nobody knew it happened": the rate-limit Redis breach event
 * (`rate_limit_redis_failure_threshold_breached`), the audit-chain
 * verification failure event, and every other Sentry-routed alert
 * silently no-ops. The other production-signal-aware checks already
 * page on this state via `/readyz`; surfacing it here is consistent
 * with the rest of the config block.
 *
 * Values:
 *   - `"configured"` — `SENTRY_DSN` is set to a non-empty value.
 *     Healthy regardless of deploy shape (dev / staging / production
 *     all benefit from the alerting layer).
 *   - `"not_required"` — env var unset on a non-production deploy.
 *     Dev/CI/preview environments don't need Sentry wired up; the
 *     `sentry_disabled_no_dsn` info-log on boot is the only signal
 *     and that's intentional.
 *   - `"missing"` — env var unset on a production-shaped deploy. The
 *     observability layer is silently disabled — page on-call so the
 *     deploy gets the DSN restored before the next real incident.
 */
export type SentryDsnStatus = "configured" | "not_required" | "missing";

export function getSentryDsnStatus(env: NodeJS.ProcessEnv): SentryDsnStatus {
  const raw = env.SENTRY_DSN;
  if (raw && raw.trim() !== "") return "configured";
  const productionSignals = detectNonHostnameProductionSignals(env);
  if (productionSignals.length === 0) return "not_required";
  return "missing";
}
