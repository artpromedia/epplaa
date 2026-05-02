/**
 * Service-to-service auth for trusted internal callers (e.g., agent-service).
 *
 * The agent-service calls into the monolith on behalf of a real user. We
 * trust those calls iff:
 *   1. The Authorization header is `Bearer <AGENT_SERVICE_TOKEN>` matching
 *      the secret provisioned via Vault / env.
 *   2. The `x-agent-service-id` header is present (used for audit + metrics).
 *   3. For user-scoped resources (orders, etc.), the caller passes the
 *      target user via `x-on-behalf-of-user-id`. The handler treats that
 *      header as the effective user.
 *
 * If the token is missing or wrong, the middleware DOES NOT 401 — it just
 * lets the request fall through to the regular Clerk auth. That way a
 * user calling the same endpoint with a Clerk session still works.
 *
 * Constant-time comparison guards against timing oracles. The token must
 * be at least 32 bytes; shorter values are rejected at process start.
 */

import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { getUserId } from "./auth";

declare module "express" {
  interface Request {
    serviceCaller?: ServiceCaller;
  }
}

export interface ServiceCaller {
  agentId: string;
  sessionId: string | null;
  onBehalfOfUserId: string | null;
}

const MIN_TOKEN_LENGTH = 32;

function safeTokenEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  try {
    return timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}

function readBearer(req: Request): string | null {
  const header = req.headers.authorization ?? req.headers.Authorization;
  if (!header || typeof header !== "string") return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? (m[1] ?? "").trim() : null;
}

function readSingleHeader(req: Request, name: string): string | null {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0] ?? null;
  if (typeof v === "string") return v;
  return null;
}

/**
 * Express middleware. Attaches `req.serviceCaller` when the request
 * presents a valid service token. Always calls next(); does not reject.
 */
export const optionalServiceAuth = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  const expected = process.env.AGENT_SERVICE_TOKEN;
  if (!expected) return next();
  if (expected.length < MIN_TOKEN_LENGTH) {
    // Refuse to honour a weak token. Logged once at startup; here we
    // silently ignore to fail closed.
    return next();
  }
  const token = readBearer(req);
  if (!token) return next();
  if (!safeTokenEqual(token, expected)) return next();
  const agentId = readSingleHeader(req, "x-agent-service-id");
  if (!agentId) return next();
  req.serviceCaller = {
    agentId,
    sessionId: readSingleHeader(req, "x-agent-session-id"),
    onBehalfOfUserId: readSingleHeader(req, "x-on-behalf-of-user-id"),
  };
  return next();
};

/**
 * Returns the effective user id for a user-scoped resource.
 *
 * - When called by agent-service with a service token + an
 *   `x-on-behalf-of-user-id` header, returns that user id.
 * - Otherwise falls back to the Clerk-authenticated user id.
 * - Returns null and writes a 401 if neither is present.
 */
export function requireEffectiveUserId(
  req: Request,
  res: Response,
): string | null {
  if (req.serviceCaller?.onBehalfOfUserId) {
    return req.serviceCaller.onBehalfOfUserId;
  }
  let userId: string | null = null;
  try {
    userId = getUserId(req);
  } catch {
    // getAuth throws when clerkMiddleware hasn't run; treat as anonymous.
    userId = null;
  }
  if (!userId) {
    res
      .status(401)
      .json({ error: "unauthorized", detail: "Sign-in or service token required" });
    return null;
  }
  return userId;
}
