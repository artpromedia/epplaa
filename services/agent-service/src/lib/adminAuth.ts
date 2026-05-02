/**
 * Admin auth — minimal Bearer-token guard for the agent-service /admin
 * routes. The token is sourced from `AGENT_ADMIN_TOKEN` (>= 32 bytes).
 *
 * This is intentionally separate from the dispatcher's
 * AGENT_SERVICE_TOKEN: the admin token authorises mutating prompt
 * versions and should be issued only to the platform team's tooling
 * (CLI / admin panel service account), whereas the service token
 * authorises the dispatcher to call the monolith on behalf of users.
 */

import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

const MIN_TOKEN_LENGTH = 32;

function safeTokenEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function requireAdminToken(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const expected = process.env.AGENT_ADMIN_TOKEN;
  if (!expected || expected.length < MIN_TOKEN_LENGTH) {
    // Fail closed: when the token is unset/weak, admin routes are
    // disabled rather than left unauthenticated.
    res.status(503).json({
      error: "admin_unavailable",
      detail: "AGENT_ADMIN_TOKEN is not configured",
    });
    return;
  }
  const header = req.header("authorization");
  const presented = header?.startsWith("Bearer ")
    ? header.slice("Bearer ".length).trim()
    : "";
  if (!presented || !safeTokenEqual(presented, expected)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}
