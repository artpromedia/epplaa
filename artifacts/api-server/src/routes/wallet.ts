import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { requireUserId } from "../lib/auth";
import { newWalletTxnId, newPayoutId, newPayoutReference } from "../lib/ids";
import { ensureWalletBootstrapped, getWalletState } from "../lib/wallet";
import { createPaymentIntent } from "../lib/payments";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.get("/wallet", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  res.json(await getWalletState(userId));
});

/**
 * POST /wallet/topup — Now creates a real payment intent. The wallet balance
 * is only credited when the gateway webhook confirms payment (via
 * markIntentSucceeded which inserts the wallet_txns row).
 *
 * Returns the intent so the frontend can redirect to the gateway.
 */
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

  const appOrigin = `${req.protocol}://${req.get("host")}`;
  try {
    const result = await createPaymentIntent({
      userId,
      email: `${userId}@epplaa.local`,
      purpose: "wallet_topup",
      amountMinor: amount,
      currencyCode: (await getWalletState(userId)).currencyCode,
      buildCallbackUrl: (intentId) =>
        `${appOrigin}/wallet?topup=${encodeURIComponent(intentId)}`,
      metadata: { label: body.label ?? "Wallet top-up", minorPerMajor: 100 },
    });
    res.json({
      ...(await getWalletState(userId)),
      pendingTopup: {
        intentId: result.intent.id,
        reference: result.intent.reference,
        gateway: result.intent.gateway,
        amountMinor: amount,
        authorizationUrl: result.authorizationUrl ?? null,
        status: result.intent.status,
      },
    });
  } catch (err) {
    logger.error({ err: (err as Error).message, userId }, "wallet_topup_failed");
    res.status(502).json({ error: "topup_init_failed", detail: (err as Error).message });
  }
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

/**
 * POST /wallet/withdraw — Creates a payout row in `pending` state. The
 * payouts cron picks it up and triggers the gateway transfer. The wallet
 * balance is debited immediately (via wallet_txn) so the user's available
 * balance reflects the in-flight withdrawal.
 */
router.post("/wallet/withdraw", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const state = await getWalletState(userId);
  const body = req.body as {
    amountMinor?: number;
    destinationLabel?: string;
    bankCode?: string;
    bankLast4?: string;
  };
  const amount = Number(body.amountMinor ?? 0);
  if (amount <= 0 || !body.destinationLabel) {
    res.status(400).json({ error: "bad_request" });
    return;
  }
  if (state.balanceMinor < amount) {
    res.status(400).json({ error: "insufficient_funds" });
    return;
  }
  const payoutId = newPayoutId();
  const reference = newPayoutReference();
  await db.insert(schema.payoutsTable).values({
    id: payoutId,
    userId,
    sellerId: userId,
    amountMinor: amount,
    currencyCode: state.currencyCode,
    status: "pending",
    kind: "wallet_withdrawal",
    bankLabel: body.destinationLabel,
    bankCode: body.bankCode ?? "",
    bankLast4: body.bankLast4 ?? "0000",
    reference,
    holdUntil: new Date(),
    gateway: "paystack",
  });
  await db.insert(schema.walletTxnsTable).values({
    id: newWalletTxnId(),
    userId,
    kind: "withdrawal",
    amountMinor: -amount,
    label: `Withdraw to ${body.destinationLabel}`,
    status: "pending",
    payoutId,
  });
  res.json({
    ...(await getWalletState(userId)),
    pendingWithdrawal: { payoutId, reference, amountMinor: amount, status: "pending" },
  });
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
