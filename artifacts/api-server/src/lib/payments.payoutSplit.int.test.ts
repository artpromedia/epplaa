import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import crypto from "node:crypto";

/**
 * Integration regression suite for the mixed-seller payout split that
 * `finalizeOrderAfterPayment` (called from `markIntentSucceeded`) writes
 * to the `payouts` table.
 *
 * The payments work was rebuilt three times before passing review (see
 * task-11.md). The two highest-risk classes of regression in this code
 * path were:
 *
 *   1. The wrong row received money — e.g. a per-line `sellerUserId`
 *      lookup that fell back to `order.userId` (the BUYER) when a
 *      product had no seller mapping. Symptom: refunds/clawback look
 *      sane but a buyer with the same id has been silently credited.
 *
 *   2. The wrong hold window — the trusted-tier 1-day vs starter-tier
 *      7-day hold was inverted in one revision, releasing
 *      starter-seller funds prematurely and exposing the platform to
 *      chargeback losses on the most fraud-prone cohort.
 *
 * We seed a single order with three lines: one trusted-seller line,
 * one starter-seller line, and one line whose product has NO
 * `sellerUserId`. Then we drive `markIntentSucceeded` (the public
 * convergence point both the webhook and the verify poll call) and
 * assert per-seller payout amount, hold window, and the
 * unattributed-line containment rule (platform absorbs, no one else
 * receives the money).
 *
 * Skips itself if DATABASE_URL is not configured. Cleans up its own
 * rows so it does not pollute shared dev data.
 */

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const TEST_PREFIX = "test-payout-split-";

function rid(): string {
  return crypto.randomBytes(8).toString("hex");
}

d("payments — mixed-seller order payout split", () => {
  type Db = typeof import("./db")["db"];
  type Schema = typeof import("./db")["schema"];
  type Sql = typeof import("drizzle-orm")["sql"];
  type Payments = typeof import("./payments");

  let db: Db;
  let schema: Schema;
  let sql: Sql;
  let payments: Payments;

  async function cleanup(): Promise<void> {
    // Order matters: delete child rows before the rows they reference.
    // The unique indexes on payouts are partial WHERE order_id IS NOT
    // NULL, so we delete by orderId LIKE the test prefix.
    await db.execute(
      sql`DELETE FROM payouts WHERE order_id LIKE ${TEST_PREFIX + "%"} OR seller_id LIKE ${TEST_PREFIX + "%"};`,
    );
    await db.execute(
      sql`DELETE FROM payment_attempts WHERE intent_id LIKE ${TEST_PREFIX + "%"};`,
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
      sql`DELETE FROM notifications_outbox WHERE user_id LIKE ${TEST_PREFIX + "%"};`,
    );
    await db.execute(
      sql`DELETE FROM sanctions_screenings WHERE user_id LIKE ${TEST_PREFIX + "%"};`,
    );
    // Users last — orders/payment_intents now FK into users.clerk_id,
    // so the user row must outlive the rows that reference it.
    await db.execute(
      sql`DELETE FROM users WHERE clerk_id LIKE ${TEST_PREFIX + "%"};`,
    );
  }

  beforeAll(async () => {
    if (!process.env.SESSION_SECRET) {
      // payments.ts indirectly imports kyc.ts which requires a session
      // secret >= 16 chars to derive document keys. We only exercise
      // payout splitting (not KYC document encryption) but the import
      // graph still touches that module so a placeholder is required.
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

  it("splits per-seller correctly with tier-based holds and absorbs unattributed lines", async () => {
    const buyerId = `${TEST_PREFIX}buyer-${rid()}`;
    const trustedSellerId = `${TEST_PREFIX}trusted-${rid()}`;
    const starterSellerId = `${TEST_PREFIX}starter-${rid()}`;
    const orphanedProductId = `${TEST_PREFIX}prod-orphan-${rid()}`;
    const trustedProductId = `${TEST_PREFIX}prod-trusted-${rid()}`;
    const starterProductId = `${TEST_PREFIX}prod-starter-${rid()}`;
    const orderId = `${TEST_PREFIX}order-${rid()}`;
    const intentId = `${TEST_PREFIX}intent-${rid()}`;

    // Seed sellers — note kycTier=3 so requiredTierForOrder() never blocks
    // payouts (we are testing splitting, not the KYC gate).
    await db.insert(schema.sellersTable).values([
      {
        userId: trustedSellerId,
        status: "active",
        tier: "trusted",
        mode: "seller",
        kycTier: 3,
      },
      {
        userId: starterSellerId,
        status: "active",
        tier: "starter",
        mode: "seller",
        kycTier: 3,
      },
    ]);

    // Seed a recent CLEAR sanctions screening for each seller. The
    // sanctions check is conservative-by-default: an unscreened seller
    // is treated as blocked. We are not exercising the sanctions gate
    // here, only the splitting math + tier-based holds, so we
    // pre-clear the sellers to keep the assertion focused.
    await db.insert(schema.sanctionsScreeningsTable).values([
      {
        id: `${TEST_PREFIX}sx-${rid()}`,
        userId: trustedSellerId,
        subjectKind: "seller",
        provider: "stub",
        matchScore: 0,
        status: "clear",
      },
      {
        id: `${TEST_PREFIX}sx-${rid()}`,
        userId: starterSellerId,
        subjectKind: "seller",
        provider: "stub",
        matchScore: 0,
        status: "clear",
      },
    ]);

    // Seed products — orphan line has NO sellerUserId, which routes its
    // gross to `unattributedMinor` and (per spec) the platform absorbs it.
    await db.insert(schema.productsTable).values([
      {
        id: trustedProductId,
        title: "Trusted seller product",
        priceMinor: 10_000_00, // 10,000 NGN
        originCountry: "NG",
        originLabel: "Lagos",
        sellerName: "Trusted Co",
        sellerUserId: trustedSellerId,
      },
      {
        id: starterProductId,
        title: "Starter seller product",
        priceMinor: 5_000_00, // 5,000 NGN
        originCountry: "NG",
        originLabel: "Lagos",
        sellerName: "Starter Co",
        sellerUserId: starterSellerId,
      },
      {
        id: orphanedProductId,
        title: "Legacy seedling product (no seller)",
        priceMinor: 2_500_00, // 2,500 NGN
        originCountry: "NG",
        originLabel: "Lagos",
        sellerName: "Legacy Co",
        // sellerUserId intentionally NULL — exercises the
        // unattributedMinor branch. A regression that fell back to
        // order.userId (the BUYER) here would create a payout for the
        // buyer and the assertions below would catch it.
      },
    ]);

    // Seed buyer user. The DB-level FK orders.user_id -> users.clerk_id
    // (added by initMoneyFlowFkConstraints) requires a real user row
    // before we can attach an order to `buyerId`. Tests previously got
    // away with not seeding because the column was unconstrained.
    await db.insert(schema.usersTable).values({
      clerkId: buyerId,
      email: `${buyerId}@example.test`,
      displayName: "payout split buyer",
    });

    // Seed order: 3 lines totalling 10000 + 5000 + 2500 = 17,500 NGN
    // (unit prices already in kobo via price_minor; qty=1 each).
    await db.insert(schema.ordersTable).values({
      id: orderId,
      userId: buyerId,
      status: "pending_payment",
      countryCode: "NG",
      currencyCode: "NGN",
      items: [
        { productId: trustedProductId, qty: 1, priceMinor: 10_000_00 },
        { productId: starterProductId, qty: 1, priceMinor: 5_000_00 },
        { productId: orphanedProductId, qty: 1, priceMinor: 2_500_00 },
      ],
      // Door delivery so finalize picks "out_for_delivery" (not pickup).
      // The status branch isn't under test but we want a deterministic value.
      fulfillment: { optionId: "door_lagos" },
      totalsMinor: { subtotal: 17_500_00, total: 17_500_00 },
    });

    // Seed processing intent linked to the order. We pre-insert it so we
    // don't need to drive the gateway charge path; markIntentSucceeded
    // is the convergence point for both webhook and verify-poll callers
    // and is responsible for invoking finalizeOrderAfterPayment.
    await db.insert(schema.paymentIntentsTable).values({
      id: intentId,
      userId: buyerId,
      purpose: "order",
      orderId,
      gateway: "devmock",
      reference: `${TEST_PREFIX}ref-${rid()}`,
      amountMinor: 17_500_00,
      currencyCode: "NGN",
      status: "processing",
    });

    const paidAt = new Date();
    await payments.markIntentSucceeded(intentId, paidAt);

    // ---- Assert payouts ----
    const allPayouts = await db
      .select()
      .from(schema.payoutsTable)
      .where(sql`${schema.payoutsTable.orderId} = ${orderId}`);

    // Exactly two payouts: one per attributed seller. The orphan line
    // must not have produced a third row (no payout for unattributed
    // lines, no payout for the buyer, no payout for a manufacturer
    // since none was attributed).
    expect(allPayouts).toHaveLength(2);
    const byUser = new Map(allPayouts.map((p) => [p.userId, p]));

    // Trusted-seller payout: 10,000 NGN gross → 10% platform = 1,000 NGN
    // → 9,000 NGN seller share = 900_000 kobo.
    const trustedPayout = byUser.get(trustedSellerId);
    expect(trustedPayout).toBeDefined();
    expect(trustedPayout!.amountMinor).toBe(900_000);
    expect(trustedPayout!.kind).toBe("seller_share");
    expect(trustedPayout!.status).toBe("pending");
    expect(trustedPayout!.sellerId).toBe(trustedSellerId);
    // Trusted tier hold window = 1 day. Allow 5s of clock skew between
    // `paidAt` (set above) and the value Postgres roundtripped.
    const trustedHoldMs = trustedPayout!.holdUntil!.getTime() - paidAt.getTime();
    const ONE_DAY = 24 * 3600 * 1000;
    expect(Math.abs(trustedHoldMs - ONE_DAY)).toBeLessThan(5_000);

    // Starter-seller payout: 5,000 NGN gross → 10% = 500 NGN
    // → 4,500 NGN seller share = 450_000 kobo.
    const starterPayout = byUser.get(starterSellerId);
    expect(starterPayout).toBeDefined();
    expect(starterPayout!.amountMinor).toBe(450_000);
    expect(starterPayout!.kind).toBe("seller_share");
    expect(starterPayout!.status).toBe("pending");
    expect(starterPayout!.sellerId).toBe(starterSellerId);
    // Starter tier hold window = 7 days.
    const starterHoldMs = starterPayout!.holdUntil!.getTime() - paidAt.getTime();
    const SEVEN_DAYS = 7 * 24 * 3600 * 1000;
    expect(Math.abs(starterHoldMs - SEVEN_DAYS)).toBeLessThan(5_000);

    // ---- Containment: no payout to the buyer or to a wrong seller. ----
    // A regression where unattributed lines fell back to order.userId
    // would create a buyer payout — the most expensive defect in this
    // codepath because it silently sends real money to the wrong party.
    expect(byUser.has(buyerId)).toBe(false);
    // No manufacturer payouts either (no manufacturerUserId on any line).
    const manufacturerPayouts = allPayouts.filter((p) => p.kind === "manufacturer_share");
    expect(manufacturerPayouts).toHaveLength(0);

    // The total disbursed (900_000 + 450_000 = 1_350_000 kobo) is strictly
    // less than the order subtotal (1_750_000 kobo). The difference is
    // 400_000 kobo: 100_000 platform fee on the trusted line, 50_000
    // platform fee on the starter line, and the entire 250_000 orphaned
    // line. Asserting the math defends against a subtle regression
    // where the orphan line was attributed to one of the real sellers.
    const totalDisbursed = allPayouts.reduce((s, p) => s + p.amountMinor, 0);
    expect(totalDisbursed).toBe(900_000 + 450_000);
    expect(totalDisbursed).toBeLessThan(17_500_00);

    // ---- Assert order side-effects ----
    const [orderAfter] = await db
      .select()
      .from(schema.ordersTable)
      .where(sql`${schema.ordersTable.id} = ${orderId}`);
    expect(orderAfter).toBeDefined();
    expect(orderAfter.paidAt).not.toBeNull();
    expect(orderAfter.status).toBe("out_for_delivery");
    // hold_until is the latest recipient hold = max(trusted=1d, starter=7d)
    // = 7 days, NOT 1 day. A regression that took the min would mark the
    // order settled too early on buyer-facing surfaces.
    expect(orderAfter.holdUntil).not.toBeNull();
    const orderHoldMs = orderAfter.holdUntil!.getTime() - paidAt.getTime();
    expect(Math.abs(orderHoldMs - SEVEN_DAYS)).toBeLessThan(5_000);
  }, 30_000);
});
