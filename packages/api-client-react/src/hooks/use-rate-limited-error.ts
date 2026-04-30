import { useMemo } from "react";
import { ApiError } from "../custom-fetch";

/**
 * Parsed shape of a 429 rate-limit response from the API. The server
 * always pairs the status code with a JSON body of
 * `{ error: "rate_limited", detail: string }` and a `Retry-After`
 * header expressed in whole seconds (delta-seconds, never an
 * HTTP-date). The two well-known error strings the server emits today
 * are `"rate_limited"` (generic per-route limiter) and
 * `"export_rate_limited"` (NDPR-specific). Both should hydrate the
 * same UI affordance — a friendly "try again at HH:MM" message — so
 * we accept both.
 *
 * `retryAt` is a real Date computed from the response time plus the
 * Retry-After delta. Rendering code can then format it in the user's
 * local timezone with `toLocaleTimeString` without re-deriving the
 * arithmetic at every render.
 *
 * `retryAfterSeconds` is preserved for tests and for callers that
 * want to render a "in X minutes" countdown rather than an absolute
 * clock time.
 */
export interface RateLimitedErrorInfo {
  retryAt: Date;
  retryAfterSeconds: number;
}

const RATE_LIMITED_ERROR_CODES = new Set(["rate_limited", "export_rate_limited"]);

/**
 * If the response was a 429 with the well-known rate-limit error
 * payload, returns the parsed retry-at info. Returns `null` for any
 * other error (network failure, 4xx with a different code, 5xx, etc).
 *
 * The header is treated as delta-seconds — the API server's
 * `apiRateLimit` middleware always emits it that way
 * (`Math.ceil(retryAfterMs / 1000)`). If the header is missing,
 * unparseable, or non-positive we fall back to a 60s default so the
 * UI still shows a sensible "try again at" time instead of nothing.
 *
 * Lives in the shared API client lib so the seller account-settings
 * SPA, the admin console, and (when it grows MFA UI) the mobile app
 * can all surface the same friendly affordance from the same shape.
 */
export function parseRateLimitedError(
  err: unknown,
): RateLimitedErrorInfo | null {
  if (!(err instanceof ApiError)) return null;
  if (err.status !== 429) return null;

  const data = err.data;
  if (!data || typeof data !== "object") return null;
  const code = (data as Record<string, unknown>).error;
  if (typeof code !== "string" || !RATE_LIMITED_ERROR_CODES.has(code)) {
    return null;
  }

  const headerValue = err.headers.get("retry-after");
  const parsed = headerValue !== null ? Number.parseInt(headerValue, 10) : NaN;
  const seconds =
    Number.isFinite(parsed) && parsed > 0 ? Math.ceil(parsed) : 60;

  return {
    retryAt: new Date(Date.now() + seconds * 1000),
    retryAfterSeconds: seconds,
  };
}

/**
 * Memoized variant of `parseRateLimitedError` for use inside React
 * components. The raw helper computes `retryAt = now + delta` on
 * every call, which would shift the displayed "try again at" clock
 * time on every re-render if called directly in render. Memoizing on
 * the error reference pins the parsed result to the moment the error
 * first appeared, so the user sees a stable target time until the
 * mutation is retried (and `mutation.error` flips to a new value or
 * `null`).
 */
export function useRateLimitedError(err: unknown): RateLimitedErrorInfo | null {
  return useMemo(() => parseRateLimitedError(err), [err]);
}

/**
 * Format a `retryAt` Date as a short, locale-aware clock time the
 * user can act on — e.g. `"3:42 PM"` in en-US, `"15:42"` in
 * en-GB/de-DE. Always uses the user's local timezone (browsers
 * default `Intl` to the runtime zone), which is what the task spec
 * calls for. Falls back to ISO if `toLocaleTimeString` somehow
 * throws — every modern browser supports it but RN runtimes have
 * historically had spotty Intl coverage.
 */
export function formatRetryAtClockTime(retryAt: Date): string {
  try {
    return retryAt.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return retryAt.toISOString();
  }
}
