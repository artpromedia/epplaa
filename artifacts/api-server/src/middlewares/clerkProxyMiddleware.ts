/**
 * Clerk Frontend API Proxy Middleware
 *
 * Proxies Clerk Frontend API requests through your domain, enabling Clerk
 * authentication on custom domains and .replit.app deployments without
 * requiring CNAME DNS configuration.
 *
 * AUTH CONFIGURATION: To manage users, enable/disable login providers
 * (Google, GitHub, etc.), change app branding, or configure OAuth credentials,
 * use the Auth pane in the workspace toolbar. There is no external Clerk
 * dashboard — all auth configuration is done through the Auth pane.
 *
 * IMPORTANT:
 * - Only active in production (Clerk proxying doesn't work for dev instances)
 * - Must be mounted BEFORE express.json() middleware
 *
 * Usage in app.ts:
 *   import { CLERK_PROXY_PATH, clerkProxyMiddleware } from "./middlewares/clerkProxyMiddleware";
 *   app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
 */

import { createProxyMiddleware } from "http-proxy-middleware";
import type { RequestHandler } from "express";
import { detectNonHostnameProductionSignals } from "../lib/productionSignals";

const CLERK_FAPI = "https://frontend-api.clerk.dev";
export const CLERK_PROXY_PATH = "/api/__clerk";

/**
 * Boot-time sanity check: production deploys MUST set `CLERK_SECRET_KEY`.
 *
 * `CLERK_SECRET_KEY` is read in three places that all silently fall
 * back to a less-secure path when it's missing:
 *
 *   1. `clerkProxyMiddleware()` (this file) — when unset, the
 *      middleware becomes a `next()` passthrough. Clerk Frontend API
 *      requests proxied through `/api/__clerk` would be sent to Clerk
 *      without the `Clerk-Secret-Key` header, breaking auth on
 *      custom-domain deploys.
 *   2. `routes/auth.ts /auth/otp/verify` — when unset, the OTP verify
 *      handler returns `{ ok: true, noClerk: true }` without ever
 *      provisioning a Clerk user, so the "verified" session is a stub
 *      that other auth-aware handlers will reject.
 *   3. `lib/socket.ts` Socket.IO middleware — when unset, every WS
 *      connection's auth token is skipped and the socket joins as an
 *      anonymous viewer. In production this means seller/admin
 *      identity is silently absent on every socket — a real auth
 *      regression dressed up as a normal connection.
 *
 * Any of those three is a security regression on a production deploy,
 * but each is also legitimate on staging / dev (the OTP loop is
 * exercised without Clerk, anonymous sockets are useful for local
 * preview, etc.). The check turns the runbook recommendation that
 * "production must set CLERK_SECRET_KEY" into an automated boot-time
 * signal modelled on `assertRateLimitStoreConfiguredForProduction`:
 *
 *   - If a production-shaped deploy is detected (any of `NODE_ENV=production`,
 *     `REPLIT_DEPLOYMENT=1`, `DEPLOYMENT_ENVIRONMENT=production`),
 *   - AND `CLERK_SECRET_KEY` is unset / empty / whitespace-only,
 *   - THEN emit a loud structured warning naming the missing env var,
 *     the production signals that triggered the check, the three
 *     silently-degraded code paths, and the runbook section to read.
 *
 * Warning, not a hard failure: a brand-new production deploy may
 * legitimately ship with auth disabled while it's being stood up
 * (the `noClerk: true` path was added precisely for that), and crash-
 * looping every existing deploy that hasn't yet wired Clerk would be
 * more disruptive than the marginal security gain. Operators wire a
 * Sentry / log-aggregator alert on the
 * `clerk_secret_key_missing_for_production` message tag so the
 * misconfiguration shows up within minutes of the next deploy — see
 * `docs/runbooks/production-secrets.md`.
 *
 * The check intentionally does NOT also assert
 * `CLERK_PUBLISHABLE_KEY`. The publishable key is a frontend-build
 * concern (it ships in the SPA bundle and is enforced at build time
 * by the web artifacts), so a missing publishable key on the api-
 * server is harmless — the secret key is the server-side leg.
 *
 * Pure function — takes `env` and a `log` sink so the unit test can
 * exercise the staging-skipped, production-warned, and configured-
 * silent paths without poisoning `process.env` or piping pino output.
 */
export type ClerkSecretKeyConfigOutcome =
  | { ok: true }
  | { ok: false; reason: string };

export function assertClerkSecretKeyConfiguredForProduction(
  env: NodeJS.ProcessEnv,
  log: { warn: (obj: unknown, msg: string) => void },
): ClerkSecretKeyConfigOutcome {
  const productionSignals = detectNonHostnameProductionSignals(env);
  if (productionSignals.length === 0) {
    // Not a production deploy — the OTP-only / anonymous-socket
    // fallbacks are legitimate on staging / dev / preview.
    return { ok: true };
  }
  const raw = env.CLERK_SECRET_KEY;
  if (raw && raw.trim() !== "") {
    // Configured. We deliberately do NOT validate the key shape (e.g.
    // `sk_test_*` vs `sk_live_*`) here — Clerk's SDK surfaces that on
    // the first authenticated request and re-implementing the prefix
    // check would drift from the SDK's actual validation rules.
    return { ok: true };
  }
  const signalDetails = productionSignals.map((s) => s.detail).join("; ");
  const reason =
    "CLERK_SECRET_KEY is not set on this production deploy. Three " +
    "code paths silently fall back to insecure defaults: (1) the " +
    "Clerk Frontend API proxy at /api/__clerk becomes a passthrough " +
    "and strips the secret-key header, (2) /auth/otp/verify returns " +
    "{ ok: true, noClerk: true } without provisioning a Clerk user, " +
    "and (3) Socket.IO connections skip token verification and join " +
    "as anonymous viewers. " +
    `Detected production signal(s): ${signalDetails}. ` +
    "Set CLERK_SECRET_KEY to the project's sk_live_* key — see " +
    "docs/runbooks/production-secrets.md (CLERK_SECRET_KEY section).";
  log.warn(
    {
      node_env: env.NODE_ENV,
      replit_deployment: env.REPLIT_DEPLOYMENT,
      deployment_environment: env.DEPLOYMENT_ENVIRONMENT,
      // Never echo the secret itself; just whether the slot is filled.
      clerk_secret_key: raw ? "[set-but-empty]" : null,
      production_signals: productionSignals.map((s) => s.signal),
    },
    `clerk_secret_key_missing_for_production: ${reason}`,
  );
  return { ok: false, reason };
}

export function clerkProxyMiddleware(): RequestHandler {
  // Only run proxy in production — Clerk proxying doesn't work for dev instances
  if (process.env.NODE_ENV !== "production") {
    return (_req, _res, next) => next();
  }

  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    return (_req, _res, next) => next();
  }

  return createProxyMiddleware({
    target: CLERK_FAPI,
    changeOrigin: true,
    pathRewrite: (path: string) =>
      path.replace(new RegExp(`^${CLERK_PROXY_PATH}`), ""),
    on: {
      proxyReq: (proxyReq, req) => {
        const protocol = req.headers["x-forwarded-proto"] || "https";
        const host = req.headers.host || "";
        const proxyUrl = `${protocol}://${host}${CLERK_PROXY_PATH}`;

        proxyReq.setHeader("Clerk-Proxy-Url", proxyUrl);
        proxyReq.setHeader("Clerk-Secret-Key", secretKey);

        const xff = req.headers["x-forwarded-for"];
        const clientIp =
          (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim() ||
          req.socket?.remoteAddress ||
          "";
        if (clientIp) {
          proxyReq.setHeader("X-Forwarded-For", clientIp);
        }
      },
    },
  }) as RequestHandler;
}
