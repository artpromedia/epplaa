import { useAuth } from "@clerk/clerk-react";
import { useCsrfToken } from "./csrf";

/**
 * Mount inside `<ClerkProvider>` (alongside `<ApiAuthBridge />`). Re-fetches
 * the CSRF token whenever the Clerk session changes so the cookie + stashed
 * token pair always belong to the same browser session.
 */
export function CsrfBridge() {
  const { userId, isLoaded } = useAuth();
  const sessionKey = isLoaded ? userId ?? "anon" : "loading";
  useCsrfToken(sessionKey);
  return null;
}
