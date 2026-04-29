import { detectNonHostnameProductionSignals } from "../productionSignals";

/**
 * Boot-time sanity check: production deploys MUST set at least one of
 * `POSTMARK_API_TOKEN` or `SENDGRID_API_KEY`.
 *
 * The email channel registry (`lib/notifications/registry.ts`)
 * composes the email channel by filtering [`PostmarkEmailChannel`,
 * `SendGridEmailChannel`] through `isConfigured()`. When neither
 * provider's env var is set, `buildChannel("email", …)` falls back
 * to the `ConsoleChannel` — which `info`-logs and returns
 * `{ ok: true }`. The outbox worker then marks the row delivered and
 * moves on, so on a misconfigured production deploy **every email
 * the system sends is silently dropped while the outbox claims
 * success**: MFA backup-code nudges, security alerts ("MFA was
 * enabled on your account"), departed-user notifications, the lot.
 *
 * This is the same shape of regression task #72 fixed for the no-op
 * stub: provider misconfiguration can re-introduce the silent-success
 * path via a different door (no real provider configured rather than
 * a stub adapter wired in). The runtime registry intentionally still
 * falls through to console for local dev — without the boot-time
 * check, on-call only sees the misconfiguration the next time a
 * security email is expected to land and a user reports the missing
 * email.
 *
 * Modelled on the other `assertXxxConfiguredForProduction` helpers
 * (see `docs/runbooks/production-secrets.md`). Warning, not a hard
 * failure: an internal-only deploy may legitimately ship without
 * email while it's being stood up. Operators wire a Sentry /
 * log-aggregator alert on the
 * `email_provider_missing_for_production` message tag — see the
 * runbook for the alert configuration.
 *
 * Pure function — takes `env` and a `log` sink so the unit test can
 * exercise the staging-skipped, production-warned, and configured-
 * silent paths without poisoning `process.env` or piping pino output.
 */
export type EmailProviderConfigOutcome =
  | { ok: true }
  | { ok: false; reason: string };

export function assertEmailProviderConfiguredForProduction(
  env: NodeJS.ProcessEnv,
  log: { warn: (obj: unknown, msg: string) => void },
): EmailProviderConfigOutcome {
  const productionSignals = detectNonHostnameProductionSignals(env);
  if (productionSignals.length === 0) return { ok: true };
  const rawPostmark = env.POSTMARK_API_TOKEN;
  const rawSendgrid = env.SENDGRID_API_KEY;
  const postmark = (rawPostmark ?? "").trim();
  const sendgrid = (rawSendgrid ?? "").trim();
  if (postmark !== "" || sendgrid !== "") return { ok: true };
  // Sentinel matches the convention from sibling asserts (termii.ts,
  // payments.ts, okhi.ts, …): `null` = env var unset,
  // `"[set-but-empty]"` = env var present but whitespace-only (typo
  // / accidental blank). The actual secret value is NEVER surfaced.
  const slot = (raw: string | undefined): string | null =>
    raw === undefined || raw === "" ? null : "[set-but-empty]";
  const signalDetails = productionSignals.map((s) => s.detail).join("; ");
  const reason =
    "Neither POSTMARK_API_TOKEN nor SENDGRID_API_KEY is set on this " +
    "production deploy. The email channel registry " +
    "(lib/notifications/registry.ts) falls back to the ConsoleChannel " +
    "when no real provider is configured, which logs and returns " +
    "ok=true so the outbox worker marks the row delivered without " +
    "anyone receiving the email. Every transactional email — MFA " +
    "backup-code nudges, MFA security alerts, departed-user " +
    "notifications, etc. — is silently dropped. " +
    `Detected production signal(s): ${signalDetails}. ` +
    "Set POSTMARK_API_TOKEN (primary) and/or SENDGRID_API_KEY " +
    "(secondary failover) — see docs/runbooks/production-secrets.md " +
    "(EMAIL_PROVIDER section).";
  log.warn(
    {
      node_env: env.NODE_ENV,
      replit_deployment: env.REPLIT_DEPLOYMENT,
      deployment_environment: env.DEPLOYMENT_ENVIRONMENT,
      postmark_api_token: slot(rawPostmark),
      sendgrid_api_key: slot(rawSendgrid),
      production_signals: productionSignals.map((s) => s.signal),
    },
    `email_provider_missing_for_production: ${reason}`,
  );
  return { ok: false, reason };
}
