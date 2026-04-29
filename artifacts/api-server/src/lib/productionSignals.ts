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
