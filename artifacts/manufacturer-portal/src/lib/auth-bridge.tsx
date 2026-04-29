import { useEffect } from "react";
import { useAuth } from "@clerk/clerk-react";
import { setAuthTokenGetter } from "@workspace/api-client-react";

/**
 * Wires the generated `@workspace/api-client-react` fetch wrapper to Clerk's
 * `getToken` so every typed API call automatically attaches a fresh bearer
 * token. Mount once inside `<ClerkProvider>` and `<SignedIn>`.
 */
export function ApiAuthBridge() {
  const { getToken, isLoaded } = useAuth();
  useEffect(() => {
    if (!isLoaded) return;
    setAuthTokenGetter(async () => {
      try {
        return await getToken();
      } catch {
        return null;
      }
    });
    return () => setAuthTokenGetter(null);
  }, [getToken, isLoaded]);
  return null;
}
