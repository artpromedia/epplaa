import { useEffect } from "react";
import { setApiCsrfToken, setApiCsrfRefresher } from "./api";

/**
 * Browser-side CSRF wiring for the cookie-session double-submit pattern
 * implemented in `artifacts/api-server/src/middlewares/csrf.ts`. The
 * manufacturer portal uses its own `api.ts` fetch wrapper rather than the
 * generated `@workspace/api-client-react`, so this hook talks to that
 * wrapper directly.
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
    setApiCsrfToken(token);
    return token;
  } catch {
    return null;
  }
}

export function useCsrfToken(sessionKey?: string | number | boolean | null): void {
  useEffect(() => {
    setApiCsrfRefresher(fetchCsrfToken);
    void fetchCsrfToken();
    return () => {
      setApiCsrfRefresher(null);
      setApiCsrfToken(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);
}
