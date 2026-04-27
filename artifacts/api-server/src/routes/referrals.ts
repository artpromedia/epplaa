import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { requireUserId } from "../lib/auth";
import { newReferralCode } from "../lib/ids";

const router: IRouter = Router();

router.get("/referrals/me", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  let [row] = await db.select().from(schema.referralsTable).where(eq(schema.referralsTable.userId, userId)).limit(1);
  if (!row) {
    const code = newReferralCode();
    [row] = await db
      .insert(schema.referralsTable)
      .values({ userId, code })
      .onConflictDoUpdate({ target: schema.referralsTable.userId, set: { code } })
      .returning();
  }
  const activity = await db
    .select()
    .from(schema.referralActivityTable)
    .where(eq(schema.referralActivityTable.userId, userId))
    .orderBy(desc(schema.referralActivityTable.createdAt));
  res.json({
    code: row.code,
    shareLink: `https://epplaa.app/i/${row.code}`,
    activity: activity.map((a) => ({
      id: a.id,
      inviteeHandle: a.inviteeHandle,
      status: a.status,
      rewardMinor: a.rewardMinor,
      atIso: a.createdAt.toISOString(),
    })),
  });
});

export default router;
