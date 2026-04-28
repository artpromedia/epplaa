import crypto from "node:crypto";
import type { RequestHandler } from "express";
import helmet from "helmet";

/**
 * Strict transport + content-security headers. Mounted AFTER raw-body
 * webhook routers (they need Content-Type unmodified) but BEFORE
 * express.json() so even malformed bodies get the protective headers.
 *
 * CSP design:
 *  - Per-request nonce in res.locals.cspNonce — SPAs that inject a single
 *    bootstrap <script> can stamp it (Vite handles this in production
 *    builds when csp-hash is configured). Inline scripts without the
 *    nonce are rejected.
 *  - frame-ancestors 'none' replaces X-Frame-Options on modern browsers
 *    while we still send X-Frame-Options=DENY for older clients.
 *  - connect-src includes the Replit dev domain, Clerk Frontend API
 *    (proxied via /api/__clerk in prod), and Sentry tunnel host. Add
 *    payment gateway and CDN domains here as the surface grows.
 *  - HSTS: 6mo, includeSubDomains, no preload (preload requires owner
 *    sign-off via hstspreload.org).
 */
export function securityHeaders(): RequestHandler[] {
  const cspExtraConnectSrc = (process.env.CSP_EXTRA_CONNECT_SRC ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const noncePopulator: RequestHandler = (_req, res, next) => {
    const nonce = crypto.randomBytes(16).toString("base64");
    res.locals.cspNonce = nonce;
    next();
  };

  const helmetMw = helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        scriptSrc: [
          "'self'",
          (_req, res) =>
            `'nonce-${(res as unknown as { locals: { cspNonce: string } }).locals.cspNonce}'`,
          "https://*.clerk.dev",
          "https://*.clerk.com",
        ],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        mediaSrc: ["'self'", "blob:", "https:"],
        connectSrc: [
          "'self'",
          "https://*.clerk.dev",
          "https://*.clerk.com",
          "https://*.replit.dev",
          "https://*.replit.app",
          "https://*.ingest.sentry.io",
          "wss:",
          ...cspExtraConnectSrc,
        ],
        workerSrc: ["'self'", "blob:"],
        upgradeInsecureRequests: process.env.NODE_ENV === "production" ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: "same-origin" },
    crossOriginResourcePolicy: { policy: "same-site" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    strictTransportSecurity: {
      maxAge: 60 * 60 * 24 * 180, // 180 days
      includeSubDomains: true,
      preload: false,
    },
    frameguard: { action: "deny" },
    noSniff: true,
    xssFilter: true,
    hidePoweredBy: true,
  });

  return [noncePopulator, helmetMw];
}
