import type { Request, Response, NextFunction, RequestHandler } from "express";
import { getAuth } from "@clerk/express";

export function getUserId(req: Request): string | null {
  const auth = getAuth(req);
  return auth?.userId ?? null;
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
