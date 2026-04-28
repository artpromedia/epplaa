import { useEffect } from "react";
import { setCsrfToken, setCsrfTokenRefresher } from "@workspace/api-client-react";

/**
 * Browser-side CSRF wiring for the cookie-session double-submit pattern
 * implemented in `artifacts/api-server/src/middlewares/csrf.ts`.
 *
 * Today every authenticated mutation goes through Clerk Bearer auth and the
 * server's CSRF middleware exempts those — but as soon as a cookie-session
 * route is added, the SPA needs to be sending `X-CSRF-Token` or it will see
 * a silent 403. This module:
 *   1. Fetches `/api/csrf-token` on app boot so the cookie + token pair are
 *      established before any mutation can fire.
 *   2. Registers a refresher with the shared API client so a stale-token 403
 *      transparently re-fetches and retries the original request once.
 *   3. Re-fetches the token whenever the auth/sign-in state changes, since
 *      Clerk-driven sign-in/out can replace the underlying session.
 *
 * The token is non-secret (it's a CSRF nonce, not a credential), so stashing
 * it in a module-level variable is fine — XSS already breaks every web auth
 * scheme and CSRF tokens specifically don't need to be HttpOnly.
 */

const CSRF_TOKEN_URL = "/api/csrf-token";

type CsrfResponse = { csrfToken?: string };

export async function fetchCsrfToken(): Promise<string | null> {
  try {
    const res = await fetch(CSRF_TOKEN_URL, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as CsrfResponse;
    const token = typeof body.csrfToken === "string" ? body.csrfToken : null;
    setCsrfToken(token);
    return token;
  } catch {
    return null;
  }
}

/**
 * Mount once at the top of the app tree. Optionally pass a session key
 * (e.g. the Clerk user id or `isSignedIn` boolean) so the token re-issues
 * when the session changes.
 */
export function useCsrfToken(sessionKey?: string | number | boolean | null): void {
  useEffect(() => {
    setCsrfTokenRefresher(fetchCsrfToken);
    void fetchCsrfToken();
    return () => {
      setCsrfTokenRefresher(null);
      setCsrfToken(null);
    };
    // The session key is the only meaningful dependency: when it changes we
    // want a fresh token bound to the new cookie.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);
}
