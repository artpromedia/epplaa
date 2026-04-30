import { and, eq } from "drizzle-orm";
import { db, schema } from "./db";
import { logger } from "./logger";
import { recordAudit } from "./audit";
import { manufacturerSanctionsBlocked } from "./sanctions";

/**
 * Cross-border manufacturer payouts.
 *
 * Triggered when a wholesale_order transitions to `delivered` (i.e. the
 * bonded-warehouse stock has been fully released to the seller). The
 * platform pays the manufacturer in the manufacturer's *origin* currency
 * (USD/CNY/VND/JPY/TWD/EUR/GBP) via Flutterwave's international rail —
 * the same rail used for retail manufacturer-share payouts in
 * `lib/payments.ts`. Sanctions screening is consulted here so that
 * blocked manufacturers land in `blocked` state rather than being paid.
 *
 * The payout is keyed off `wholesale_orders.id` via the `reference` field
 * (`WO-{orderId}-...`) for idempotency — the daily-payouts cron filters
 * out duplicates by reference.
 *
 * Manufacturer share is the FOB total (origin currency) minus a
 * platform commission, configurable via `MANUFACTURER_PLATFORM_BP`
 * (defaults to 800bp = 8%). Freight, duty, VAT, clearance are NOT paid
 * to the manufacturer — those flow to forwarders / customs / the
 * platform respectively.
 */

const MANUFACTURER_PLATFORM_BP = Number(process.env.MANUFACTURER_PLATFORM_BP ?? 800);
const MANUFACTURER_HOLD_DAYS = 7;

export async function enqueueManufacturerPayoutForWholesaleOrder(orderId: string): Promise<boolean> {
  const [order] = await db
    .select()
    .from(schema.wholesaleOrdersTable)
    .where(eq(schema.wholesaleOrdersTable.id, orderId))
    .limit(1);
  if (!order) {
    logger.warn({ orderId }, "manufacturer_payout_skip_no_order");
    return false;
  }
  const [mfr] = await db
    .select()
    .from(schema.manufacturersTable)
    .where(eq(schema.manufacturersTable.id, order.manufacturerId))
    .limit(1);
  if (!mfr) {
    logger.warn({ orderId, manufacturerId: order.manufacturerId }, "manufacturer_payout_skip_no_manufacturer");
    return false;
  }
  const reference = `WO-${order.id}`;
  // Idempotency: skip if a payout with this reference already exists.
  const existing = await db
    .select({ id: schema.payoutsTable.id })
    .from(schema.payoutsTable)
    .where(and(eq(schema.payoutsTable.reference, reference), eq(schema.payoutsTable.kind, "manufacturer_share")))
    .limit(1);
  if (existing.length > 0) {
    logger.info({ orderId, payoutId: existing[0].id }, "manufacturer_payout_already_exists");
    return false;
  }
  const fobMinor = order.fobMinor;
  const platformMinor = Math.round(fobMinor * (MANUFACTURER_PLATFORM_BP / 10_000));
  const payoutMinor = Math.max(0, fobMinor - platformMinor);
  if (payoutMinor <= 0) return false;

  const blocked = await manufacturerSanctionsBlocked(mfr.userId);
  const holdUntil = new Date(Date.now() + MANUFACTURER_HOLD_DAYS * 24 * 3600 * 1000);
  // Deterministic, full-order-id-based payout id — guarantees no cross-order
  // collisions even if two orders share a 12-char suffix.
  const payoutId = `po_wo_${order.id}`;

  const inserted = await db
    .insert(schema.payoutsTable)
    .values({
      id: payoutId,
      userId: mfr.userId,
      sellerId: mfr.userId,
      // Persist the wholesale-order reference so payout rows are joinable
      // back to wholesale orders without parsing the `reference` string.
      orderId: order.id,
      intentId: null,
      amountMinor: payoutMinor,
      currencyCode: order.originCurrencyCode, // ← paid in manufacturer's origin currency
      status: blocked ? "blocked" : "pending",
      errorMessage: blocked ? "sanctions_review_required" : null,
      kind: "manufacturer_share",
      holdUntil,
      reference,
      gateway: "flutterwave",
    })
    .onConflictDoNothing()
    .returning({ id: schema.payoutsTable.id });

  if (inserted.length === 0) {
    // Lost the race with another concurrent enqueue — payout already exists.
    logger.info({ orderId, payoutId }, "manufacturer_payout_skipped_duplicate");
    return false;
  }

  await recordAudit({
    actorId: "system:manufacturer_payouts",
    action: "manufacturer_payout.enqueue.wholesale",
    entity: "payout",
    entityId: payoutId,
    payload: {
      wholesaleOrderId: order.id,
      manufacturerId: mfr.id,
      manufacturerUserId: mfr.userId,
      amountMinor: payoutMinor,
      currencyCode: order.originCurrencyCode,
      blocked,
    },
  });
  logger.info(
    { orderId, manufacturerId: mfr.id, payoutId, amountMinor: payoutMinor, currency: order.originCurrencyCode, blocked },
    "manufacturer_payout_enqueued_wholesale",
  );
  return true;
}
