import { eq, sql, and, inArray, ne } from "drizzle-orm";
import {
  DevMockGateway,
  FlutterwaveGateway,
  GatewayRouter,
  PaystackGateway,
  type GatewayHealthSnapshot,
  type GatewayName,
  type HealthStore,
  type PaymentGateway,
} from "@workspace/payments";
import { db, schema } from "./db";
import { logger } from "./logger";
import { newPaymentAttemptId, newPaymentIntentId, newPaymentReference } from "./ids";

/**
 * 5-minute rolling window for the gateway health counters. The router opens
 * the circuit breaker when the failure rate exceeds 40% with at least 5
 * samples in the window.
 */
const HEALTH_WINDOW_MS = 5 * 60 * 1000;

class DbHealthStore implements HealthStore {
  async read(gateway: GatewayName): Promise<GatewayHealthSnapshot> {
    const [row] = await db
      .select()
      .from(schema.gatewayHealthTable)
      .where(eq(schema.gatewayHealthTable.gateway, gateway))
      .limit(1);
    if (!row) {
      return { gateway, successCount: 0, failureCount: 0, successRate: 1, circuitOpenUntil: null };
    }
    // Reset rolling window if it's older than HEALTH_WINDOW_MS.
    if (Date.now() - row.windowStartedAt.getTime() > HEALTH_WINDOW_MS) {
      await db
        .update(schema.gatewayHealthTable)
        .set({ successCount: 0, failureCount: 0, windowStartedAt: new Date() })
        .where(eq(schema.gatewayHealthTable.gateway, gateway));
      return { gateway, successCount: 0, failureCount: 0, successRate: 1, circuitOpenUntil: row.circuitOpenUntil };
    }
    const total = row.successCount + row.failureCount;
    return {
      gateway,
      successCount: row.successCount,
      failureCount: row.failureCount,
      successRate: total === 0 ? 1 : row.successCount / total,
      circuitOpenUntil: row.circuitOpenUntil,
    };
  }

  async record(gateway: GatewayName, ok: boolean): Promise<void> {
    await db
      .insert(schema.gatewayHealthTable)
      .values({
        gateway,
        successCount: ok ? 1 : 0,
        failureCount: ok ? 0 : 1,
        lastEventAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.gatewayHealthTable.gateway,
        set: {
          successCount: ok
            ? sql`${schema.gatewayHealthTable.successCount} + 1`
            : schema.gatewayHealthTable.successCount,
          failureCount: ok
            ? schema.gatewayHealthTable.failureCount
            : sql`${schema.gatewayHealthTable.failureCount} + 1`,
          lastEventAt: new Date(),
        },
      });
  }

  async openCircuit(gateway: GatewayName, until: Date): Promise<void> {
    await db
      .update(schema.gatewayHealthTable)
      .set({ circuitOpenUntil: until })
      .where(eq(schema.gatewayHealthTable.gateway, gateway));
    logger.warn({ gateway, until: until.toISOString() }, "circuit_opened");
  }
}

const healthStore = new DbHealthStore();

const paystack = new PaystackGateway(process.env.PAYSTACK_SECRET_KEY);
const flutterwave = new FlutterwaveGateway(
  process.env.FLUTTERWAVE_SECRET_KEY,
  process.env.FLUTTERWAVE_WEBHOOK_HASH,
);
const devMock = new DevMockGateway();

/**
 * The "primary" gateway is whichever one is configured. If both are configured,
 * Paystack is primary and Flutterwave is the failover (per spec). If only one
 * is configured, that gateway serves both primary and secondary slots — the
 * router will simply not failover. The DevMockGateway is ONLY used when no
 * real gateway keys are configured at all; under no circumstance can a live
 * gateway charge fall over to dev-mock (which would silently fake success).
 */
function selectPrimaryAndSecondary(): {
  primary: PaymentGateway;
  secondary: PaymentGateway;
  effectiveMode: "live" | "live-only-paystack" | "live-only-flutterwave" | "dev-mock";
} {
  if (paystack.isConfigured() && flutterwave.isConfigured()) {
    return { primary: paystack, secondary: flutterwave, effectiveMode: "live" };
  }
  if (paystack.isConfigured()) {
    // No failover available — secondary === primary so a primary failure
    // surfaces as a real error instead of silently routing to dev-mock.
    return { primary: paystack, secondary: paystack, effectiveMode: "live-only-paystack" };
  }
  if (flutterwave.isConfigured()) {
    return { primary: flutterwave, secondary: flutterwave, effectiveMode: "live-only-flutterwave" };
  }
  return { primary: devMock, secondary: devMock, effectiveMode: "dev-mock" };
}

const selection = selectPrimaryAndSecondary();
export const gatewayRouter = new GatewayRouter(selection.primary, selection.secondary, healthStore);
export const gateways = { paystack, flutterwave, devMock };
export const PAYMENTS_MODE = selection.effectiveMode;

logger.info(
  { mode: PAYMENTS_MODE, primary: selection.primary.name, secondary: selection.secondary.name },
  "payments_initialized",
);

export interface SanitizedAttempt {
  intentId: string;
  gateway: GatewayName;
  kind: "charge" | "verify" | "refund" | "payout";
  status: "ok" | "error";
  errorCode?: string;
  errorMessage?: string;
  gatewayReference?: string;
  responseSummary?: unknown;
}

export async function logAttempt(a: SanitizedAttempt): Promise<void> {
  await db.insert(schema.paymentAttemptsTable).values({
    id: newPaymentAttemptId(),
    intentId: a.intentId,
    gateway: a.gateway,
    kind: a.kind,
    status: a.status,
    errorCode: a.errorCode ?? null,
    errorMessage: a.errorMessage ?? null,
    gatewayReference: a.gatewayReference ?? null,
    responseSummary: (a.responseSummary as Record<string, unknown> | undefined) ?? null,
  });
}

export interface CreateIntentInput {
  userId: string;
  email: string;
  purpose: "order" | "wallet_topup";
  orderId?: string;
  amountMinor: number;
  vatMinor?: number;
  currencyCode: string;
  metadata?: Record<string, unknown>;
  /**
   * Callback URL builder — receives the pre-generated intent id so the URL
   * can include both `orderId` and `intentId` for the frontend processing
   * page. (The intent id has to exist before we call the gateway because the
   * URL is sent in the same charge request.)
   */
  buildCallbackUrl: (intentId: string) => string;
  /** When true, skip gateway and immediately mark intent as succeeded (cash on delivery). */
  manualConfirm?: boolean;
}

export interface CreateIntentResult {
  intent: typeof schema.paymentIntentsTable.$inferSelect;
  authorizationUrl?: string;
  gateway: GatewayName;
}

/** Strip secrets from a gateway response before storing it in the audit log. */
function sanitizeResponse(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const json = JSON.stringify(value, (_k, v) => {
    if (typeof v === "string" && /sk_(?:live|test)_/.test(v)) return "[REDACTED]";
    return v;
  });
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export async function createPaymentIntent(input: CreateIntentInput): Promise<CreateIntentResult> {
  const reference = newPaymentReference();
  const intentId = newPaymentIntentId();
  const callbackUrl = input.buildCallbackUrl(intentId);

  if (input.manualConfirm) {
    const [intent] = await db
      .insert(schema.paymentIntentsTable)
      .values({
        id: intentId,
        userId: input.userId,
        purpose: input.purpose,
        orderId: input.orderId ?? null,
        gateway: "cod",
        reference,
        amountMinor: input.amountMinor,
        vatMinor: input.vatMinor ?? 0,
        currencyCode: input.currencyCode,
        status: "succeeded",
        metadata: input.metadata ?? {},
        paidAt: new Date(),
      })
      .returning();
    return { intent, gateway: "devmock" };
  }

  const primaryName = await gatewayRouter.pickPrimaryName();
  const [intent] = await db
    .insert(schema.paymentIntentsTable)
    .values({
      id: intentId,
      userId: input.userId,
      purpose: input.purpose,
      orderId: input.orderId ?? null,
      gateway: primaryName,
      reference,
      amountMinor: input.amountMinor,
      vatMinor: input.vatMinor ?? 0,
      currencyCode: input.currencyCode,
      status: "pending",
      metadata: input.metadata ?? {},
    })
    .returning();

  const { result, gateway } = await gatewayRouter.withFailover(primaryName, (gw) =>
    gw.charge({
      intentId: intent.id,
      amountMinor: input.amountMinor,
      currencyCode: input.currencyCode,
      email: input.email,
      reference,
      callbackUrl,
      purpose: input.purpose,
      metadata: input.metadata,
    }),
  );

  await logAttempt({
    intentId: intent.id,
    gateway,
    kind: "charge",
    status: result.ok ? "ok" : "error",
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
    gatewayReference: result.reference,
    responseSummary: sanitizeResponse(result.rawResponse),
  });

  if (!result.ok) {
    await db
      .update(schema.paymentIntentsTable)
      .set({ status: "failed" })
      .where(eq(schema.paymentIntentsTable.id, intent.id));
    throw new Error(`gateway_charge_failed:${result.errorMessage ?? "unknown"}`);
  }

  // Store actual gateway used (may differ from primary if failover triggered).
  const [updated] = await db
    .update(schema.paymentIntentsTable)
    .set({ gateway, authorizationUrl: result.authorizationUrl ?? null, status: "processing" })
    .where(eq(schema.paymentIntentsTable.id, intent.id))
    .returning();

  return { intent: updated, authorizationUrl: result.authorizationUrl, gateway };
}

/** Verify (re-check) an intent's status with its gateway and update DB rows. */
export async function reverifyIntent(intentId: string): Promise<typeof schema.paymentIntentsTable.$inferSelect> {
  const [intent] = await db
    .select()
    .from(schema.paymentIntentsTable)
    .where(eq(schema.paymentIntentsTable.id, intentId))
    .limit(1);
  if (!intent) throw new Error("intent_not_found");
  if (intent.status === "succeeded" || intent.status === "refunded") return intent;
  const gw = gatewayRouter.byName(intent.gateway as GatewayName);
  const result = await gw.verify(intent.reference);
  await logAttempt({
    intentId: intent.id,
    gateway: intent.gateway as GatewayName,
    kind: "verify",
    status: result.ok ? "ok" : "error",
    errorMessage: result.errorMessage,
    gatewayReference: intent.reference,
  });
  if (result.ok) {
    return await markIntentSucceeded(intent.id, result.paidAt ?? new Date());
  }
  if (result.status === "failed" || result.status === "abandoned") {
    const [row] = await db
      .update(schema.paymentIntentsTable)
      .set({ status: "failed" })
      .where(eq(schema.paymentIntentsTable.id, intent.id))
      .returning();
    return row;
  }
  return intent;
}

/**
 * Move an intent to `succeeded`. If linked to an order, also flip the order
 * to placed/ready/out_for_delivery and schedule the seller payout based on
 * tier (T+1 trusted, T+7 starter).
 *
 * Concurrency: this is the convergence point for two callers that can fire
 * simultaneously — the inbound webhook AND a frontend `verify` poll. We use
 * a conditional UPDATE with `WHERE status != 'succeeded'` so exactly one
 * caller is allowed to do the side-effects (wallet credit, order finalize,
 * payout scheduling). The losing caller observes `updated` is empty and
 * skips side-effects; idempotency for any side-effects we already commit is
 * additionally guarded by unique indexes on `wallet_txns(intent_id)` and
 * `payouts(order_id, seller_id)` for `seller_share` rows.
 */
export async function markIntentSucceeded(
  intentId: string,
  paidAt: Date,
): Promise<typeof schema.paymentIntentsTable.$inferSelect> {
  const winners = await db
    .update(schema.paymentIntentsTable)
    .set({ status: "succeeded", paidAt })
    .where(
      and(
        eq(schema.paymentIntentsTable.id, intentId),
        ne(schema.paymentIntentsTable.status, "succeeded"),
      ),
    )
    .returning();
  if (winners.length === 0) {
    // Either the intent doesn't exist OR another caller already finalized.
    const [existing] = await db
      .select()
      .from(schema.paymentIntentsTable)
      .where(eq(schema.paymentIntentsTable.id, intentId))
      .limit(1);
    if (!existing) throw new Error("intent_not_found");
    return existing;
  }
  const intent = winners[0];

  if (intent.purpose === "wallet_topup") {
    // Hard idempotency via the partial unique index on wallet_txns.intent_id.
    await db
      .insert(schema.walletTxnsTable)
      .values({
        id: `wt_${Date.now().toString(36)}_${intent.id.slice(-4)}`,
        userId: intent.userId,
        kind: "topup",
        amountMinor: intent.amountMinor,
        label: "Wallet top-up",
        status: "succeeded",
        intentId: intent.id,
      })
      .onConflictDoNothing();
  } else if (intent.purpose === "order" && intent.orderId) {
    await finalizeOrderAfterPayment(intent.orderId, intent.id, intent.gateway, intent.reference, paidAt);
  }

  return intent;
}

/**
 * Mark an order as paid and schedule the seller payout(s). One payout row is
 * inserted per distinct seller in the order. The unique partial index on
 * `payouts(order_id, seller_id) WHERE kind='seller_share'` guarantees we
 * cannot double-pay even if this function runs concurrently for the same
 * order.
 *
 * Buyer vs seller correctness: `order.userId` is the BUYER. Sellers are
 * derived from `products.seller_user_id` for each item in `order.items`. If a
 * product has no seller mapping (legacy/seed data), the platform absorbs the
 * share and we log a warning instead of paying it to the buyer.
 */
async function finalizeOrderAfterPayment(
  orderId: string,
  intentId: string,
  gateway: string,
  reference: string,
  paidAt: Date,
): Promise<void> {
  const [order] = await db
    .select()
    .from(schema.ordersTable)
    .where(eq(schema.ordersTable.id, orderId))
    .limit(1);
  if (!order) return;
  if (order.paidAt) return; // idempotent for the order columns

  const fulfillment = (order.fulfillment as { optionId?: string }) ?? {};
  const optionId = String(fulfillment.optionId ?? "");
  const isPickup = ["box", "pickup", "locker", "pudo", "paxi"].some((s) => optionId.includes(s));
  const newStatus = isPickup ? "ready_for_pickup" : "out_for_delivery";

  await db
    .update(schema.ordersTable)
    .set({
      status: newStatus,
      gateway,
      gatewayReference: reference,
      paymentIntentId: intentId,
      paidAt,
    })
    .where(and(eq(schema.ordersTable.id, orderId), sql`${schema.ordersTable.paidAt} IS NULL`));

  // ---- Compute split per seller ----
  const items = (order.items as Array<{ productId: string; qty: number; priceMinor: number }>) ?? [];
  if (items.length === 0) {
    logger.warn({ orderId }, "order_has_no_items_no_payout");
    return;
  }
  const productIds = Array.from(new Set(items.map((i) => i.productId).filter(Boolean)));
  const products = productIds.length > 0
    ? await db
        .select({
          id: schema.productsTable.id,
          sellerUserId: schema.productsTable.sellerUserId,
          manufacturerUserId: schema.productsTable.manufacturerUserId,
          manufacturerShareBp: schema.productsTable.manufacturerShareBp,
        })
        .from(schema.productsTable)
        .where(inArray(schema.productsTable.id, productIds))
    : [];
  const productMeta = new Map<string, { sellerUserId: string | null; manufacturerUserId: string | null; manufacturerShareBp: number }>();
  for (const p of products) {
    productMeta.set(p.id, {
      sellerUserId: p.sellerUserId,
      manufacturerUserId: p.manufacturerUserId,
      manufacturerShareBp: p.manufacturerShareBp ?? 0,
    });
  }

  // Per-line split: platform 10%, manufacturer (if attributed) X bp, seller remainder.
  // Then aggregate by recipient so each (order, recipient) is one payout row.
  const PLATFORM_BP = 1000; // 10%
  const grossPerSeller = new Map<string, number>();
  const grossPerManufacturer = new Map<string, number>();
  let unattributedMinor = 0;
  for (const it of items) {
    const lineGross = Number(it.priceMinor ?? 0) * Number(it.qty ?? 0);
    if (lineGross <= 0) continue;
    const meta = productMeta.get(it.productId);
    const sellerUserId = meta?.sellerUserId ?? null;
    if (!sellerUserId) {
      unattributedMinor += lineGross;
      continue;
    }
    const mfgBp = Math.max(0, Math.min(meta?.manufacturerShareBp ?? 0, 10000 - PLATFORM_BP));
    const mfgId = meta?.manufacturerUserId ?? null;
    const platformShare = Math.round((lineGross * PLATFORM_BP) / 10000);
    const manufacturerShare = mfgId ? Math.round((lineGross * mfgBp) / 10000) : 0;
    const sellerShare = lineGross - platformShare - manufacturerShare;
    if (sellerShare > 0) {
      grossPerSeller.set(sellerUserId, (grossPerSeller.get(sellerUserId) ?? 0) + sellerShare);
    }
    if (mfgId && manufacturerShare > 0) {
      grossPerManufacturer.set(mfgId, (grossPerManufacturer.get(mfgId) ?? 0) + manufacturerShare);
    }
  }
  if (unattributedMinor > 0) {
    logger.warn({ orderId, unattributedMinor }, "order_has_unattributed_lines_platform_absorbed");
  }

  // Seller payouts — tier-based hold (1d trusted / 7d starter).
  const holdMillis: number[] = [];
  for (const [sellerId, sellerNet] of grossPerSeller.entries()) {
    const seller = await loadSellerForUser(sellerId);
    const tier = seller?.tier ?? "starter";
    const holdDays = tier === "trusted" ? 1 : 7;
    const sellerHoldUntil = new Date(paidAt.getTime() + holdDays * 24 * 3600 * 1000);
    holdMillis.push(sellerHoldUntil.getTime());
    if (sellerNet <= 0) continue;
    await db
      .insert(schema.payoutsTable)
      .values({
        id: `po_${Date.now().toString(36)}_${orderId.slice(-4).toLowerCase()}_${sellerId.slice(-4)}`,
        userId: sellerId,
        sellerId,
        orderId,
        intentId,
        amountMinor: sellerNet,
        currencyCode: order.currencyCode,
        status: "pending",
        kind: "seller_share",
        holdUntil: sellerHoldUntil,
        reference: `PO-${orderId}-${sellerId.slice(-6)}`,
        gateway,
      })
      .onConflictDoNothing(); // unique (order_id, seller_id) for seller_share

    logger.info(
      { orderId, intentId, sellerId, sellerNet, holdUntil: sellerHoldUntil.toISOString() },
      "seller_payout_scheduled",
    );
  }

  // Manufacturer payouts — weekly batch via Flutterwave international rail.
  // We use a 7-day hold so the daily payouts cron picks them up only on the
  // weekly settlement boundary. Manufacturer onboarding/KYC and bank details
  // are owned by the cross-border task; until then payouts wait in 'scheduled'
  // state for finance.
  const MANUFACTURER_HOLD_DAYS = 7;
  for (const [manufacturerId, mfgNet] of grossPerManufacturer.entries()) {
    if (mfgNet <= 0) continue;
    const mfgHoldUntil = new Date(paidAt.getTime() + MANUFACTURER_HOLD_DAYS * 24 * 3600 * 1000);
    holdMillis.push(mfgHoldUntil.getTime());
    await db
      .insert(schema.payoutsTable)
      .values({
        id: `po_${Date.now().toString(36)}_${orderId.slice(-4).toLowerCase()}_m${manufacturerId.slice(-4)}`,
        userId: manufacturerId,
        sellerId: manufacturerId, // recipient
        orderId,
        intentId,
        amountMinor: mfgNet,
        currencyCode: order.currencyCode,
        status: "pending",
        kind: "manufacturer_share",
        holdUntil: mfgHoldUntil,
        reference: `MO-${orderId}-${manufacturerId.slice(-6)}`,
        // Manufacturer payouts ALWAYS use Flutterwave for international rail,
        // regardless of which gateway charged the buyer.
        gateway: "flutterwave",
      })
      .onConflictDoNothing();

    logger.info(
      { orderId, intentId, manufacturerId, mfgNet, holdUntil: mfgHoldUntil.toISOString() },
      "manufacturer_payout_scheduled",
    );
  }

  // Stamp the order's hold_until to the LATEST recipient hold so buyer
  // surfaces show when the order is fully settled.
  if (holdMillis.length > 0) {
    await db
      .update(schema.ordersTable)
      .set({ holdUntil: new Date(Math.max(...holdMillis)) })
      .where(eq(schema.ordersTable.id, orderId));
  }
}

/**
 * Refund clawback: when a paid order is refunded, cancel any pending payouts
 * that haven't been released yet. Settled (paid) payouts cannot be reversed
 * automatically — those are recorded as `refund_attempts` rows with a
 * `clawback_required` reason for finance to handle off-platform.
 */
export async function clawbackPayoutsForRefund(orderId: string, refundReason: string): Promise<{ cancelled: number; clawbackRequired: number }> {
  const all = await db
    .select()
    .from(schema.payoutsTable)
    .where(and(eq(schema.payoutsTable.orderId, orderId), eq(schema.payoutsTable.kind, "seller_share")));
  let cancelled = 0;
  let clawbackRequired = 0;
  for (const p of all) {
    if (p.status === "pending" || p.status === "scheduled") {
      const result = await db
        .update(schema.payoutsTable)
        .set({ status: "cancelled", errorMessage: `clawback: ${refundReason}` })
        .where(and(eq(schema.payoutsTable.id, p.id), inArray(schema.payoutsTable.status, ["pending", "scheduled"])))
        .returning();
      if (result.length > 0) cancelled++;
    } else if (p.status === "processing" || p.status === "paid") {
      // Funds already in flight or sent — finance must claw back.
      await db.insert(schema.refundAttemptsTable).values({
        id: `rfa_${Date.now().toString(36)}_${p.id.slice(-4)}`,
        intentId: p.intentId ?? "",
        orderId,
        amountMinor: p.amountMinor,
        reason: `clawback_required: ${refundReason}`,
        status: "pending",
        gateway: p.gateway ?? "manual",
      });
      clawbackRequired++;
      logger.warn({ orderId, payoutId: p.id, status: p.status }, "refund_clawback_required");
    }
  }
  return { cancelled, clawbackRequired };
}

async function loadSellerForUser(userId: string) {
  const [row] = await db
    .select()
    .from(schema.sellersTable)
    .where(eq(schema.sellersTable.userId, userId))
    .limit(1);
  return row ?? null;
}

/**
 * Run all due payouts whose hold has expired. Called by the payouts cron.
 * Returns the count of payouts processed.
 */
export async function processDuePayouts(): Promise<{ processed: number; failed: number }> {
  const due = await db
    .select()
    .from(schema.payoutsTable)
    .where(
      and(
        eq(schema.payoutsTable.status, "pending"),
        sql`${schema.payoutsTable.holdUntil} <= now()`,
      ),
    );
  let processed = 0;
  let failed = 0;
  for (const payout of due) {
    const seller = await loadSellerForUser(payout.userId);
    const application = (seller?.application as { bankCode?: string; bankAccount?: string; bankName?: string } | null) ?? null;
    const bankCode = application?.bankCode ?? payout.bankCode ?? "";
    const accountNumber = application?.bankAccount ?? "";
    const accountName = application?.bankName ?? "Epplaa Seller";
    if (!bankCode || !accountNumber) {
      // Mark as scheduled — finance can complete manually.
      await db
        .update(schema.payoutsTable)
        .set({ status: "scheduled", errorMessage: "missing_bank_details" })
        .where(eq(schema.payoutsTable.id, payout.id));
      continue;
    }
    const gw = gatewayRouter.byName((payout.gateway as GatewayName | null) ?? "devmock");
    const result = await gw.payout({
      reference: payout.reference,
      amountMinor: payout.amountMinor,
      currencyCode: payout.currencyCode,
      bankCode,
      accountNumber,
      accountName,
      reason: `Payout for order ${payout.orderId ?? ""}`.trim(),
    });
    await logAttempt({
      intentId: payout.intentId ?? "",
      gateway: gw.name,
      kind: "payout",
      status: result.ok ? "ok" : "error",
      gatewayReference: result.transferReference,
      errorMessage: result.errorMessage,
    });
    if (result.ok) {
      processed++;
      const finalStatus = result.status === "processed" ? "paid" : "processing";
      await db
        .update(schema.payoutsTable)
        .set({
          status: finalStatus,
          gateway: gw.name,
          gatewayReference: result.transferReference,
          paidAt: result.status === "processed" ? new Date() : null,
        })
        .where(eq(schema.payoutsTable.id, payout.id));
      if (payout.orderId) {
        await db
          .update(schema.ordersTable)
          .set({ settledAt: new Date() })
          .where(eq(schema.ordersTable.id, payout.orderId));
      }
      // Wallet withdrawals are user-initiated, so the matching wallet_txn
      // (kind='withdrawal', payout_id=this) must move out of 'pending' once
      // the gateway confirms the transfer. Without this the user's history
      // shows a permanently-pending row even though funds are gone.
      if (payout.kind === "wallet_withdrawal" && finalStatus === "paid") {
        await db
          .update(schema.walletTxnsTable)
          .set({ status: "succeeded" })
          .where(
            and(
              eq(schema.walletTxnsTable.payoutId, payout.id),
              eq(schema.walletTxnsTable.kind, "withdrawal"),
            ),
          );
      }
    } else {
      failed++;
      await db
        .update(schema.payoutsTable)
        .set({ status: "failed", errorMessage: result.errorMessage ?? "payout_failed" })
        .where(eq(schema.payoutsTable.id, payout.id));
      // Compensating credit so user funds are not stranded after a failed
      // withdrawal. Mark the original debit row as failed and write a
      // counterbalancing positive 'refund' row referencing the same payout.
      if (payout.kind === "wallet_withdrawal") {
        await reverseFailedWithdrawal(payout.id, payout.userId, payout.amountMinor, result.errorMessage ?? "payout_failed");
      }
    }
  }
  if (processed + failed > 0) {
    logger.info({ processed, failed }, "payouts_processed");
  }
  return { processed, failed };
}

/**
 * On a failed withdrawal payout, mark the original debit wallet_txn as
 * 'failed' and insert a compensating credit so the user's balance is made
 * whole. The compensating credit is keyed off the payout id via the
 * `wallet_txns_withdrawal_payout_uniq` index — but that index is scoped to
 * `kind='withdrawal'`, so a 'refund' row for the same payout id is allowed.
 * To keep this idempotent across cron retries we additionally check for an
 * existing reversal row before inserting.
 */
async function reverseFailedWithdrawal(payoutId: string, userId: string, amountMinor: number, reason: string): Promise<void> {
  await db
    .update(schema.walletTxnsTable)
    .set({ status: "failed" })
    .where(
      and(
        eq(schema.walletTxnsTable.payoutId, payoutId),
        eq(schema.walletTxnsTable.kind, "withdrawal"),
      ),
    );
  const existing = await db
    .select({ id: schema.walletTxnsTable.id })
    .from(schema.walletTxnsTable)
    .where(
      and(
        eq(schema.walletTxnsTable.payoutId, payoutId),
        eq(schema.walletTxnsTable.kind, "refund"),
      ),
    )
    .limit(1);
  if (existing.length > 0) return;
  await db.insert(schema.walletTxnsTable).values({
    id: `wt_rv_${Date.now().toString(36)}_${payoutId.slice(-6)}`,
    userId,
    kind: "refund",
    amountMinor: Math.abs(amountMinor),
    label: `Withdrawal failed — refunded`,
    refId: payoutId,
    payoutId,
    status: "succeeded",
  });
  logger.info({ payoutId, userId, amountMinor, reason }, "wallet_withdrawal_reversed");
}
