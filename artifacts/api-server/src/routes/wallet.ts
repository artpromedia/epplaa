import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { requireUserId } from "../lib/auth";
import { newWalletTxnId } from "../lib/ids";
import { ensureWalletBootstrapped, getWalletState } from "../lib/wallet";

const router: IRouter = Router();

router.get("/wallet", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  res.json(await getWalletState(userId));
});

router.post("/wallet/topup", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  await ensureWalletBootstrapped(userId);
  const body = req.body as { amountMinor?: number; label?: string };
  const amount = Number(body.amountMinor ?? 0);
  if (amount <= 0) {
    res.status(400).json({ error: "bad_request", detail: "amount must be positive" });
    return;
  }
  await db.insert(schema.walletTxnsTable).values({
    id: newWalletTxnId(),
    userId,
    kind: "topup",
    amountMinor: amount,
    label: body.label ?? "Top up",
  });
  res.json(await getWalletState(userId));
});

router.post("/wallet/spend", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const state = await getWalletState(userId);
  const body = req.body as { amountMinor?: number; label?: string; refId?: string };
  const amount = Number(body.amountMinor ?? 0);
  if (amount <= 0 || !body.label) {
    res.status(400).json({ error: "bad_request" });
    return;
  }
  if (state.balanceMinor < amount) {
    res.status(400).json({ error: "insufficient_funds" });
    return;
  }
  await db.insert(schema.walletTxnsTable).values({
    id: newWalletTxnId(),
    userId,
    kind: "spend",
    amountMinor: -amount,
    label: body.label,
    refId: body.refId ?? null,
  });
  res.json(await getWalletState(userId));
});

router.post("/wallet/withdraw", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const state = await getWalletState(userId);
  const body = req.body as { amountMinor?: number; destinationLabel?: string };
  const amount = Number(body.amountMinor ?? 0);
  if (amount <= 0 || !body.destinationLabel) {
    res.status(400).json({ error: "bad_request" });
    return;
  }
  if (state.balanceMinor < amount) {
    res.status(400).json({ error: "insufficient_funds" });
    return;
  }
  await db.insert(schema.walletTxnsTable).values({
    id: newWalletTxnId(),
    userId,
    kind: "withdrawal",
    amountMinor: -amount,
    label: `Withdraw to ${body.destinationLabel}`,
  });
  res.json(await getWalletState(userId));
});

router.post("/wallet/refund", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  await ensureWalletBootstrapped(userId);
  const body = req.body as { returnId?: string; amountMinor?: number; label?: string };
  if (!body.returnId || !body.amountMinor || !body.label) {
    res.status(400).json({ error: "bad_request" });
    return;
  }
  await db
    .insert(schema.walletTxnsTable)
    .values({
      id: newWalletTxnId(),
      userId,
      kind: "refund",
      amountMinor: Number(body.amountMinor),
      label: body.label,
      refId: body.returnId,
    });
  res.json(await getWalletState(userId));
});

router.patch("/wallet/settings", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  await ensureWalletBootstrapped(userId);
  const currencyCode = String((req.body as { currencyCode?: string }).currencyCode ?? "NGN");
  await db
    .update(schema.walletSettingsTable)
    .set({ currencyCode })
    .where(eq(schema.walletSettingsTable.userId, userId));
  res.json(await getWalletState(userId));
});

export default router;
