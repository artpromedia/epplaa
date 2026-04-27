import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import type { GatewayName, PaymentGateway } from "@workspace/payments";
import { db, schema } from "../lib/db";
import { logger } from "../lib/logger";
import { newWebhookId } from "../lib/ids";
import { gateways, markIntentSucceeded } from "../lib/payments";

/**
 * IMPORTANT: this router MUST be mounted with `express.raw()` BEFORE
 * `express.json()` so the raw body is available for HMAC verification.
 * See app.ts for the mounting order.
 */
const router: IRouter = Router();

router.post("/paystack", (req, res) => handleWebhook("paystack", gateways.paystack, req, res));
router.post("/flutterwave", (req, res) => handleWebhook("flutterwave", gateways.flutterwave, req, res));
router.post("/devmock", (req, res) => handleWebhook("devmock", gateways.devMock, req, res));

async function handleWebhook(
  name: GatewayName,
  gw: PaymentGateway,
  req: Request,
  res: Response,
): Promise<void> {
  const rawBody: Buffer = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}), "utf8");

  // Normalize headers to a string-keyed dict (express lowercases incoming header names).
  const headerDict: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headerDict[k] = v;
    else if (Array.isArray(v)) headerDict[k] = v[0];
  }

  const verified = gw.verifyWebhook(rawBody, headerDict);
  if (!verified.ok) {
    // Persist invalid attempts for security investigation but don't process them.
    await db
      .insert(schema.paymentWebhooksTable)
      .values({
        id: newWebhookId(),
        gateway: name,
        gatewayEventId: `invalid_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        eventType: "invalid_signature",
        reference: null,
        signatureValid: false,
        payload: safeJson(rawBody),
        processedAt: new Date(),
        processError: "invalid_signature",
      })
      .onConflictDoNothing();
    logger.warn({ gateway: name, headers: Object.keys(headerDict) }, "webhook_invalid_signature");
    // Always return 200 to avoid the gateway disabling our endpoint, but log the issue.
    res.status(200).json({ ok: false, reason: "invalid_signature" });
    return;
  }

  // Idempotency check: insert with onConflictDoNothing keyed on (gateway, gatewayEventId).
  const inserted = await db
    .insert(schema.paymentWebhooksTable)
    .values({
      id: newWebhookId(),
      gateway: name,
      gatewayEventId: verified.eventId,
      eventType: verified.eventType,
      reference: verified.reference,
      signatureValid: true,
      payload: (verified.raw as Record<string, unknown>) ?? {},
    })
    .onConflictDoNothing()
    .returning();

  if (inserted.length === 0) {
    // Already processed this event — return success without re-processing.
    logger.info({ gateway: name, eventId: verified.eventId }, "webhook_replay_ignored");
    res.status(200).json({ ok: true, replay: true });
    return;
  }
  const webhookId = inserted[0].id;

  try {
    if (verified.status === "success" && verified.reference) {
      // Find the corresponding intent and finalize it.
      const [intent] = await db
        .select()
        .from(schema.paymentIntentsTable)
        .where(eq(schema.paymentIntentsTable.reference, verified.reference))
        .limit(1);
      if (intent) {
        // Amount sanity-check — if the gateway reports an amount that doesn't
        // match our intent, refuse to mark succeeded.
        if (verified.amountMinor && verified.amountMinor !== intent.amountMinor) {
          throw new Error(
            `amount_mismatch: gateway=${verified.amountMinor} intent=${intent.amountMinor}`,
          );
        }
        await markIntentSucceeded(intent.id, new Date());
      }
    } else if (verified.status === "failed" && verified.reference) {
      await db
        .update(schema.paymentIntentsTable)
        .set({ status: "failed" })
        .where(eq(schema.paymentIntentsTable.reference, verified.reference));
    }
    await db
      .update(schema.paymentWebhooksTable)
      .set({ processedAt: new Date() })
      .where(eq(schema.paymentWebhooksTable.id, webhookId));
    res.status(200).json({ ok: true });
  } catch (err) {
    const msg = (err as Error).message;
    await db
      .update(schema.paymentWebhooksTable)
      .set({ processedAt: new Date(), processError: msg })
      .where(eq(schema.paymentWebhooksTable.id, webhookId));
    logger.error({ gateway: name, err: msg, eventId: verified.eventId }, "webhook_process_error");
    res.status(500).json({ ok: false, error: msg });
  }
}

function safeJson(buf: Buffer): Record<string, unknown> {
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return { raw: buf.toString("utf8").slice(0, 2000) };
  }
}

export default router;
