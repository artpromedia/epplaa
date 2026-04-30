import type { Request, Response, NextFunction, RequestHandler } from "express";
import { getAuth } from "@clerk/express";

export function getUserId(req: Request): string | null {
  const auth = getAuth(req);
  return auth?.userId ?? null;
}

// True iff the active Clerk session has a verified second factor.
// Reads `fva` ([firstFactorAge, secondFactorAge] in minutes); >=0 in
// the second slot = verified. Authoritative for the operator-MFA gate.
export function hasMfaVerifiedSession(req: Request): boolean {
  const auth = getAuth(req) as
    | (ReturnType<typeof getAuth> & {
        factorVerificationAge?: [number, number] | null;
        sessionClaims?: { fva?: [number, number] | null } | null;
      })
    | null;
  if (!auth) return false;
  const fromTyped = auth.factorVerificationAge;
  const fromClaim = auth.sessionClaims?.fva ?? null;
  const tuple = Array.isArray(fromTyped) ? fromTyped : fromClaim;
  if (!Array.isArray(tuple) || tuple.length < 2) return false;
  const secondFactorAge = tuple[1];
  return typeof secondFactorAge === "number" && secondFactorAge >= 0;
}

export const requireAuth: RequestHandler = (req, res, next) => {
  const userId = getUserId(req);
  if (!userId) {
    res.status(401).json({ error: "unauthorized", detail: "Sign-in required" });
    return;
  }
  next();
};

export function requireUserId(req: Request, res: Response): string | null {
  const userId = getUserId(req);
  if (!userId) {
    res.status(401).json({ error: "unauthorized", detail: "Sign-in required" });
    return null;
  }
  return userId;
}
