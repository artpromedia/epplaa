import { useEffect } from "react";
import { setCsrfToken, setCsrfTokenRefresher } from "@workspace/api-client-react";

/**
 * Browser-side CSRF wiring for the cookie-session double-submit pattern
 * implemented in `artifacts/api-server/src/middlewares/csrf.ts`. See
 * `artifacts/epplaa-app/src/lib/csrf.ts` for the rationale; this is the same
 * helper, kept per-SPA so each app's bundle owns its own module-level state.
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

export function useCsrfToken(sessionKey?: string | number | boolean | null): void {
  useEffect(() => {
    setCsrfTokenRefresher(fetchCsrfToken);
    void fetchCsrfToken();
    return () => {
      setCsrfTokenRefresher(null);
      setCsrfToken(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);
}
