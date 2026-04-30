import { useAuth } from "@clerk/clerk-react";
import { useCsrfToken } from "./csrf";

/**
 * Mount inside `<ClerkProvider>` (alongside `<ApiAuthBridge />`). Re-fetches
 * the CSRF token whenever the Clerk session changes so the cookie + stashed
 * token pair always belong to the same browser session.
 */
export function CsrfBridge() {
  const { userId, isLoaded } = useAuth();
  // Combine load + user so the first refresh fires once Clerk knows whether
  // we're signed in (signed-out browsers still get a token — the server
  // issues unconditionally — but we don't waste a request before then).
  const sessionKey = isLoaded ? userId ?? "anon" : "loading";
  useCsrfToken(sessionKey);
  return null;
}
