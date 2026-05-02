import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import crypto from "node:crypto";

/**
 * Regression suite for `scheduleCodPayoutsOnDelivery` — the COD analogue
 * of `finalizeOrderAfterPayment`.
 *
 * COD orders skip the gateway-confirmation path that schedules seller
 * payouts at charge time, because the platform doesn't actually have the
 * money until the buyer pays cash on collection. The seller payout split
 * therefore has to fire when the order is marked delivered (Box unlock,
 * PUDO confirmation, or carrier "delivered" event). Without this,
 * COD-delivered orders silently strand seller funds in the platform's
 * float account with no row in the payouts table for finance to
 * reconcile or for the seller dashboard to surface.
 *
 * What this suite locks in:
 *   1. A COD order (`gateway = "cod"`) marked delivered produces seller
 *      payout rows mirroring the prepaid split (10% platform, seller
 *      remainder), with the same tier-based hold window.
 *   2. Replaying the call (e.g. duplicate carrier webhook racing the
 *      buyer's in-app collection confirmation) is a no-op — no second
 *      payout row, asserted against the partial unique index.
 *   3. A non-COD order is left untouched (the function is wired into
 *      the shared delivery handler and runs for every delivery, not
 *      just COD ones, so we lock in the "skip prepaid" branch).
 *
 * Skips itself if DATABASE_URL is not configured.
 */

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const TEST_PREFIX = "test-cod-payout-";

function rid(): string {
  return crypto.randomBytes(8).toString("hex");
}

d("payments — scheduleCodPayoutsOnDelivery", () => {
  type Db = typeof import("./db")["db"];
  type Schema = typeof import("./db")["schema"];
  type Sql = typeof import("drizzle-orm")["sql"];
  type Payments = typeof import("./payments");

  let db: Db;
  let schema: Schema;
  let sql: Sql;
  let payments: Payments;

  async function cleanup(): Promise<void> {
    await db.execute(
      sql`DELETE FROM payouts WHERE order_id LIKE ${TEST_PREFIX + "%"} OR seller_id LIKE ${TEST_PREFIX + "%"};`,
    );
    await db.execute(
      sql`DELETE FROM payment_intents WHERE id LIKE ${TEST_PREFIX + "%"};`,
    );
    await db.execute(
      sql`DELETE FROM orders WHERE id LIKE ${TEST_PREFIX + "%"} OR user_id LIKE ${TEST_PREFIX + "%"};`,
    );
    await db.execute(
      sql`DELETE FROM products WHERE id LIKE ${TEST_PREFIX + "%"};`,
    );
    await db.execute(
      sql`DELETE FROM sellers WHERE user_id LIKE ${TEST_PREFIX + "%"};`,
    );
    await db.execute(
      sql`DELETE FROM sanctions_screenings WHERE user_id LIKE ${TEST_PREFIX + "%"};`,
    );
    await db.execute(
      sql`DELETE FROM users WHERE clerk_id LIKE ${TEST_PREFIX + "%"};`,
    );
  }

  beforeAll(async () => {
    if (!process.env.SESSION_SECRET) {
      process.env.SESSION_SECRET = crypto.randomBytes(32).toString("hex");
    }
    ({ db, schema } = await import("./db"));
    ({ sql } = await import("drizzle-orm"));
    payments = await import("./payments");
    await cleanup();
  }, 30_000);

  afterEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
  });

  async function seedSellerWithClearScreening(sellerId: string): Promise<void> {
    await db.insert(schema.sellersTable).values({
      userId: sellerId,
      status: "active",
      tier: "trusted",
      mode: "seller",
      kycTier: 3,
    });
    await db.insert(schema.sanctionsScreeningsTable).values({
      id: `${TEST_PREFIX}sx-${rid()}`,
      userId: sellerId,
      subjectKind: "seller",
      provider: "stub",
      matchScore: 0,
      status: "clear",
    });
  }

  it("schedules seller payouts for a COD order on delivery, idempotent on retry", async () => {
    const buyerId = `${TEST_PREFIX}buyer-${rid()}`;
    const sellerId = `${TEST_PREFIX}seller-${rid()}`;
    const productId = `${TEST_PREFIX}prod-${rid()}`;
    const orderId = `${TEST_PREFIX}order-${rid()}`;
    const intentId = `${TEST_PREFIX}intent-${rid()}`;

    await seedSellerWithClearScreening(sellerId);
    await db.insert(schema.productsTable).values({
      id: productId,
      title: "COD seller product",
      priceMinor: 10_000_00,
      originCountry: "NG",
      originLabel: "Lagos",
      sellerName: "COD Co",
      sellerUserId: sellerId,
    });
    await db.insert(schema.usersTable).values({
      clerkId: buyerId,
      email: `${buyerId}@example.test`,
      displayName: "COD test buyer",
    });
    // COD intent: gateway pinned to "cod", status already succeeded
    // (createPaymentIntent does this when manualConfirm is true).
    await db.insert(schema.paymentIntentsTable).values({
      id: intentId,
      userId: buyerId,
      purpose: "order",
      orderId,
      gateway: "cod",
      reference: `${TEST_PREFIX}ref-${rid()}`,
      amountMinor: 10_000_00,
      currencyCode: "NGN",
      status: "succeeded",
    });
    // Seed the COD order in its already-paid-on-collection shape.
    const paidAt = new Date();
    await db.insert(schema.ordersTable).values({
      id: orderId,
      userId: buyerId,
      status: "ready_for_pickup",
      countryCode: "NG",
      currencyCode: "NGN",
      items: [{ productId, qty: 1, priceMinor: 10_000_00 }],
      fulfillment: { optionId: "epplaa-box", locationId: "loc-lagos-ikoyi" },
      payment: { methodId: "cod" },
      totalsMinor: { subtotal: 10_000_00, total: 10_000_00 },
      gateway: "cod",
      paymentIntentId: intentId,
      paidAt,
    });

    // First call: schedules payouts.
    await payments.scheduleCodPayoutsOnDelivery(orderId);
    const firstPass = await db
      .select()
      .from(schema.payoutsTable)
      .where(sql`${schema.payoutsTable.orderId} = ${orderId}`);
    expect(firstPass).toHaveLength(1);
    const payout = firstPass[0]!;
    // 10,000 NGN → 10% platform = 1,000 NGN → seller gets 9,000 NGN = 900_000 kobo.
    expect(payout.amountMinor).toBe(900_000);
    expect(payout.kind).toBe("seller_share");
    expect(payout.userId).toBe(sellerId);
    expect(payout.sellerId).toBe(sellerId);
    expect(payout.status).toBe("pending");
    // Disbursement gateway must be a real gateway, not the placeholder
    // "cod" we'd inherit if the function naively forwarded order.gateway.
    expect(payout.gateway).not.toBe("cod");
    expect(["paystack", "flutterwave", "devmock"]).toContain(payout.gateway);

    // Second call: idempotent. The early-exit pre-check should kick in,
    // and even without it the partial unique index on
    // payouts(order_id, seller_id) would prevent a duplicate row.
    await payments.scheduleCodPayoutsOnDelivery(orderId);
    const secondPass = await db
      .select()
      .from(schema.payoutsTable)
      .where(sql`${schema.payoutsTable.orderId} = ${orderId}`);
    expect(secondPass).toHaveLength(1);
    expect(secondPass[0]!.id).toBe(payout.id);
  });

  it("does nothing when the order's gateway is not 'cod' (prepaid orders untouched)", async () => {
    const buyerId = `${TEST_PREFIX}buyer-${rid()}`;
    const sellerId = `${TEST_PREFIX}seller-${rid()}`;
    const productId = `${TEST_PREFIX}prod-${rid()}`;
    const orderId = `${TEST_PREFIX}order-${rid()}`;
    const intentId = `${TEST_PREFIX}intent-${rid()}`;

    await seedSellerWithClearScreening(sellerId);
    await db.insert(schema.productsTable).values({
      id: productId,
      title: "Prepaid product",
      priceMinor: 5_000_00,
      originCountry: "NG",
      originLabel: "Lagos",
      sellerName: "Prepaid Co",
      sellerUserId: sellerId,
    });
    await db.insert(schema.usersTable).values({
      clerkId: buyerId,
      email: `${buyerId}@example.test`,
      displayName: "Prepaid buyer",
    });
    await db.insert(schema.paymentIntentsTable).values({
      id: intentId,
      userId: buyerId,
      purpose: "order",
      orderId,
      gateway: "paystack",
      reference: `${TEST_PREFIX}ref-${rid()}`,
      amountMinor: 5_000_00,
      currencyCode: "NGN",
      status: "succeeded",
    });
    await db.insert(schema.ordersTable).values({
      id: orderId,
      userId: buyerId,
      status: "delivered",
      countryCode: "NG",
      currencyCode: "NGN",
      items: [{ productId, qty: 1, priceMinor: 5_000_00 }],
      fulfillment: { optionId: "door_lagos" },
      totalsMinor: { subtotal: 5_000_00, total: 5_000_00 },
      gateway: "paystack",
      paymentIntentId: intentId,
      paidAt: new Date(),
    });

    await payments.scheduleCodPayoutsOnDelivery(orderId);
    const payouts = await db
      .select()
      .from(schema.payoutsTable)
      .where(sql`${schema.payoutsTable.orderId} = ${orderId}`);
    expect(payouts).toHaveLength(0);
  });
});
