import { useEffect } from "react";
import { issueCsrfToken } from "@workspace/api-client-react";
import { setApiCsrfToken, setApiCsrfRefresher } from "./api";

/**
 * Browser-side CSRF wiring for the cookie-session double-submit pattern
 * implemented in `artifacts/api-server/src/middlewares/csrf.ts`. The
 * manufacturer portal uses its own `api.ts` fetch wrapper rather than the
 * generated `@workspace/api-client-react` client for its calls, but it
 * still uses the generated `issueCsrfToken` helper so the request shape is
 * typed by the OpenAPI contract.
 */

export async function fetchCsrfToken(): Promise<string | null> {
  try {
    const body = await issueCsrfToken({ credentials: "include" });
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
