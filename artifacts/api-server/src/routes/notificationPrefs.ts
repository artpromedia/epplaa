import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { requireUserId } from "../lib/auth";

const router: IRouter = Router();

const DEFAULT = {
  liveDrops: true,
  orderUpdates: true,
  marketing: false,
  whatsapp: true,
  sms: false,
  whatsappNumber: "",
  smsNumber: "",
};

function rowToView(r: typeof schema.notificationPrefsTable.$inferSelect | undefined) {
  if (!r) return DEFAULT;
  return {
    liveDrops: r.liveDrops,
    orderUpdates: r.orderUpdates,
    marketing: r.marketing,
    whatsapp: r.whatsapp,
    sms: r.sms,
    whatsappNumber: r.whatsappNumber,
    smsNumber: r.smsNumber,
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
