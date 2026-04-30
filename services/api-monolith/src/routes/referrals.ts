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
 * INTERNAL ONLY — record a referral payout. This is the producer site for
 * the `referral_payout` notification. It is intentionally not part of the
 * public client-facing API and is gated by a server-side shared secret
 * (process.env.INTERNAL_API_KEY) presented in the `x-internal-key` header.
 * Only the back-office payout job / finance worker is expected to call it.
 *
 * Authorization rules (all required):
 *   1. INTERNAL_API_KEY env var must be set (no insecure default — if
 *      unset, the route always 503s so a misconfigured deploy can never
 *      become an open endpoint).
 *   2. Request must present a matching `x-internal-key` header.
 *   3. The target user must already have a referrals row (i.e. owns a
 *      referral code) — payouts cannot be minted for arbitrary users.
 *   4. Reward amount comes from the request but is bounded to a sane cap
 *      (REFERRAL_REWARD_CAP_MINOR) to limit blast radius if the secret
 *      ever leaks. The cap is intentionally conservative.
 *
 * This trades broader payout-source modelling (true conversion linkage)
 * for a small, auditable producer surface — sufficient to drive the
 * notification pipeline end-to-end without exposing user-controllable
 * "paid" writes. Tightening to per-conversion linkage is tracked as a
 * follow-up once a payout pipeline exists.
 */
const REFERRAL_REWARD_CAP_MINOR = 10_000_00; // ₦10,000 per row; tune via ops if needed
router.post("/referrals/payout", async (req, res) => {
  const expected = process.env.INTERNAL_API_KEY;
  if (!expected) {
    res.status(503).json({ error: "not_configured", detail: "INTERNAL_API_KEY unset" });
    return;
  }
  const presented = req.header("x-internal-key");
  if (!presented || presented !== expected) {
    res.status(403).json({ error: "forbidden", detail: "internal endpoint" });
    return;
  }
  const body = (req.body ?? {}) as {
    userId?: unknown;
    inviteeHandle?: unknown;
    rewardMinor?: unknown;
    activityId?: unknown;
  };
  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  const inviteeHandle = typeof body.inviteeHandle === "string" ? body.inviteeHandle.trim() : "";
  const rewardMinorRaw = Number.isFinite(body.rewardMinor) ? Math.floor(body.rewardMinor as number) : 0;
  const rewardMinor = Math.min(Math.max(0, rewardMinorRaw), REFERRAL_REWARD_CAP_MINOR);
  if (!userId || !inviteeHandle || rewardMinor <= 0) {
    res.status(400).json({ error: "bad_request", detail: "userId, inviteeHandle, positive rewardMinor required" });
    return;
  }
  // Caller must already own a referral code — guards against minting
  // payouts for arbitrary userIds even with the internal key.
  const [referral] = await db
    .select({ userId: schema.referralsTable.userId })
    .from(schema.referralsTable)
    .where(eq(schema.referralsTable.userId, userId))
    .limit(1);
  if (!referral) {
    res.status(404).json({ error: "no_referral", detail: "user has no referral code" });
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
