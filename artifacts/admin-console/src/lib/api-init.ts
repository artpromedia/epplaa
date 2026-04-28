import { setBaseUrl, setAuthTokenGetter, type AuthTokenGetter } from "@workspace/api-client-react";

setBaseUrl(null);

export function registerAuthTokenGetter(getter: AuthTokenGetter | null) {
  setAuthTokenGetter(getter);
}
