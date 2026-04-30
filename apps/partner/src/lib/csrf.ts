import { useEffect } from "react";
import {
  issueCsrfToken,
  setCsrfToken,
  setCsrfTokenRefresher,
} from "@workspace/api-client-react";

/**
 * Browser-side CSRF wiring for the cookie-session double-submit pattern
 * implemented in `artifacts/api-server/src/middlewares/csrf.ts`. The
 * manufacturer portal uses the generated `@workspace/api-client-react`
 * fetch wrapper for every typed call, so this only has to keep the
 * stashed token + refresher in sync with the current Clerk session.
 */
export async function fetchCsrfToken(): Promise<string | null> {
  try {
    const body = await issueCsrfToken({ credentials: "include" });
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
