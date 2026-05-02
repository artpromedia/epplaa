/**
 * Configuration for the Vault secret-coverage CI guard
 * (scripts/src/checkVaultSecretCoverage.ts).
 *
 * Background: every secret-shaped env var the api-monolith reads at
 * runtime should be sourced from Vault via ExternalSecrets, not from
 * a CI environment variable hand-rolled into the cluster Secret.
 * The verifier walks `process.env.<NAME>` references in
 * services/api-monolith/src and asserts each secret-shaped name is
 * either declared in infra/helm/api-monolith/values.yaml's
 * `vault.secrets[*].keys[*]` block OR explicitly allowlisted here.
 *
 * Three knobs:
 *   - SECRET_NAME_PATTERNS: the regex set that defines "secret-shaped".
 *     A name is treated as secret if it matches any of these.
 *   - ALLOWLIST: env vars that match a secret pattern but are NOT
 *     migrated to Vault (with a documented reason). New entries here
 *     should always carry a comment.
 *   - VALUES_PATH: which helm values file is the source of truth.
 *
 * Update in lockstep with the values file when adding/removing a
 * secret.
 */

/**
 * Names matching any of these regexes are treated as secret-shaped
 * and must be Vault-backed (or explicitly allowlisted). Conservative
 * by design: false positives are fine (just allowlist with a
 * comment); false negatives mean a real secret slips through CI.
 */
export const SECRET_NAME_PATTERNS: readonly RegExp[] = [
  /_KEY$/,
  /_SECRET$/,
  /_TOKEN$/,
  /_PASSWORD$/,
  /_DSN$/,
  /_HASH$/,
  /_CREDENTIAL(S)?$/,
  /_SERVICE_ACCOUNT(_JSON)?$/,
  /^SESSION_SECRET$/,
];

/**
 * Env vars that match SECRET_NAME_PATTERNS but are *not* Vault-backed.
 * Every entry MUST carry a `reason` so the next operator who looks at
 * this list understands why. The verifier prints the reason when it
 * skips a name, so an out-of-date allowlist surfaces in the workflow
 * log.
 */
export interface AllowlistEntry {
  name: string;
  reason: string;
}
export const ALLOWLIST: readonly AllowlistEntry[] = [
  {
    name: "MFA_RATE_LIMIT_ALERT_COOLDOWN_MS",
    reason:
      "Tuning knob for the MFA rate-limit alerting cooldown — not a credential, " +
      "matches /_MS$/ via the looser /_KEY$|_TOKEN$/ regex set only because the " +
      "name happens to end in MS, but it's a duration in milliseconds. Kept " +
      "explicit here so a future regex tightening doesn't accidentally surface " +
      "it as a missing-secret false positive.",
  },
];

/**
 * Path (relative to repo root) to the helm values file that declares
 * the canonical Vault wiring. The verifier reads this file's
 * `vault.secrets[*].keys[*]` block to build the "covered" set.
 */
export const VALUES_PATH = "infra/helm/api-monolith/values.yaml";

/**
 * Path (relative to repo root) to the source tree the verifier walks
 * for `process.env.<NAME>` references. Restricted to the api-monolith
 * because the agent-service and the SPAs have their own coverage
 * stories (agent-service: separate Vault path; SPAs: build-time
 * Vite vars, never read at runtime).
 */
export const SOURCE_TREE = "services/api-monolith/src";
