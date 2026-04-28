import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { requireUserId } from "../lib/auth";
import { newReferralCode } from "../lib/ids";
import { enqueueNotification } from "../lib/notifications";
import { logger } from "../lib/logger";

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

/**
 * Record a referral payout for the calling user. The caller is the referrer
 * (sponsor) — i.e. the person whose code was used. Inserts a referral_activity
 * row with status="paid" and enqueues a `referral_payout` notification so the
 * notifications channel + prefs pipeline actually delivers it.
 *
 * In the absence of a separate finance/back-office payout pipeline, this
 * endpoint is the producer site for that event. Authenticated users can
 * acknowledge their own settled rewards (idempotent on activityId).
 */
router.post("/referrals/payout", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const body = (req.body ?? {}) as {
    inviteeHandle?: unknown;
    rewardMinor?: unknown;
    activityId?: unknown;
  };
  const inviteeHandle = typeof body.inviteeHandle === "string" ? body.inviteeHandle.trim() : "";
  const rewardMinor = Number.isFinite(body.rewardMinor) ? Math.max(0, Math.floor(body.rewardMinor as number)) : 0;
  if (!inviteeHandle || rewardMinor <= 0) {
    res.status(400).json({ error: "bad_request", detail: "inviteeHandle and positive rewardMinor required" });
    return;
  }
  const activityId = typeof body.activityId === "string" && body.activityId
    ? body.activityId
    : `ra_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const [row] = await db
    .insert(schema.referralActivityTable)
    .values({ id: activityId, userId, inviteeHandle, status: "paid", rewardMinor })
    .onConflictDoNothing()
    .returning();
  if (!row) {
    res.json({ ok: true, alreadyRecorded: true });
    return;
  }
  try {
    await enqueueNotification({
      userId,
      eventType: "referral_payout",
      payload: {
        title: "Referral reward paid",
        body: `You earned ${(rewardMinor / 100).toFixed(2)} from inviting ${inviteeHandle}.`,
        url: "/account/referrals",
        activityId: row.id,
        rewardMinor,
      },
    });
  } catch (err) {
    logger.error({ err: (err as Error).message, activityId: row.id }, "notify_referral_payout_failed");
  }
  res.json({ ok: true, alreadyRecorded: false });
});

export default router;
