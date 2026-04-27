import { and, eq, gte, lte, isNotNull, sql } from "drizzle-orm";
import type { GatewayName, PaymentGateway } from "@workspace/payments";
import { db, schema } from "./db";
import { logger } from "./logger";
import { newReconciliationId } from "./ids";
import { gateways, clawbackPayoutsForRefund } from "./payments";

/**
 * Reconcile a single gateway's settlement file against the internal ledger
 * over the given window. Mismatches are written to the
 * `reconciliation_runs.mismatches` jsonb column for the finance review queue.
 */
export async function reconcileGateway(
  gatewayName: GatewayName,
  windowStart: Date,
  windowEnd: Date,
): Promise<typeof schema.reconciliationRunsTable.$inferSelect> {
  const gw: PaymentGateway = gateways[gatewayName === "paystack" ? "paystack" : gatewayName === "flutterwave" ? "flutterwave" : "devMock"];
  const id = newReconciliationId();
  let settlements: Awaited<ReturnType<PaymentGateway["listSettlements"]>> = [];
  let errorMessage: string | null = null;
  try {
    settlements = await gw.listSettlements(windowStart.toISOString(), windowEnd.toISOString());
  } catch (err) {
    errorMessage = (err as Error).message;
  }

  const ledger = await db
    .select()
    .from(schema.paymentIntentsTable)
    .where(
      and(
        eq(schema.paymentIntentsTable.gateway, gatewayName),
        eq(schema.paymentIntentsTable.status, "succeeded"),
        gte(schema.paymentIntentsTable.paidAt, windowStart),
        lte(schema.paymentIntentsTable.paidAt, windowEnd),
      ),
    );

  const ledgerByRef = new Map(ledger.map((l) => [l.reference, l]));
  const settlementByRef = new Map(settlements.map((s) => [s.reference, s]));

  const mismatches: Array<{ reference: string; reason: string; gatewayAmount?: number; ledgerAmount?: number }> = [];
  for (const intent of ledger) {
    const settlement = settlementByRef.get(intent.reference);
    if (!settlement) {
      mismatches.push({ reference: intent.reference, reason: "missing_in_settlement", ledgerAmount: intent.amountMinor });
    } else if (settlement.amountMinor !== intent.amountMinor) {
      mismatches.push({
        reference: intent.reference,
        reason: "amount_mismatch",
        gatewayAmount: settlement.amountMinor,
        ledgerAmount: intent.amountMinor,
      });
    }
  }
  for (const settlement of settlements) {
    if (!ledgerByRef.has(settlement.reference)) {
      mismatches.push({ reference: settlement.reference, reason: "missing_in_ledger", gatewayAmount: settlement.amountMinor });
    }
  }

  const matched = ledger.length - mismatches.filter((m) => m.reason !== "missing_in_ledger").length;
  const status = errorMessage ? "error" : mismatches.length === 0 ? "ok" : "discrepancies";

  const [row] = await db
    .insert(schema.reconciliationRunsTable)
    .values({
      id,
      gateway: gatewayName,
      windowStart,
      windowEnd,
      ledgerCount: ledger.length,
      settlementCount: settlements.length,
      matchedCount: matched,
      mismatches,
      status,
      errorMessage,
    })
    .returning();
  logger.info(
    { gateway: gatewayName, ledger: ledger.length, settlements: settlements.length, mismatches: mismatches.length, status },
    "reconciliation_complete",
  );
  return row;
}

/** Run reconciliation for all gateways for the past 24 hours. */
export async function runDailyReconciliation(): Promise<typeof schema.reconciliationRunsTable.$inferSelect[]> {
  const end = new Date();
  const start = new Date(end.getTime() - 24 * 3600 * 1000);
  const out: typeof schema.reconciliationRunsTable.$inferSelect[] = [];
  for (const name of ["paystack", "flutterwave", "devmock"] as GatewayName[]) {
    out.push(await reconcileGateway(name, start, end));
  }
  return out;
}

/**
 * Refund-lock recovery sweep — uses the local audit row as the source
 * of truth (the gateway charge-verify endpoint reports the original
 * charge status, NOT the refund status, and is therefore not a safe
 * signal for finalizing a refund).
 *
 * For every order with `refund_started_at` older than `staleAfterMs`
 * AND status != 'refunded', look up the most recent `refund_attempts`
 * row for the order:
 *
 *   - status='processed' → the prior request received a clean
 *     "ok && processed" response from the gateway before crashing.
 *     Finalize: order.status='refunded', intent.status='refunded'.
 *
 *   - status='pending' with a non-null gateway_reference → the gateway
 *     accepted the refund (returned a refundReference) but the
 *     completion is asynchronous. Leave the lock held so the gateway's
 *     refund webhook can finalize via the normal path.
 *
 *   - status='failed' → the gateway acknowledged failure. Safe to
 *     clear the lock so the buyer can retry.
 *
 *   - anything else (no audit row, status='pending' with no gateway
 *     reference, etc.) → ambiguous: keep the lock held and emit an
 *     escalation log entry for finance review.
 *
 * This is intentionally conservative: we never clear the lock unless
 * there is explicit evidence the gateway side has no money in flight.
 * Default stale window: 30 minutes (well past any normal round-trip).
 */
export async function recoverStuckRefundLocks(
  staleAfterMs: number = 30 * 60 * 1000,
): Promise<{ resolved: number; cleared: number; ambiguous: number }> {
  const cutoff = new Date(Date.now() - staleAfterMs);
  const stuck = await db
    .select()
    .from(schema.ordersTable)
    .where(
      and(
        isNotNull(schema.ordersTable.refundStartedAt),
        lte(schema.ordersTable.refundStartedAt, cutoff),
        sql`${schema.ordersTable.status} <> 'refunded'`,
      ),
    );

  let resolved = 0;
  let cleared = 0;
  let ambiguous = 0;

  for (const order of stuck) {
    try {
      const [latestAttempt] = await db
        .select()
        .from(schema.refundAttemptsTable)
        .where(eq(schema.refundAttemptsTable.orderId, order.id))
        .orderBy(sql`${schema.refundAttemptsTable.createdAt} desc nulls last`)
        .limit(1);

      if (!latestAttempt) {
        ambiguous += 1;
        logger.warn(
          { orderId: order.id },
          "refund_lock_recovery_no_audit_row",
        );
        continue;
      }

      if (latestAttempt.status === "processed") {
        /*
         * Sweep order: clawback runs every time (idempotent via
         * deterministic audit-id + onConflictDoNothing) so a prior
         * partial finalize where order.status was set but clawback
         * was missed is healed here. Order/intent updates are no-ops
         * if already 'refunded'.
         */
        const clawback = await clawbackPayoutsForRefund(
          order.id,
          latestAttempt.reason ?? "recovery_sweep_refund",
        );
        await db
          .update(schema.ordersTable)
          .set({ status: "refunded" })
          .where(eq(schema.ordersTable.id, order.id));
        if (order.paymentIntentId) {
          await db
            .update(schema.paymentIntentsTable)
            .set({ status: "refunded" })
            .where(eq(schema.paymentIntentsTable.id, order.paymentIntentId));
        }
        logger.info(
          { orderId: order.id, refundId: latestAttempt.id, ...clawback },
          "refund_lock_recovery_finalized",
        );
        resolved += 1;
      } else if (latestAttempt.status === "failed") {
        await db
          .update(schema.ordersTable)
          .set({ refundStartedAt: null })
          .where(eq(schema.ordersTable.id, order.id));
        cleared += 1;
        logger.info(
          { orderId: order.id, refundId: latestAttempt.id },
          "refund_lock_recovery_cleared",
        );
      } else {
        // pending (with or without gatewayReference) or unknown:
        // refund may still be in flight on the gateway side. Hold
        // the lock and surface for finance review.
        ambiguous += 1;
        logger.warn(
          {
            orderId: order.id,
            refundId: latestAttempt.id,
            attemptStatus: latestAttempt.status,
            gatewayReference: latestAttempt.gatewayReference,
          },
          "refund_lock_recovery_ambiguous",
        );
      }
    } catch (err) {
      ambiguous += 1;
      logger.error(
        { orderId: order.id, err },
        "refund_lock_recovery_lookup_failed",
      );
    }
  }

  return { resolved, cleared, ambiguous };
}
