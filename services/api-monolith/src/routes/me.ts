import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { clerkClient } from "@clerk/express";
import { db, schema } from "../lib/db";
import { requireUserId } from "../lib/auth";
import { ensureWalletBootstrapped } from "../lib/wallet";

const router: IRouter = Router();

async function ensureUserRow(userId: string) {
  const existing = await db.select().from(schema.usersTable).where(eq(schema.usersTable.clerkId, userId)).limit(1);
  if (existing.length > 0) return existing[0];

  let email = "";
  let displayName = "";
  let avatarUrl = "";
  try {
    const clerkUser = await clerkClient.users.getUser(userId);
    email = clerkUser.primaryEmailAddress?.emailAddress ?? clerkUser.emailAddresses[0]?.emailAddress ?? "";
    displayName = [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ") || clerkUser.username || email;
    avatarUrl = clerkUser.imageUrl ?? "";
  } catch {
    /* ignore - first call before user exists */
  }
  const [row] = await db
    .insert(schema.usersTable)
    .values({ clerkId: userId, email, displayName, avatarUrl, countryCode: "NG" })
    .onConflictDoUpdate({
      target: schema.usersTable.clerkId,
      set: { email, displayName, avatarUrl },
    })
    .returning();
  await ensureWalletBootstrapped(userId);
  return row;
}

router.get("/me", async (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const user = await ensureUserRow(userId);
  res.json(user);
});

router.patch("/me", async (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  await ensureUserRow(userId);
  const body = req.body as {
    displayName?: string;
    avatarUrl?: string;
    countryCode?: string;
    addresses?: Record<string, unknown>[];
    paymentMethods?: Record<string, unknown>[];
  };
  const update: Partial<typeof schema.usersTable.$inferInsert> = {};
  if (typeof body.displayName === "string") update.displayName = body.displayName;
  if (typeof body.avatarUrl === "string") update.avatarUrl = body.avatarUrl;
  if (typeof body.countryCode === "string") update.countryCode = body.countryCode;
  if (Array.isArray(body.addresses)) update.addresses = body.addresses;
  if (Array.isArray(body.paymentMethods)) update.paymentMethods = body.paymentMethods;
  const [row] = await db
    .update(schema.usersTable)
    .set(update)
    .where(eq(schema.usersTable.clerkId, userId))
    .returning();
  res.json(row);
});

export default router;
