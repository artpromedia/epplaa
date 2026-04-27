import { and, eq, gte, lte } from "drizzle-orm";
import type { GatewayName, PaymentGateway } from "@workspace/payments";
import { db, schema } from "./db";
import { logger } from "./logger";
import { newReconciliationId } from "./ids";
import { gateways } from "./payments";

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
