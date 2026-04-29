import { detectNonHostnameProductionSignals } from "./productionSignals";

/**
 * Boot-time sanity check: production deploys MUST set `SESSION_SECRET`
 * to a value of at least 16 characters.
 *
 * `SESSION_SECRET` is the HMAC / encryption key for several security-
 * critical primitives that all read it lazily from `process.env`:
 *
 *   - `lib/kyc.ts deriveDocKey` — encrypts uploaded KYC documents at
 *     rest under AES-256-GCM. Throws `"SESSION_SECRET must be set and
 *     >= 16 chars to encrypt KYC documents"` on every upload until
 *     the secret is configured. Boot-time the deploy looks healthy;
 *     the next KYC upload 5xxs.
 *   - `lib/fulfillment/quoteToken.ts` — signs the shipping-quote
 *     tokens whose `priceMinor` is the only number we trust at
 *     `POST /orders`. Without it the rate quote endpoint throws
 *     `"SESSION_SECRET is required to sign shipping quotes"` and the
 *     entire checkout flow stops working.
 *   - `lib/fulfillment/verifyToken.ts` — signs the address-
 *     verification token that lets a buyer bypass OkHi validation at
 *     order placement. Throws on every issue/verify when the secret
 *     is missing or too short.
 *   - `lib/mfa.ts` — used as a dev-only fallback for both the AES
 *     key and the backup-code pepper. In production the AES key path
 *     throws (because `MFA_ENCRYPTION_KEY` is required), but the
 *     backup-code pepper falls back to `"dev-mfa-pepper"` if both
 *     `MFA_BACKUP_PEPPER` and `SESSION_SECRET` are unset — meaning a
 *     production deploy missing both env vars would store backup-code
 *     hashes under a hard-coded pepper.
 *
 * Each consumer fails closed at the first request that needs the
 * secret, so the misconfiguration is not silently exploitable, but
 * the failure mode is per-request 5xx storms (KYC uploads bounce,
 * checkout breaks) rather than a clean operator-facing alert. By the
 * time those errors page on-call from Sentry, every buyer mid-
 * checkout has already seen a "shipping quote unavailable" toast.
 *
 * Modelled on `assertRateLimitStoreConfiguredForProduction` (see
 * `middlewares/apiRateLimit.ts`):
 *
 *   - If a production-shaped deploy is detected (any of `NODE_ENV=production`,
 *     `REPLIT_DEPLOYMENT=1`, `DEPLOYMENT_ENVIRONMENT=production`),
 *   - AND `SESSION_SECRET` is unset, empty, whitespace-only, OR
 *     shorter than 16 characters,
 *   - THEN emit a loud structured warning naming the missing env var,
 *     the production signals that triggered the check, the consumers
 *     that will throw on first use, and the runbook section to read.
 *
 * The 16-character minimum mirrors the explicit `s.length < 16`
 * checks in `kyc.ts` and `fulfillment/verifyToken.ts` so the boot-
 * time warning catches the exact same misconfigurations those
 * runtime guards would later throw on. A shorter value would let
 * boot complete, then crash the first KYC upload and the first
 * address-verify token issue — exactly the silent-then-loud failure
 * mode this check exists to convert into a single boot-time signal.
 *
 * Warning, not a hard failure: an existing production deploy with a
 * legacy short `SESSION_SECRET` shouldn't refuse to boot the first
 * time this check ships — the per-request throws at the consumer
 * sites are still the hard fail-closed control. Operators wire a
 * Sentry / log-aggregator alert on the
 * `session_secret_missing_for_production` message tag so the
 * misconfiguration shows up within minutes of the next deploy — see
 * `docs/runbooks/production-secrets.md`.
 *
 * Pure function — takes `env` and a `log` sink so the unit test can
 * exercise the staging-skipped, production-warned, and configured-
 * silent paths without poisoning `process.env` or piping pino output.
 * Returns the outcome instead of side-effects so the caller can
 * decide what to do (today: log + continue; in the future a deploy
 * gate could reject).
 */

/** Minimum acceptable SESSION_SECRET length, in characters. */
export const SESSION_SECRET_MIN_LENGTH = 16;

export type SessionSecretConfigOutcome =
  | { ok: true }
  | { ok: false; reason: string };

export function assertSessionSecretConfiguredForProduction(
  env: NodeJS.ProcessEnv,
  log: { warn: (obj: unknown, msg: string) => void },
): SessionSecretConfigOutcome {
  const productionSignals = detectNonHostnameProductionSignals(env);
  if (productionSignals.length === 0) {
    // Not a production deploy — the dev-mode fallbacks in mfa.ts
    // (`dev-mfa-fallback`, `dev-mfa-pepper`) are intentional for local
    // and staging. Nothing to warn about.
    return { ok: true };
  }
  const raw = env.SESSION_SECRET;
  // Match the runtime checks in kyc.ts and fulfillment/verifyToken.ts:
  // both insist on a non-empty value at least 16 characters long.
  // Trimming so a value padded with stray whitespace (e.g. an env
  // file with trailing spaces) is treated the same as a too-short
  // value rather than counted toward the minimum.
  const trimmed = (raw ?? "").trim();
  if (trimmed.length >= SESSION_SECRET_MIN_LENGTH) {
    return { ok: true };
  }
  const signalDetails = productionSignals.map((s) => s.detail).join("; ");
  let observed: string;
  let condition: string;
  if (raw === undefined) {
    observed = "SESSION_SECRET is unset";
    condition = "unset";
  } else if (trimmed === "") {
    observed = "SESSION_SECRET is empty/whitespace-only";
    condition = "empty";
  } else {
    observed = `SESSION_SECRET length=${trimmed.length} < ${SESSION_SECRET_MIN_LENGTH}`;
    condition = "too_short";
  }
  const reason =
    `${observed} on this production deploy. SESSION_SECRET signs ` +
    "shipping-quote tokens (lib/fulfillment/quoteToken.ts), address-" +
    "verification tokens (lib/fulfillment/verifyToken.ts), and " +
    "encrypts KYC document uploads at rest (lib/kyc.ts) — every one " +
    "of those code paths throws synchronously on first use when the " +
    "secret is missing or too short, so a deploy that boots clean " +
    "today will start 5xx-ing the next checkout / KYC upload. " +
    `Detected production signal(s): ${signalDetails}. ` +
    `Set SESSION_SECRET to a value at least ${SESSION_SECRET_MIN_LENGTH} ` +
    "characters long — see docs/runbooks/production-secrets.md " +
    "(SESSION_SECRET section).";
  log.warn(
    {
      node_env: env.NODE_ENV,
      replit_deployment: env.REPLIT_DEPLOYMENT,
      deployment_environment: env.DEPLOYMENT_ENVIRONMENT,
      // Never echo the secret itself; just the failure mode + length
      // so triage can confirm the misconfiguration without leaking
      // the value into the log stream / Sentry payload.
      session_secret_condition: condition,
      session_secret_length: trimmed.length,
      production_signals: productionSignals.map((s) => s.signal),
    },
    `session_secret_missing_for_production: ${reason}`,
  );
  return { ok: false, reason };
}
