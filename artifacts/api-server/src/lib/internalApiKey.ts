import { detectNonHostnameProductionSignals } from "./productionSignals";

/**
 * Boot-time sanity check: production deploys MUST set
 * `INTERNAL_API_KEY`.
 *
 * `INTERNAL_API_KEY` is the shared bearer for cross-service callers
 * on three sets of routes:
 *
 *   - `routes/pudo.ts` — PUDO partner manifest / scan webhooks (the
 *     fallback when no per-partner API key is configured in
 *     `pudoPartnersTable`). Without it, partner integrations fall
 *     back to the per-partner key and any request that doesn't
 *     match one returns 403.
 *   - `routes/promos.ts` — promo activation webhooks. Each route
 *     returns `503 not_configured` when the key is unset.
 *   - `routes/referrals.ts` — `/referrals/payout` settlement
 *     webhooks. Same `503 not_configured` behaviour.
 *
 * The 503-on-unset is fail-closed (the routes refuse to authorize
 * any caller, rather than authorizing everyone), so the
 * misconfiguration is **not silently exploitable** — but the failure
 * mode is "every cross-service webhook into the api-server starts
 * 503-ing". Promos don't activate, referrals don't pay out, PUDO
 * partner scans don't reach the order. The 503 looks like a normal
 * fail-closed response from the partner's perspective; on-call only
 * finds out when a partner complains or when downstream metrics
 * (e.g. promo redemption count) drop to zero.
 *
 * Modelled on the other `assertXxxConfiguredForProduction` helpers
 * (see `docs/runbooks/production-secrets.md`). Warning, not a hard
 * failure — the per-route `503 not_configured` at the consumer site
 * is still the authoritative fail-closed control. Operators wire a
 * Sentry / log-aggregator alert on the
 * `internal_api_key_missing_for_production` message tag.
 *
 * Pure function — takes `env` and a `log` sink so the unit test can
 * exercise the staging-skipped, production-warned, and configured-
 * silent paths without poisoning `process.env` or piping pino output.
 */
export type InternalApiKeyConfigOutcome =
  | { ok: true }
  | { ok: false; reason: string };

export function assertInternalApiKeyConfiguredForProduction(
  env: NodeJS.ProcessEnv,
  log: { warn: (obj: unknown, msg: string) => void },
): InternalApiKeyConfigOutcome {
  const productionSignals = detectNonHostnameProductionSignals(env);
  if (productionSignals.length === 0) return { ok: true };
  const raw = env.INTERNAL_API_KEY;
  if (raw && raw.trim() !== "") return { ok: true };
  const signalDetails = productionSignals.map((s) => s.detail).join("; ");
  const reason =
    "INTERNAL_API_KEY is not set on this production deploy. The cross-" +
    "service webhook routes /pudo, /promos, and /referrals/payout will " +
    "all return 503 not_configured to every caller. The misconfiguration " +
    "is fail-closed (no auth bypass) but partner integrations stop " +
    "working until the key is set — promos don't activate, referrals " +
    "don't pay out, PUDO partner scans don't reach orders. " +
    `Detected production signal(s): ${signalDetails}. ` +
    "Set INTERNAL_API_KEY — see docs/runbooks/production-secrets.md " +
    "(INTERNAL_API_KEY section).";
  log.warn(
    {
      node_env: env.NODE_ENV,
      replit_deployment: env.REPLIT_DEPLOYMENT,
      deployment_environment: env.DEPLOYMENT_ENVIRONMENT,
      internal_api_key: raw ? "[set-but-empty]" : null,
      production_signals: productionSignals.map((s) => s.signal),
    },
    `internal_api_key_missing_for_production: ${reason}`,
  );
  return { ok: false, reason };
}
