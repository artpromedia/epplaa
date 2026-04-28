import crypto from "node:crypto";
import type { Request, RequestHandler } from "express";

/**
 * Stateless CSRF protection — double-submit cookie pattern.
 *
 * Why double-submit (not synchronizer): we sit behind a single-page app and
 * have no per-request server-stored token store. Issuing a HMAC'd cookie
 * value AND requiring the client to echo it in `X-CSRF-Token` defeats
 * cross-site form submissions because attackers cannot read the cookie
 * (SameSite=Lax + HttpOnly=false on this cookie alone — the rest of our
 * cookie auth is HttpOnly).
 *
 * Skipped when the request is authenticated via a Bearer token because
 * Clerk stores its session as JWT in the Authorization header — browsers
 * don't auto-attach those across origins, so the CSRF surface only exists
 * for cookie-borne sessions.
 *
 * Excluded paths: /api/webhooks/** and /api/fulfillment/webhooks/** are
 * verified via HMAC of the raw body so CSRF doesn't apply.
 */

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const COOKIE_NAME = "csrf_token";
const HEADER_NAME = "x-csrf-token";
const TOKEN_BYTES = 32;
const COOKIE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

const EXEMPT_PATH_PREFIXES = [
  "/api/webhooks",
  "/api/fulfillment/webhooks",
  "/api/__clerk",
  "/api/csrf-token",
  "/api/health",
  // Staging-only rehearsal endpoints. These are mutating POSTs called
  // by a GitHub Actions cron (no browser, no cookies) and are gated
  // by HEALTHZ_REHEARSAL_ENABLED + a timing-safe X-Rehearsal-Token
  // inside the route handler itself. Without this exemption the
  // CSRF middleware would 403 the workflow before its bearer-style
  // token guard even runs.
  "/api/_rehearsal",
];

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function isExempt(path: string): boolean {
  return EXEMPT_PATH_PREFIXES.some((p) => path.startsWith(p));
}

function looksLikeBearerAuth(req: Request): boolean {
  const auth = req.headers.authorization;
  return typeof auth === "string" && auth.toLowerCase().startsWith("bearer ");
}

export function issueCsrfToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString("hex");
}

export function csrfMiddleware(): RequestHandler {
  return (req, res, next) => {
    if (!MUTATING.has(req.method)) return next();
    if (isExempt(req.path)) return next();
    if (looksLikeBearerAuth(req)) return next();

    const cookieToken = (req as Request & { cookies?: Record<string, string> })
      .cookies?.[COOKIE_NAME];
    const headerToken = req.headers[HEADER_NAME];
    const headerVal = Array.isArray(headerToken) ? headerToken[0] : headerToken;

    if (!cookieToken || !headerVal || !safeEqual(cookieToken, headerVal)) {
      res.status(403).json({
        error: "csrf_failed",
        detail: "Missing or invalid CSRF token. Refresh and retry.",
      });
      return;
    }
    next();
  };
}

/**
 * Attach to GET /api/csrf-token. Issues a fresh token, sets the cookie,
 * and returns the token in the body so the SPA can stash it for the
 * `X-CSRF-Token` header on subsequent mutations.
 */
export const csrfTokenIssuer: RequestHandler = (_req, res) => {
  const token = issueCsrfToken();
  res.cookie(COOKIE_NAME, token, {
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    httpOnly: false,
    maxAge: COOKIE_MAX_AGE_MS,
    path: "/",
  });
  res.json({ csrfToken: token });
};

export const __test__ = { COOKIE_NAME, HEADER_NAME, isExempt, safeEqual };
