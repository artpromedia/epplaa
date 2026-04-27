import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, desc, ne, sql } from "drizzle-orm";
import type { GatewayName } from "@workspace/payments";
import { DevMockGateway } from "@workspace/payments";
import { db, schema } from "../lib/db";
import { requireUserId } from "../lib/auth";
import { logger } from "../lib/logger";
import {
  createPaymentIntent,
  gateways,
  markIntentSucceeded,
  reverifyIntent,
  logAttempt,
  clawbackPayoutsForRefund,
  PAYMENTS_MODE,
} from "../lib/payments";
import { newRefundId } from "../lib/ids";

const router: IRouter = Router();

/**
 * GET /api/payments/mode — surfaces whether we're in dev-mock mode so the
 * frontend can show a "test mode" banner.
 */
router.get("/payments/mode", (_req, res) => {
  res.json({ mode: PAYMENTS_MODE });
});

/** GET /api/payments/intents/:intentId — load any intent owned by the caller. */
router.get("/payments/intents/:intentId", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const [row] = await db
    .select()
    .from(schema.paymentIntentsTable)
    .where(
      and(
        eq(schema.paymentIntentsTable.userId, userId),
        eq(schema.paymentIntentsTable.id, String(req.params.intentId)),
      ),
    )
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(serializeIntent(row));
});

/**
 * POST /api/payments/intents/:intentId/verify — re-verify status with the
 * gateway. The frontend calls this after returning from the gateway redirect
 * to short-circuit waiting for the webhook.
 */
router.post("/payments/intents/:intentId/verify", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const [intent] = await db
    .select()
    .from(schema.paymentIntentsTable)
    .where(
      and(
        eq(schema.paymentIntentsTable.userId, userId),
        eq(schema.paymentIntentsTable.id, String(req.params.intentId)),
      ),
    )
    .limit(1);
  if (!intent) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const updated = await reverifyIntent(intent.id);
  res.json(serializeIntent(updated));
});

/**
 * POST /api/orders/:orderId/refund — buyer self-serve refund eligibility check
 * + full refund through the original gateway.
 *
 * Eligibility (lightweight):
 *   - Order must be paid (paidAt set) and not already refunded.
 *   - Order must not be older than 14 days from payment.
 *   - Pickup orders that are already delivered are NOT eligible (use returns).
 */
router.post("/orders/:orderId/refund", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const [order] = await db
    .select()
    .from(schema.ordersTable)
    .where(and(eq(schema.ordersTable.userId, userId), eq(schema.ordersTable.id, String(req.params.orderId))))
    .limit(1);
  if (!order) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (!order.paidAt || !order.paymentIntentId || !order.gatewayReference) {
    res.status(400).json({ error: "not_paid" });
    return;
  }
  if (order.status === "refunded") {
    res.status(400).json({ error: "already_refunded" });
    return;
  }
  if (order.status === "cancelled") {
    res.status(400).json({ error: "order_cancelled" });
    return;
  }
  const ageDays = (Date.now() - order.paidAt.getTime()) / (24 * 3600 * 1000);
  if (ageDays > 14) {
    res.status(400).json({ error: "refund_window_expired" });
    return;
  }
  if (order.status === "delivered") {
    res.status(400).json({ error: "use_returns_flow" });
    return;
  }

  /*
   * CAS refund lock — acquire `refundStartedAt` atomically. Two concurrent
   * POST /orders/:orderId/refund requests will both pass the SELECT-then-
   * check above; only one can flip `refund_started_at` from NULL → now()
   * here, and the loser gets HTTP 409. This prevents double gateway
   * charges on the same order.
   */
  const lockResult = await db
    .update(schema.ordersTable)
    .set({ refundStartedAt: new Date() })
    .where(
      and(
        eq(schema.ordersTable.id, order.id),
        sql`${schema.ordersTable.refundStartedAt} IS NULL`,
        ne(schema.ordersTable.status, "refunded"),
        ne(schema.ordersTable.status, "cancelled"),
      ),
    )
    .returning({ id: schema.ordersTable.id });
  if (lockResult.length === 0) {
    res.status(409).json({ error: "refund_in_progress" });
    return;
  }

  const gatewayName = (order.gateway as GatewayName) ?? "devmock";
  const gw = gatewayName === "paystack" ? gateways.paystack : gatewayName === "flutterwave" ? gateways.flutterwave : gateways.devMock;
  const reason = String((req.body as { reason?: string }).reason ?? "buyer_requested_refund");

  const totals = (order.totalsMinor as { total?: number }) ?? {};
  const refundAmount = Number(totals.total ?? 0);

  const refundId = newRefundId();
  /*
   * Lock-release policy:
   *
   *   - `gatewayCalled` flips true the instant we are about to invoke
   *     gw.refund(...). Once the gateway has been contacted, the
   *     authoritative source of truth for the refund is the gateway
   *     itself — even if the gateway request throws, we cannot know
   *     whether it processed (network blip on the response leg). To
   *     prevent any chance of a double charge we KEEP the CAS lock
   *     held in that case and surface a 500 so finance/ops can
   *     reconcile via the gateway's lookup API. The buyer cannot
   *     retry until the lock is cleared by the reconciliation worker
   *     or manual intervention.
   *
   *   - We only release the lock automatically when we are certain
   *     no money has moved, i.e. the audit insert failed before
   *     gw.refund(...) ran, or the gateway returned a clean
   *     `result.ok === false` (transport/business failure that the
   *     gateway acknowledges as not-charged).
   */
  let gatewayCalled = false;
  let releaseLock = false;
  try {
    await db.insert(schema.refundAttemptsTable).values({
      id: refundId,
      intentId: order.paymentIntentId,
      orderId: order.id,
      amountMinor: refundAmount,
      reason,
      status: "pending",
      gateway: gatewayName,
    });

    gatewayCalled = true;
    const result = await gw.refund({
      reference: order.gatewayReference,
      amountMinor: refundAmount,
      reason,
    });

    await logAttempt({
      intentId: order.paymentIntentId,
      gateway: gatewayName,
      kind: "refund",
      status: result.ok ? "ok" : "error",
      gatewayReference: result.refundReference,
      errorMessage: result.errorMessage,
    });

    // Persist gateway reference/error now, but keep status='pending'
    // until clawback + status flips commit (set at end of branch).
    await db
      .update(schema.refundAttemptsTable)
      .set({
        status: result.ok ? "pending" : "failed",
        gatewayReference: result.refundReference || null,
        errorMessage: result.errorMessage ?? null,
        resolvedAt: result.ok ? null : new Date(),
      })
      .where(eq(schema.refundAttemptsTable.id, refundId));

    if (result.ok && result.status === "processed") {
      // Clawback first, then status flips, then mark audit row processed.
      // A crash mid-finalize keeps the row 'pending' so retries (webhook
      // or recovery sweep) re-finalize via the idempotent clawback path.
      const clawback = await clawbackPayoutsForRefund(order.id, reason);
      await db
        .update(schema.ordersTable)
        .set({ status: "refunded" })
        .where(eq(schema.ordersTable.id, order.id));
      await db
        .update(schema.paymentIntentsTable)
        .set({ status: "refunded" })
        .where(eq(schema.paymentIntentsTable.id, order.paymentIntentId));
      // Mark the audit row processed last so retries see it pending
      // until clawback + status-flip have both committed.
      await db
        .update(schema.refundAttemptsTable)
        .set({ status: "processed", resolvedAt: new Date() })
        .where(eq(schema.refundAttemptsTable.id, refundId));
      logger.info(
        { orderId: order.id, refundId, ...clawback },
        "refund_completed_with_clawback",
      );
      res.json({
        ok: true,
        status: "processed",
        refundId,
        refundReference: result.refundReference,
        payoutsCancelled: clawback.cancelled,
        payoutsRequiringClawback: clawback.clawbackRequired,
      });
      // Lock stays held forever via the now-`refunded` status guard
      // (the CAS WHERE clause excludes status='refunded'). No release.
      return;
    } else if (result.ok && result.status === "pending") {
      /*
       * Async refund: the gateway accepted the request but settlement
       * is asynchronous. Do NOT mark the order refunded yet — the
       * refund webhook (or the recovery sweep, when the audit row is
       * eventually flipped to 'processed') will finalize. Keep the
       * CAS lock held to prevent a second refund attempt while the
       * first is still in flight on the gateway side.
       */
      logger.info(
        { orderId: order.id, refundId, refundReference: result.refundReference },
        "refund_accepted_pending_async_settlement",
      );
      res.status(202).json({
        ok: true,
        status: "pending",
        refundId,
        refundReference: result.refundReference,
      });
      return;
    } else {
      // Gateway acknowledged failure: no money moved. Safe to release
      // the lock so the buyer can retry.
      releaseLock = true;
      res.status(502).json({ error: "refund_failed", detail: result.errorMessage ?? "gateway_error" });
      return;
    }
  } catch (err) {
    logger.error(
      { orderId: order.id, refundId, gatewayCalled, err },
      "refund_unexpected_error",
    );
    // Only release the lock if the failure happened BEFORE we contacted
    // the gateway. After gateway contact, the outcome is unknown and
    // releasing the lock could enable a double charge.
    if (!gatewayCalled) {
      releaseLock = true;
    } else {
      logger.warn(
        { orderId: order.id, refundId },
        "refund_lock_held_pending_reconciliation",
      );
    }
    if (!res.headersSent) {
      res.status(500).json({ error: "refund_internal_error" });
    }
    return;
  } finally {
    if (releaseLock) {
      try {
        await db
          .update(schema.ordersTable)
          .set({ refundStartedAt: null })
          .where(eq(schema.ordersTable.id, order.id));
      } catch (releaseErr) {
        logger.error(
          { orderId: order.id, refundId, err: releaseErr },
          "refund_lock_release_failed",
        );
      }
    }
  }
});

/**
 * Hosted dev-mock checkout page (mounted via /api/__devpay/:reference).
 * Renders a simple "Pay" button that POSTs back to the webhook; this exercises
 * the entire HMAC + idempotency + finalize path even without real keys.
 */
router.get("/__devpay/:reference", async (req: Request, res: Response) => {
  const reference = String(req.params.reference);
  const charge = gateways.devMock.getCharge(reference);
  if (!charge) {
    res.status(404).send("Unknown reference");
    return;
  }
  const action = `/api/__devpay/${encodeURIComponent(reference)}/confirm`;
  const cancel = `/api/__devpay/${encodeURIComponent(reference)}/cancel`;
  const amount = (charge.req.amountMinor / 100).toFixed(2);
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Epplaa dev pay</title><style>
body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:#0F1525;color:#fff;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;box-sizing:border-box}
.card{background:#1A2238;border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:24px;max-width:360px;width:100%}
h1{margin:0 0 4px;font-size:18px}
p{margin:8px 0;color:rgba(255,255,255,0.65);font-size:13px}
.amount{font-size:32px;font-weight:900;margin:16px 0;color:#FF8855}
button,a.btn{display:block;width:100%;padding:14px;border-radius:12px;font-weight:800;font-size:14px;border:0;cursor:pointer;text-align:center;text-decoration:none;margin-top:8px;box-sizing:border-box}
.pay{background:linear-gradient(90deg,#FF8855,#FF6B35);color:#000}
.cancel{background:transparent;border:1px solid rgba(255,255,255,0.2);color:#fff}
.tag{display:inline-block;background:rgba(255,136,85,0.15);color:#FF8855;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:700;margin-bottom:8px}
</style></head><body><div class="card">
<span class="tag">DEV / TEST MODE</span>
<h1>Epplaa Pay</h1>
<p>Reference: <code>${escapeHtml(reference)}</code></p>
<div class="amount">${escapeHtml(charge.req.currencyCode)} ${escapeHtml(amount)}</div>
<p>Purpose: ${escapeHtml(charge.req.purpose)}</p>
<form method="post" action="${escapeHtml(action)}"><button class="pay" type="submit">Confirm payment</button></form>
<a class="btn cancel" href="${escapeHtml(cancel)}">Cancel</a>
<p style="font-size:11px;margin-top:16px">This is a sandbox checkout used while Paystack/Flutterwave keys are not configured. Add <code>PAYSTACK_SECRET_KEY</code> to take real payments.</p>
</div></body></html>`);
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
}

/**
 * POST /api/__devpay/:reference/confirm — fires the dev-mock webhook back at
 * /api/webhooks/devmock with the proper HMAC signature, then redirects the
 * user back to the gateway callback URL.
 */
router.post("/__devpay/:reference/confirm", async (req: Request, res: Response) => {
  const reference = String(req.params.reference);
  const charge = gateways.devMock.getCharge(reference);
  if (!charge) {
    res.status(404).send("Unknown reference");
    return;
  }
  gateways.devMock.markSuccess(reference);
  // Build webhook body and sign it the same way the dev-mock gateway expects.
  const bodyObj = {
    reference,
    status: "success",
    amountMinor: charge.req.amountMinor,
    currencyCode: charge.req.currencyCode,
    purpose: charge.req.purpose,
    intentId: charge.req.intentId,
  };
  const bodyStr = JSON.stringify(bodyObj);
  const signature = DevMockGateway.signBody(Buffer.from(bodyStr, "utf8"));
  // POST to our own webhook endpoint so the canonical processing flow runs.
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  try {
    await fetch(`${baseUrl}/api/webhooks/devmock`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-devmock-signature": signature },
      body: bodyStr,
    });
  } catch (err) {
    logger.error({ err: (err as Error).message, reference }, "devpay_webhook_post_failed");
  }
  res.redirect(charge.req.callbackUrl + (charge.req.callbackUrl.includes("?") ? "&" : "?") + `reference=${encodeURIComponent(reference)}&intentId=${encodeURIComponent(charge.req.intentId)}`);
});

router.post("/__devpay/:reference/cancel", async (req: Request, res: Response) => {
  const reference = String(req.params.reference);
  const charge = gateways.devMock.getCharge(reference);
  if (!charge) {
    res.status(404).send("Unknown reference");
    return;
  }
  // Mark the intent as failed so the user can retry without picking up a stale row.
  await db
    .update(schema.paymentIntentsTable)
    .set({ status: "failed" })
    .where(eq(schema.paymentIntentsTable.reference, reference));
  res.redirect(charge.req.callbackUrl + (charge.req.callbackUrl.includes("?") ? "&" : "?") + `reference=${encodeURIComponent(reference)}&cancelled=1`);
});

function serializeIntent(row: typeof schema.paymentIntentsTable.$inferSelect) {
  return {
    id: row.id,
    purpose: row.purpose,
    orderId: row.orderId,
    gateway: row.gateway,
    reference: row.reference,
    amountMinor: row.amountMinor,
    vatMinor: row.vatMinor,
    currencyCode: row.currencyCode,
    status: row.status,
    authorizationUrl: row.authorizationUrl,
    paidAtIso: row.paidAt?.toISOString() ?? null,
    createdAtIso: row.createdAt.toISOString(),
  };
}

export default router;
