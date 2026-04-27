import { setBaseUrl, setAuthTokenGetter, type AuthTokenGetter } from "@workspace/api-client-react";

// Generated client URLs are absolute paths starting with `/api/...`.
// Web app and API server share the same proxy host, so no base URL needed.
setBaseUrl(null);

export function registerAuthTokenGetter(getter: AuthTokenGetter | null) {
  setAuthTokenGetter(getter);
}
