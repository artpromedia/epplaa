import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { requireUserId } from "../lib/auth";
import { newOrderId, newOtp } from "../lib/ids";

const router: IRouter = Router();

function rowToOrder(r: typeof schema.ordersTable.$inferSelect) {
  return {
    id: r.id,
    userId: r.userId,
    status: r.status,
    countryCode: r.countryCode,
    currencyCode: r.currencyCode,
    items: r.items,
    fulfillment: r.fulfillment,
    payment: r.payment,
    notificationPrefs: r.notificationPrefs,
    totalsMinor: r.totalsMinor,
    promo: r.promo ?? undefined,
    pickupOtp: r.pickupOtp,
    etaLabel: r.etaLabel,
    createdAtIso: r.createdAt.toISOString(),
  };
}

router.get("/orders", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const rows = await db
    .select()
    .from(schema.ordersTable)
    .where(eq(schema.ordersTable.userId, userId))
    .orderBy(desc(schema.ordersTable.createdAt));
  res.json(rows.map(rowToOrder));
});

router.get("/orders/:orderId", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const [row] = await db
    .select()
    .from(schema.ordersTable)
    .where(and(eq(schema.ordersTable.userId, userId), eq(schema.ordersTable.id, req.params.orderId)))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(rowToOrder(row));
});

router.post("/orders", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const body = req.body as Record<string, unknown>;
  const id = (body.id as string | undefined) ?? newOrderId();
  const fulfillment = (body.fulfillment as Record<string, unknown> | undefined) ?? {};
  const needsOtp = ["epplaa-box", "pudo", "epplaa-box-accra", "speedaf-pickup", "epplaa-box-nbo", "g4s-pickup", "pargo-locker", "paxi-pickup", "epplaa-box-abj", "pickup-ci"].includes(
    String(fulfillment.optionId ?? ""),
  );
  const [row] = await db
    .insert(schema.ordersTable)
    .values({
      id,
      userId,
      status: "placed",
      countryCode: String(body.countryCode ?? "NG"),
      currencyCode: String(body.currencyCode ?? "NGN"),
      items: (body.items as unknown[] | undefined) ?? [],
      fulfillment,
      payment: (body.payment as Record<string, unknown> | undefined) ?? {},
      notificationPrefs: (body.notificationPrefs as Record<string, unknown> | undefined) ?? {},
      totalsMinor: (body.totalsMinor as Record<string, unknown> | undefined) ?? {},
      promo: (body.promo as Record<string, unknown> | undefined) ?? null,
      pickupOtp: needsOtp ? newOtp() : null,
      etaLabel: String(body.etaLabel ?? ""),
    })
    .returning();
  // Clear cart + draft after placing.
  await db.delete(schema.cartItemsTable).where(eq(schema.cartItemsTable.userId, userId));
  await db.delete(schema.checkoutDraftsTable).where(eq(schema.checkoutDraftsTable.userId, userId));
  res.status(201).json(rowToOrder(row));
});

router.post("/orders/:orderId/cancel", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const [existing] = await db
    .select()
    .from(schema.ordersTable)
    .where(and(eq(schema.ordersTable.userId, userId), eq(schema.ordersTable.id, req.params.orderId)))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (existing.status === "delivered" || existing.status === "cancelled") {
    res.json(rowToOrder(existing));
    return;
  }
  const [row] = await db
    .update(schema.ordersTable)
    .set({ status: "cancelled" })
    .where(and(eq(schema.ordersTable.userId, userId), eq(schema.ordersTable.id, req.params.orderId)))
    .returning();
  res.json(rowToOrder(row));
});

export default router;
