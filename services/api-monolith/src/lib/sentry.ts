import * as Sentry from "@sentry/node";
import { logger } from "./logger";
import { detectNonHostnameProductionSignals } from "./productionSignals";

/**
 * Sentry server SDK init. Reads SENTRY_DSN; if absent we install a no-op
 * shim so callers can `Sentry.captureException()` without conditional
 * branches at every call site.
 *
 * PII scrubbing mirrors `lib/logger.ts` redact paths so a Sentry leak can't
 * regress logger discipline. The `beforeSend` hook walks `event.request`
 * and `event.extra` and replaces known sensitive keys with [REDACTED].
 *
 * Release tagging: SENTRY_RELEASE is set by CI from the git sha (see
 * .github/workflows/release.yml). Locally it's empty and Sentry treats
 * the events as un-versioned — that's fine for dev.
 */

let initialised = false;

const SENSITIVE_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "email",
  "phone",
  "password",
  "token",
  "secret",
  "otp",
  "bvn",
  "nin",
  "govid",
  "gov_id",
  "passportnumber",
  "passport_number",
  "dateofbirth",
  "date_of_birth",
  "dob",
  "address",
  "streetaddress",
  "street_address",
  "postalcode",
  "postal_code",
  "ipaddress",
  "ip_address",
  "bankaccount",
  "bank_account",
  "cardnumber",
  "card_number",
  "cardlast4",
  "card_last4",
  "last4",
  "cvv",
  "cvc",
  "expmonth",
  "exp_month",
  "expyear",
  "exp_year",
]);

function scrubObject<T>(value: T, depth = 0): T {
  if (depth > 8 || value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((v) => scrubObject(v, depth + 1)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      out[k] = "[REDACTED]";
    } else if (typeof v === "object" && v !== null) {
      out[k] = scrubObject(v, depth + 1);
    } else {
      out[k] = v;
    }
  }
  return out as unknown as T;
}

export function initSentryServer(): void {
  if (initialised) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    logger.info("sentry_disabled_no_dsn");
    initialised = true;
    return;
  }
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    release: process.env.SENTRY_RELEASE || undefined,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
    sendDefaultPii: false,
    beforeSend(event) {
      if (event.request) {
        event.request = scrubObject(event.request);
      }
      if (event.extra) {
        event.extra = scrubObject(event.extra);
      }
      if (event.user) {
        // Strip raw email/IP — keep only id for cohort analysis.
        const safeUser: { id?: string } = {};
        if (event.user.id !== undefined) safeUser.id = String(event.user.id);
        event.user = safeUser;
      }
      return event;
    },
  });
  initialised = true;
  logger.info({ release: process.env.SENTRY_RELEASE ?? null }, "sentry_initialised");
}

export interface CaptureOptions {
  level?: Sentry.SeverityLevel;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  fingerprint?: string[];
}

function buildCaptureContext(options?: CaptureOptions) {
  if (!options) return undefined;
  const ctx: {
    level?: Sentry.SeverityLevel;
    tags?: Record<string, string>;
    extra?: Record<string, unknown>;
    fingerprint?: string[];
  } = {};
  if (options.level) ctx.level = options.level;
  if (options.tags) ctx.tags = options.tags;
  if (options.fingerprint) ctx.fingerprint = options.fingerprint;
  if (options.extra) ctx.extra = scrubObject(options.extra);
  return ctx;
}

/**
 * Boot-time sanity check: production deploys MUST set `SENTRY_DSN`.
 *
 * Without a DSN, `initSentryServer` silently swaps the SDK for a no-op
 * (`logger.info("sentry_disabled_no_dsn")`) and every call to
 * `captureException` / `captureMessage` becomes a no-op. The fallout
 * is severe and silent: every alert channel layered on top of Sentry
 * is dead at the source. The `rate_limit_redis_failure_threshold_breached`
 * fatal page, the `rate_limit_store_stuck_degraded` cron page, the
 * per-failure `subsystem=rate_limit` rule, the audit-chain anomaly
 * captures — none of them reach on-call. The `sentry_disabled_no_dsn`
 * info log is the only signal an operator gets, and it's exactly the
 * kind of one-line boot log that gets lost in normal startup chatter.
 *
 * Modelled on `assertRateLimitStoreConfiguredForProduction` (see
 * `middlewares/apiRateLimit.ts`):
 *
 *   - If a production-shaped deploy is detected (any of `NODE_ENV=production`,
 *     `REPLIT_DEPLOYMENT=1`, `DEPLOYMENT_ENVIRONMENT=production`),
 *   - AND `SENTRY_DSN` is unset / empty / whitespace-only,
 *   - THEN emit a loud structured warning naming the missing env var,
 *     the production signals that triggered the check, and the
 *     runbook section to read.
 *
 * Warning, not a hard failure: a single-replica internal-only
 * production deploy may legitimately ship without Sentry while it's
 * being stood up, and crash-looping every existing deploy that has
 * not yet wired Sentry would be more disruptive than the marginal
 * observability gain. Operators wire a Sentry / log-aggregator alert
 * on the `sentry_dsn_missing_for_production` message tag (see
 * `docs/runbooks/production-secrets.md`) so the misconfiguration
 * shows up within minutes — though obviously the very alert pipe is
 * what's being checked, so the LOG-AGGREGATOR alert is the canonical
 * one for this specific check (Sentry can't tell you Sentry is off).
 *
 * Pure function — takes `env` and a `log` sink so the unit test can
 * exercise the staging-skipped, production-warned, and configured-
 * silent paths without poisoning `process.env` or piping pino output.
 */
export type SentryDsnConfigOutcome =
  | { ok: true }
  | { ok: false; reason: string };

export function assertSentryDsnConfiguredForProduction(
  env: NodeJS.ProcessEnv,
  log: { warn: (obj: unknown, msg: string) => void },
): SentryDsnConfigOutcome {
  const productionSignals = detectNonHostnameProductionSignals(env);
  if (productionSignals.length === 0) {
    // Not a production deploy — Sentry is optional on staging / dev /
    // preview environments. Nothing to warn about.
    return { ok: true };
  }
  const raw = env.SENTRY_DSN;
  if (raw && raw.trim() !== "") {
    // Configured. We deliberately do NOT try to validate the DSN
    // syntax here — `Sentry.init` will surface that at boot if the
    // DSN is malformed, and re-validating would either duplicate the
    // SDK's parser or drift from it.
    return { ok: true };
  }
  const signalDetails = productionSignals.map((s) => s.detail).join("; ");
  const reason =
    "SENTRY_DSN is not set on this production deploy — initSentryServer " +
    "will install a no-op shim and every captureException/captureMessage " +
    "call will silently drop. Every alert layered on top of Sentry " +
    "(rate_limit_redis_failure_threshold_breached, " +
    "rate_limit_store_stuck_degraded, audit-chain anomaly captures, " +
    "etc.) is dead at the source. " +
    `Detected production signal(s): ${signalDetails}. ` +
    "Set SENTRY_DSN — see docs/runbooks/production-secrets.md " +
    "(SENTRY_DSN section) for the project-level DSN to use.";
  log.warn(
    {
      node_env: env.NODE_ENV,
      replit_deployment: env.REPLIT_DEPLOYMENT,
      deployment_environment: env.DEPLOYMENT_ENVIRONMENT,
      sentry_dsn: raw ?? null,
      production_signals: productionSignals.map((s) => s.signal),
    },
    `sentry_dsn_missing_for_production: ${reason}`,
  );
  return { ok: false, reason };
}

export function captureException(err: unknown, options?: CaptureOptions): void {
  if (!initialised || !process.env.SENTRY_DSN) return;
  Sentry.captureException(err, buildCaptureContext(options));
}

/**
 * Send a structured message to Sentry. Use for high-level alert signals
 * (e.g. "this subsystem is degraded") where there's no underlying Error
 * to capture. `level: "fatal"` fires Sentry's default new-issue alert
 * rule on the very first event so we don't depend on a project-specific
 * threshold rule being configured.
 */
export function captureMessage(message: string, options?: CaptureOptions): void {
  if (!initialised || !process.env.SENTRY_DSN) return;
  Sentry.captureMessage(message, buildCaptureContext(options));
}

export { Sentry };
