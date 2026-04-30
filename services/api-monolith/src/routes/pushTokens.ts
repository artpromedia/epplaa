import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { requireUserId } from "../lib/auth";
import { newSafeId } from "../lib/ids";

const router: IRouter = Router();

router.get("/web-push/vapid-public-key", async (_req: Request, res: Response) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY ?? null });
});

/**
 * Register a push token. `kind` = "web" (Web Push subscription JSON) or
 * "fcm" (registration id). Idempotent on (userId, token) so the SPA can
 * call this on every load without growing the table.
 */
router.post("/push-tokens", async (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const body = req.body as {
    kind?: string;
    token?: string;
    endpoint?: string;
    p256dh?: string;
    auth?: string;
    userAgent?: string;
  };
  const kind = body.kind === "fcm" ? "fcm" : "web";
  const token = String(body.token ?? "").trim();
  if (!token) {
    res.status(400).json({ error: "missing_token" });
    return;
  }
  const [row] = await db
    .insert(schema.pushTokensTable)
    .values({
      id: newSafeId("pt"),
      userId,
      kind,
      token,
      endpoint: body.endpoint ?? "",
      p256dh: body.p256dh ?? "",
      auth: body.auth ?? "",
      userAgent: body.userAgent ?? "",
      lastUsedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [schema.pushTokensTable.userId, schema.pushTokensTable.token],
      set: { lastUsedAt: new Date(), userAgent: body.userAgent ?? "" },
    })
    .returning();
  res.json({ ok: true, id: row.id });
});

router.delete("/push-tokens", async (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const token = String((req.query.token as string) ?? "").trim();
  if (!token) {
    res.status(400).json({ error: "missing_token" });
    return;
  }
  await db
    .delete(schema.pushTokensTable)
    .where(and(eq(schema.pushTokensTable.userId, userId), eq(schema.pushTokensTable.token, token)));
  res.json({ ok: true });
});

export default router;
