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
 * deliberately NOT included here. Checks like
 * `assertProductionHostnamePatternConfigured` exist precisely to warn
 * when the hostname pattern is missing on a production deploy — using
 * the hostname signal to decide production-ness in those checks would
 * be circular. Callers that want the hostname signal too (e.g.
 * `assertRehearsalKillSwitchSafe`) layer it on top of these signals.
 */

export interface ProductionSignal {
  /** Short identifier surfaced in the structured log + reason text. */
  signal: string;
  /** Human-readable detail (env var name + observed value). */
  detail: string;
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
