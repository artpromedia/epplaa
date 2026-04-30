import { useEffect } from "react";
import { useAuth } from "@clerk/clerk-react";
import { registerAuthTokenGetter } from "./api-init";

export function ApiAuthBridge() {
  const { getToken, isLoaded } = useAuth();
  useEffect(() => {
    if (!isLoaded) return;
    registerAuthTokenGetter(async () => {
      try {
        return await getToken();
      } catch {
        return null;
      }
    });
    return () => registerAuthTokenGetter(null);
  }, [getToken, isLoaded]);
  return null;
}
