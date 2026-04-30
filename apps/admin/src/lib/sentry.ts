import * as Sentry from "@sentry/react";

/**
 * Admin SPA Sentry init. PII scrub mirrors the consumer SPA — the admin
 * console shows operator-grade detail on KYC/refund flows that we cannot
 * leak into Sentry under any circumstances.
 */
const SENSITIVE_KEYS = new Set([
  "authorization",
  "cookie",
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
  "address",
  "cardnumber",
  "card_number",
  "cvv",
  "cvc",
  "bankaccount",
  "bank_account",
]);

function scrubObject<T>(value: T, depth = 0): T {
  if (depth > 8 || value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => scrubObject(v, depth + 1)) as unknown as T;
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

export function initSentryBrowser(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    release: (import.meta.env.VITE_SENTRY_RELEASE as string | undefined) || undefined,
    tracesSampleRate: Number(
      (import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE as string | undefined) ?? "0.1",
    ),
    sendDefaultPii: false,
    beforeSend(event) {
      if (event.request) event.request = scrubObject(event.request);
      if (event.extra) event.extra = scrubObject(event.extra);
      if (event.user) {
        const safeUser: { id?: string } = {};
        if (event.user.id !== undefined) safeUser.id = String(event.user.id);
        event.user = safeUser;
      }
      return event;
    },
  });
}
