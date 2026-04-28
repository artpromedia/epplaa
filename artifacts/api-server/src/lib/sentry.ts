import * as Sentry from "@sentry/node";
import { logger } from "./logger";

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
