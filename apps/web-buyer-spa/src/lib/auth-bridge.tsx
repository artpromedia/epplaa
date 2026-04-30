import { useEffect } from "react";
import { useAuth } from "@clerk/clerk-react";
import { registerAuthTokenGetter } from "./api-init";
import { setSocketTokenGetter } from "./stream-socket";

export function ApiAuthBridge() {
  const { getToken, isLoaded } = useAuth();
  useEffect(() => {
    if (!isLoaded) return;
    const tokenGetter = async () => {
      try {
        return await getToken();
      } catch {
        return null;
      }
    };
    registerAuthTokenGetter(tokenGetter);
    setSocketTokenGetter(tokenGetter);
    return () => {
      registerAuthTokenGetter(null);
      setSocketTokenGetter(null);
    };
  }, [getToken, isLoaded]);

  return null;
}
