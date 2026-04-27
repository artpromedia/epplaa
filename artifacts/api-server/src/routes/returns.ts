import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { requireUserId } from "../lib/auth";
import { newReturnId, newWalletTxnId } from "../lib/ids";

const router: IRouter = Router();

interface TimelineEvent {
  status: string;
  atIso: string;
  note?: string;
}
interface DisputeMessage {
  id: string;
  actor: "buyer" | "seller" | "epplaa";
  body: string;
  atIso: string;
}

function rowToReturn(r: typeof schema.returnsTable.$inferSelect) {
  return {
    id: r.id,
    userId: r.userId,
    orderId: r.orderId,
    productTitle: r.productTitle,
    productImage: r.productImage,
    refundAmountMinor: r.refundAmountMinor,
    currencyCode: r.currencyCode,
    reason: r.reason,
    reasonLabel: r.reasonLabel,
    notes: r.notes,
    photoCount: r.photoCount,
    status: r.status,
    timeline: r.timeline,
    dispute: r.dispute,
    createdAtIso: r.createdAt.toISOString(),
  };
}

async function maybeRefundWallet(userId: string, ret: typeof schema.returnsTable.$inferSelect) {
  if (ret.status !== "refunded") return;
  const existing = await db
    .select({ id: schema.walletTxnsTable.id })
    .from(schema.walletTxnsTable)
    .where(
      and(
        eq(schema.walletTxnsTable.userId, userId),
        eq(schema.walletTxnsTable.refId, ret.id),
        eq(schema.walletTxnsTable.kind, "refund"),
      ),
    )
    .limit(1);
  if (existing.length > 0) return;
  await db.insert(schema.walletTxnsTable).values({
    id: newWalletTxnId(),
    userId,
    kind: "refund",
    amountMinor: ret.refundAmountMinor,
    label: `Refund ${ret.id}`,
    refId: ret.id,
  });
}

router.get("/returns", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const rows = await db
    .select()
    .from(schema.returnsTable)
    .where(eq(schema.returnsTable.userId, userId))
    .orderBy(desc(schema.returnsTable.createdAt));
  res.json(rows.map(rowToReturn));
});

router.get("/returns/:returnId", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const [row] = await db
    .select()
    .from(schema.returnsTable)
    .where(and(eq(schema.returnsTable.userId, userId), eq(schema.returnsTable.id, req.params.returnId)))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(rowToReturn(row));
});

router.post("/returns", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const body = req.body as Record<string, unknown>;
  const id = newReturnId();
  const now = new Date().toISOString();
  const initial: TimelineEvent[] = [{ status: "requested", atIso: now }];
  const [row] = await db
    .insert(schema.returnsTable)
    .values({
      id,
      userId,
      orderId: String(body.orderId ?? ""),
      productTitle: String(body.productTitle ?? ""),
      productImage: (body.productImage as string | undefined) ?? null,
      refundAmountMinor: Number(body.refundAmountMinor ?? 0),
      currencyCode: String(body.currencyCode ?? "NGN"),
      reason: String(body.reason ?? "other"),
      reasonLabel: String(body.reasonLabel ?? "Other"),
      notes: String(body.notes ?? ""),
      photoCount: Number(body.photoCount ?? 0),
      status: "requested",
      timeline: initial,
      dispute: [],
    })
    .returning();
  res.status(201).json(rowToReturn(row));
});

router.post("/returns/:returnId/transitions", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const status = String((req.body as { status?: string }).status ?? "");
  if (!status) {
    res.status(400).json({ error: "bad_request", detail: "status required" });
    return;
  }
  const [existing] = await db
    .select()
    .from(schema.returnsTable)
    .where(and(eq(schema.returnsTable.userId, userId), eq(schema.returnsTable.id, req.params.returnId)))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const timeline = ([...(existing.timeline as TimelineEvent[])]).concat([{ status, atIso: new Date().toISOString() }]);
  const [row] = await db
    .update(schema.returnsTable)
    .set({ status, timeline })
    .where(eq(schema.returnsTable.id, existing.id))
    .returning();
  await maybeRefundWallet(userId, row);
  res.json(rowToReturn(row));
});

router.post("/returns/:returnId/messages", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const body = req.body as { actor?: string; body?: string };
  if (!body.actor || !body.body) {
    res.status(400).json({ error: "bad_request" });
    return;
  }
  const [existing] = await db
    .select()
    .from(schema.returnsTable)
    .where(and(eq(schema.returnsTable.userId, userId), eq(schema.returnsTable.id, req.params.returnId)))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const dispute: DisputeMessage[] = ([...(existing.dispute as DisputeMessage[])]).concat([
    {
      id: `msg_${Date.now().toString(36)}`,
      actor: body.actor as DisputeMessage["actor"],
      body: body.body,
      atIso: new Date().toISOString(),
    },
  ]);
  const [row] = await db.update(schema.returnsTable).set({ dispute }).where(eq(schema.returnsTable.id, existing.id)).returning();
  res.json(rowToReturn(row));
});

export default router;
