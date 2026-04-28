import { useEffect } from "react";
import { useAuth } from "@clerk/clerk-react";
import { setApiTokenGetter } from "./api";

export function ApiAuthBridge() {
  const { getToken, isLoaded } = useAuth();
  useEffect(() => {
    if (!isLoaded) return;
    setApiTokenGetter(async () => {
      try {
        return await getToken();
      } catch {
        return null;
      }
    });
    return () => setApiTokenGetter(null);
  }, [getToken, isLoaded]);
  return null;
}
