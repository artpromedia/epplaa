import {
  detectProductionSignals,
  type ProductionSignalLogSink,
} from "../productionSignals";

/**
 * Boot-time defense-in-depth guard for the carrier stub-fallback escape
 * hatch (`STUB_FULFILLMENT=1`).
 *
 * Why this exists (Task #88):
 * Task #83 already added a per-request guard inside each carrier
 * (`lib/fulfillment/{gig,okhi,shipbubble}.ts` `allowStubFallback`) that
 * refuses to substitute synthetic quotes / labels / addresses on
 * real-call failure when any production signal is observed, even if
 * `STUB_FULFILLMENT=1` is set. That layer is correct but reactive — a
 * misconfigured production deploy keeps booting and only surfaces the
 * misconfiguration the first time a real carrier call fails (which
 * could be hours or days after the deploy, by which point a buyer is
 * already mid-checkout). The per-request guard then throws on every
 * dispatch attempt rather than producing a single loud crash.
 *
 * This boot-time guard mirrors `assertRehearsalKillSwitchSafe`
 * (`routes/healthzRehearsal.ts`) so a misconfigured production deploy
 * crash-loops in the platform health check rather than waiting for the
 * first carrier failure to surface. Failing here turns a per-request
 * runtime guard into an additional technical control on the deploy
 * pipeline: the operator sees one clear log line at boot naming the
 * offending env var and pointing at the runbook, instead of a stream
 * of carrier-specific `*_failed_no_fallback` errors mid-checkout.
 *
 * Production signals (any one is sufficient):
 *   1. `NODE_ENV=production`
 *   2. `REPLIT_DEPLOYMENT=1` (Replit production deployment)
 *   3. `DEPLOYMENT_ENVIRONMENT=production`
 *   4. `HOSTNAME` matches the regex in `PRODUCTION_HOSTNAME_PATTERN`
 *
 * Pure function — takes `env` and a `log` sink so the unit test can
 * exercise both the staging-allowed and production-rejected paths
 * without poisoning `process.env` or piping pino output. Returns the
 * outcome instead of calling `process.exit` so the caller (and the
 * test) controls termination, mirroring the rest of the boot-guard
 * family.
 */
export type StubFulfillmentBootGuardOutcome =
  | { ok: true }
  | { ok: false; reason: string };

export function assertStubFulfillmentSafe(
  env: NodeJS.ProcessEnv,
  log: ProductionSignalLogSink,
): StubFulfillmentBootGuardOutcome {
  // Only the literal "1" trips the kill switch — same convention as
  // `STUB_FULFILLMENT` matching inside the per-request carrier guards
  // and as `HEALTHZ_REHEARSAL_ENABLED` in the rehearsal boot guard. A
  // leftover `STUB_FULFILLMENT=0` (or "true" / "yes") must not block
  // a legitimate production boot.
  if (env.STUB_FULFILLMENT !== "1") return { ok: true };

  const signals = detectProductionSignals(env, log);
  if (signals.length === 0) return { ok: true };

  const signalDetails = signals.map((s) => s.detail).join("; ");
  const reason =
    "STUB_FULFILLMENT=1 must never be set on a production deploy. " +
    `Detected production signal(s): ${signalDetails}. ` +
    "The carrier stub-fallback escape hatch is staging-only — see " +
    "docs/runbooks/staging-only-endpoints.md (boot-time guard). " +
    "Unset STUB_FULFILLMENT on this deploy and restart.";
  log.error(
    {
      node_env: env.NODE_ENV,
      hostname: env.HOSTNAME,
      production_hostname_pattern: env.PRODUCTION_HOSTNAME_PATTERN,
      replit_deployment: env.REPLIT_DEPLOYMENT,
      deployment_environment: env.DEPLOYMENT_ENVIRONMENT,
      stub_fulfillment: env.STUB_FULFILLMENT,
      production_signals: signals.map((s) => s.signal),
    },
    `stub_fulfillment_kill_switch_on_in_production: ${reason}`,
  );
  return { ok: false, reason };
}
