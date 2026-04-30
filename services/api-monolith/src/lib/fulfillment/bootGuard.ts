import {
  detectProductionSignals,
  type ProductionSignalLogSink,
} from "../productionSignals";

/**
 * Per-carrier opt-out env vars consumed by
 * `assertCarrierCredentialsConfiguredForProduction` (Task #99).
 *
 * Setting one of these to the literal "1" tells the boot guard that
 * the operator has *intentionally* shipped this production deploy
 * without that carrier (e.g. GIG not yet contracted), so missing
 * credentials must NOT crash-loop the boot. Same strictness as
 * `STUB_FULFILLMENT=1` / `REPLIT_DEPLOYMENT=1`: anything other than
 * the literal "1" is treated as "not opted out" so a typo can't
 * silently bypass the check.
 *
 * Exported so the runtime carrier registry / quote aggregator can
 * read the same set when it grows the matching "skip disabled
 * carrier" hook (out of scope for Task #99 — the boot guard is the
 * deliberate first step).
 */
export const CARRIER_DISABLE_ENV_VARS = {
  shipbubble: "DISABLE_CARRIER_SHIPBUBBLE",
  gig: "DISABLE_CARRIER_GIG",
  okhi: "DISABLE_CARRIER_OKHI",
} as const;

/**
 * Per-carrier credential schema consumed by
 * `assertCarrierCredentialsConfiguredForProduction`. Each entry lists
 * the env vars whose presence is required for that carrier's
 * `isConfigured()` check (in `lib/fulfillment/{shipbubble,gig,okhi}.ts`)
 * to return true. Missing any of these on a production deploy means
 * `isConfigured()` returns false and the carrier silently short-
 * circuits to its stub path WITHOUT consulting the per-request
 * production-signal guard — exactly the threat model Task #99
 * addresses.
 *
 * Intentionally narrower than `assertShipbubbleConfiguredForProduction`
 * (which also warns about SHIPBUBBLE_SENDER_CODE / SHIPBUBBLE_WEBHOOK_SECRET).
 * Those two have downstream impact (real dispatches 4xx / inbound
 * webhooks silently dropped) but neither flips `isConfigured()` from
 * true to false, so they are still warn-only via the existing
 * `assertShipbubbleConfiguredForProduction` helper. THIS check is
 * the hard-fail subset — only the env vars that gate the
 * stub-fallback short-circuit.
 */
const CARRIER_REQUIRED_ENV_VARS = {
  shipbubble: ["SHIPBUBBLE_API_KEY"],
  gig: ["GIG_API_KEY", "GIG_USERNAME"],
  okhi: ["OKHI_API_KEY", "OKHI_BRANCH_ID"],
} as const satisfies Record<
  keyof typeof CARRIER_DISABLE_ENV_VARS,
  readonly string[]
>;

type CarrierCode = keyof typeof CARRIER_DISABLE_ENV_VARS;

const CARRIER_CODES: readonly CarrierCode[] = [
  "shipbubble",
  "gig",
  "okhi",
];

/**
 * Boot-time hard-fail guard for missing carrier credentials on a
 * production deploy (Task #99).
 *
 * Why this exists:
 * Task #88's `assertStubFulfillmentSafe` (above) closes the
 * "STUB_FULFILLMENT=1 leaked into production" half of the synthetic-
 * data threat model. The other half is still open: if a production
 * deploy boots with `STUB_FULFILLMENT` *unset* AND the carrier
 * credentials themselves are unset (`SHIPBUBBLE_API_KEY`,
 * `GIG_API_KEY` + `GIG_USERNAME`, `OKHI_API_KEY` + `OKHI_BRANCH_ID`),
 * each carrier's `isConfigured()` returns false. The runtime quote /
 * dispatch / verify path then short-circuits straight into the stub
 * (`return this.stubQuotes(req)` etc.) BEFORE the per-request
 * `allowStubFallback()` production-signal guard ever runs — there
 * is no real-call failure to trigger the guard. Buyers see fake
 * quotes, ship under fake tracking numbers, and pass an unverified
 * address through the home-delivery confidence gate. The mistake
 * only surfaces when the courier never picks up or the buyer
 * reports the bad address.
 *
 * The existing `assertShipbubbleConfiguredForProduction` /
 * `assertOkHiConfiguredForProduction` helpers WARN about the same
 * env vars but don't crash the boot. That was deliberate when those
 * checks were added (some early production deploys legitimately
 * shipped without a given carrier), but the warning-only path means
 * a Sentry alert that isn't wired or is muted lets the
 * misconfiguration sit in production indefinitely. Crash-fast turns
 * the warning into a deploy-blocking technical control.
 *
 * Operators that intentionally want to ship a production deploy
 * without a given carrier (e.g. GIG not yet contracted, OkHi
 * disabled while the country is still in beta) MUST opt out
 * explicitly via the per-carrier env var
 * `DISABLE_CARRIER_{SHIPBUBBLE,GIG,OKHI}=1`. The implicit "no
 * creds = stub" path that exists today is exactly the silent-
 * degradation mode this guard exists to close.
 *
 * Mirrors the shape of `assertStubFulfillmentSafe` and
 * `assertRateLimitStoreConfiguredForProduction`: pure function over
 * `env` and a `log` sink, returns the outcome instead of calling
 * `process.exit` so the caller (and the test) controls termination.
 */
export type CarrierCredentialsBootGuardOutcome =
  | { ok: true }
  | { ok: false; reason: string };

interface CarrierMisconfig {
  carrier: CarrierCode;
  missing: string[];
}

export function assertCarrierCredentialsConfiguredForProduction(
  env: NodeJS.ProcessEnv,
  log: ProductionSignalLogSink,
): CarrierCredentialsBootGuardOutcome {
  const signals = detectProductionSignals(env, log);
  if (signals.length === 0) {
    // Not a production-shaped deploy. The implicit stub path on
    // dev/staging/CI is by design — those flows must work without
    // real carrier accounts.
    return { ok: true };
  }

  const misconfigured: CarrierMisconfig[] = [];
  for (const carrier of CARRIER_CODES) {
    // Explicit per-carrier opt-out — operator has accepted that this
    // deploy ships without the carrier. Skip the credential check
    // entirely so boot proceeds. Strict literal "1" match (mirrors
    // STUB_FULFILLMENT / REPLIT_DEPLOYMENT) so a typo like "true" /
    // "yes" can't silently bypass the boot failure.
    if (env[CARRIER_DISABLE_ENV_VARS[carrier]] === "1") continue;

    const required = CARRIER_REQUIRED_ENV_VARS[carrier];
    const missing = required.filter((name) => {
      const v = env[name];
      return !v || v.trim() === "";
    });
    if (missing.length > 0) {
      misconfigured.push({ carrier, missing });
    }
  }

  if (misconfigured.length === 0) return { ok: true };

  const signalDetails = signals.map((s) => s.detail).join("; ");
  const carrierDetails = misconfigured
    .map(
      (m) =>
        `${m.carrier} (missing ${m.missing.join(" + ")}; opt out via ` +
        `${CARRIER_DISABLE_ENV_VARS[m.carrier]}=1 if intentional)`,
    )
    .join("; ");
  const reason =
    "Carrier credentials missing on this production deploy: " +
    `${carrierDetails}. Without these env vars each carrier's ` +
    "isConfigured() returns false and quote/dispatch/verify short-" +
    "circuits straight to the stub path BEFORE the per-request " +
    "production-signal guard runs — buyers would be charged against " +
    "fake shipments / fake address verifications. " +
    `Detected production signal(s): ${signalDetails}. ` +
    "Set the missing env var(s), or set " +
    "DISABLE_CARRIER_{SHIPBUBBLE,GIG,OKHI}=1 to ship without a given " +
    "carrier — see docs/runbooks/staging-only-endpoints.md " +
    "(boot-time carrier credentials guard).";
  log.error(
    {
      node_env: env.NODE_ENV,
      hostname: env.HOSTNAME,
      production_hostname_pattern: env.PRODUCTION_HOSTNAME_PATTERN,
      replit_deployment: env.REPLIT_DEPLOYMENT,
      deployment_environment: env.DEPLOYMENT_ENVIRONMENT,
      production_signals: signals.map((s) => s.signal),
      carriers_misconfigured: misconfigured.map((m) => ({
        carrier: m.carrier,
        missing: m.missing,
        opt_out_env_var: CARRIER_DISABLE_ENV_VARS[m.carrier],
      })),
    },
    `carrier_credentials_missing_for_production: ${reason}`,
  );
  return { ok: false, reason };
}

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
