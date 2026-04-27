import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { requireUserId } from "../lib/auth";

const router: IRouter = Router();

const DEFAULT = {
  liveDrops: true,
  orderUpdates: true,
  marketing: false,
  promos: true,
  referrals: true,
  walletCredits: true,
  whatsapp: true,
  sms: false,
  push: true,
  email: true,
  whatsappNumber: "",
  smsNumber: "",
  quietHoursEnabled: false,
  quietHoursStartMinutes: null as number | null,
  quietHoursEndMinutes: null as number | null,
  timezone: "",
};

function rowToView(r: typeof schema.notificationPrefsTable.$inferSelect | undefined) {
  if (!r) return DEFAULT;
  return {
    liveDrops: r.liveDrops,
    orderUpdates: r.orderUpdates,
    marketing: r.marketing,
    promos: r.promos,
    referrals: r.referrals,
    walletCredits: r.walletCredits,
    whatsapp: r.whatsapp,
    sms: r.sms,
    push: r.push,
    email: r.email,
    whatsappNumber: r.whatsappNumber,
    smsNumber: r.smsNumber,
    quietHoursEnabled: r.quietHoursEnabled,
    quietHoursStartMinutes: r.quietHoursStartMinutes,
    quietHoursEndMinutes: r.quietHoursEndMinutes,
    timezone: r.timezone,
  };
}

router.get("/notification-prefs", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const [row] = await db
    .select()
    .from(schema.notificationPrefsTable)
    .where(eq(schema.notificationPrefsTable.userId, userId))
    .limit(1);
  res.json(rowToView(row));
});

router.put("/notification-prefs", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const body = req.body as Partial<typeof DEFAULT>;
  const merged = { ...DEFAULT, ...body };
  const [row] = await db
    .insert(schema.notificationPrefsTable)
    .values({ userId, ...merged })
    .onConflictDoUpdate({ target: schema.notificationPrefsTable.userId, set: merged })
    .returning();
  res.json(rowToView(row));
});

export default router;
