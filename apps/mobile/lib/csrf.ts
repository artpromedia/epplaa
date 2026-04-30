import { useEffect } from "react";
import { setCsrfToken, setCsrfTokenRefresher } from "@workspace/api-client-react";

/**
 * Mobile-side CSRF wiring for the cookie-session double-submit pattern
 * implemented in `artifacts/api-server/src/middlewares/csrf.ts`. Mirrors the
 * SPA helper in `artifacts/epplaa-app/src/lib/csrf.ts` so the two surfaces
 * stay symmetrical.
 *
 * SHIP-OR-SKIP DECISION (April 2026): SKIP at runtime, SHIP the wiring.
 *
 * The mobile app authenticates with Clerk bearer tokens and does not maintain
 * a cookie jar — every request goes through `customFetch` with an
 * `Authorization: Bearer …` header, which the server's CSRF middleware
 * exempts. So today there is no cookie session for a CSRF token to protect,
 * and `useCsrfToken` defaults to `enabled: false` — mounting it is a no-op
 * and no `/api/csrf-token` GET is ever fired.
 *
 * The helper exists so that the day someone introduces a cookie-session
 * surface on mobile (the common candidates being a WebView for live chat,
 * a server-rendered help center, or a session bridge so push deep-links can
 * resume an authenticated browser tab), the fix is one prop flip:
 *
 *   useCsrfToken({ enabled: true, sessionKey: userId, baseUrl });
 *
 * Without this scaffold, that future change would silently 403 on every
 * mutating request the same way the SPAs would have before Task #36.
 */

const CSRF_TOKEN_PATH = "/api/csrf-token";

type CsrfResponse = { csrfToken?: string };

function joinUrl(baseUrl: string | null | undefined, path: string): string {
  if (!baseUrl) return path;
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

/**
 * Fetch a fresh CSRF token from the API and stash it in the shared client.
 * Returns the token (so callers can chain on it) or `null` when the request
 * fails — the registered refresher swallows network errors so a transient
 * outage does not break the original request's error surface.
 *
 * `baseUrl` is the absolute origin of the API (e.g. `https://example.com`),
 * because React Native's `fetch` does not have an implicit document origin
 * the way browsers do. Pass `null`/`undefined` to call the path verbatim.
 */
export async function fetchCsrfToken(
  baseUrl?: string | null,
): Promise<string | null> {
  try {
    const res = await fetch(joinUrl(baseUrl, CSRF_TOKEN_PATH), {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as CsrfResponse;
    const token = typeof body.csrfToken === "string" ? body.csrfToken : null;
    setCsrfToken(token);
    return token;
  } catch {
    return null;
  }
}

export type UseCsrfTokenOptions = {
  /**
   * Whether to actually fetch and stash a CSRF token. Defaults to `false`
   * because mobile uses bearer auth today (see file-level comment). Flip to
   * `true` only when a cookie-session surface is introduced.
   */
  enabled?: boolean;
  /**
   * Bumping this re-fetches the token. Pass the Clerk user id (or
   * `isSignedIn` boolean) so a sign-in/out replaces the token bound to the
   * old session.
   */
  sessionKey?: string | number | boolean | null;
  /**
   * Absolute origin of the API server. Required in non-browser contexts
   * (React Native) where `fetch` has no implicit base.
   */
  baseUrl?: string | null;
};

/**
 * Mount once near the top of the app tree (e.g. inside `_layout.tsx`,
 * alongside any auth bridge). When `enabled` is false this is a pure no-op:
 * no network request is made and no module-level state is mutated.
 */
export function useCsrfToken(options: UseCsrfTokenOptions = {}): void {
  const { enabled = false, sessionKey = null, baseUrl = null } = options;

  useEffect(() => {
    if (!enabled) return;

    const refresher = () => fetchCsrfToken(baseUrl);
    setCsrfTokenRefresher(refresher);
    void refresher();
    return () => {
      setCsrfTokenRefresher(null);
      setCsrfToken(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, sessionKey, baseUrl]);
}
