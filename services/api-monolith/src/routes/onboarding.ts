import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { requireUserId } from "../lib/auth";

const router: IRouter = Router();

function rowToView(r: typeof schema.onboardingTable.$inferSelect | undefined) {
  return {
    completed: r?.completed ?? false,
    interests: r?.interests ?? [],
    notificationsOptIn: r?.notificationsOptIn ?? false,
    completedAtIso: r?.completedAt?.toISOString() ?? null,
  };
}

router.get("/onboarding", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const [row] = await db.select().from(schema.onboardingTable).where(eq(schema.onboardingTable.userId, userId)).limit(1);
  res.json(rowToView(row));
});

router.post("/onboarding/complete", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const body = req.body as { interests?: string[]; notificationsOptIn?: boolean };
  const interests = Array.isArray(body.interests) ? body.interests.map(String) : [];
  const notificationsOptIn = Boolean(body.notificationsOptIn);
  const [row] = await db
    .insert(schema.onboardingTable)
    .values({
      userId,
      completed: true,
      interests,
      notificationsOptIn,
      completedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.onboardingTable.userId,
      set: { completed: true, interests, notificationsOptIn, completedAt: new Date() },
    })
    .returning();
  res.json(rowToView(row));
});

export default router;
