import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import crypto from "node:crypto";
import express, { type Express } from "express";
import request from "supertest";

/**
 * Integration regression for the inbound-webhook idempotency contract.
 *
 * Real gateways re-deliver webhook events whenever they don't see a
 * 200 within their retry window, AND a frontend `verify` poll can race
 * the inbound webhook for the same intent. Both callers ultimately
 * land in `markIntentSucceeded`, which is the convergence point that
 * commits the side-effects (wallet credit row, payout row(s), order
 * status flip). The original payments work was rebuilt three times
 * before passing review (see task-11.md), and at least one of those
 * rebuilds shipped a regression where N concurrent deliveries of the
 * same event id created N wallet-credit rows — i.e. the user got
 * topped up multiple times for one charge.
 *
 * This test pins the contract by:
 *   1. Mounting the real `webhooks` router on a minimal Express app
 *      with the same raw-body parser the production app uses.
 *   2. Seeding a `processing` wallet-topup intent.
 *   3. Firing N parallel POSTs to `/api/webhooks/devmock` carrying the
 *      same valid-signature body (so the gateway-level eventId, which
 *      the devmock derives from `sha256(reference:status)`, is
 *      identical across all N deliveries).
 *   4. Asserting exactly ONE wallet_txns row exists for the intent.
 *
 * The two layers under test cooperate to enforce the contract:
 *   a) `payment_webhooks(gateway, gateway_event_id)` unique index +
 *      `onConflictDoNothing` on the inbound write so only one delivery
 *      is allowed to begin processing per event id.
 *   b) `markIntentSucceeded` uses a conditional UPDATE
 *      (`WHERE status != 'succeeded'`) and `wallet_txns` has a partial
 *      unique index on `intent_id` for `kind='topup'` rows.
 *
 * Wallet topup is used (rather than an order) to keep the seed data
 * minimal — order finalization brings in products + sellers + dispatch
 * carriers — but the same idempotency code path covers both branches
 * of `markIntentSucceeded` via the same status guard.
 *
 * Skips itself if DATABASE_URL is not configured. Cleans up its own
 * rows so it does not pollute shared dev data.
 */

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const TEST_PREFIX = "test-wh-conc-";

function rid(): string {
  return crypto.randomBytes(8).toString("hex");
}

d("webhooks — concurrent delivery idempotency", () => {
  type Db = typeof import("../lib/db")["db"];
  type Schema = typeof import("../lib/db")["schema"];
  type Sql = typeof import("drizzle-orm")["sql"];

  let db: Db;
  let schema: Schema;
  let sql: Sql;
  let app: Express;
  // Captured at module init time to avoid re-importing it inside each
  // test (which would create a fresh DevMockGateway with an empty
  // ledger, but the verifier doesn't need the ledger so it's fine).
  let DEV_MOCK_SECRET: string;

  async function cleanup(): Promise<void> {
    await db.execute(
      sql`DELETE FROM wallet_txns WHERE intent_id LIKE ${TEST_PREFIX + "%"} OR user_id LIKE ${TEST_PREFIX + "%"};`,
    );
    await db.execute(
      sql`DELETE FROM payment_attempts WHERE intent_id LIKE ${TEST_PREFIX + "%"};`,
    );
    await db.execute(
      sql`DELETE FROM payment_webhooks WHERE reference LIKE ${TEST_PREFIX + "%"};`,
    );
    await db.execute(
      sql`DELETE FROM payment_intents WHERE id LIKE ${TEST_PREFIX + "%"};`,
    );
    await db.execute(
      sql`DELETE FROM notifications_outbox WHERE user_id LIKE ${TEST_PREFIX + "%"};`,
    );
  }

  beforeAll(async () => {
    if (!process.env.SESSION_SECRET) {
      // Same rationale as the payout-split int test: the import graph
      // touches kyc.ts which requires SESSION_SECRET. Not exercised
      // here directly.
      process.env.SESSION_SECRET = crypto.randomBytes(32).toString("hex");
    }
    ({ db, schema } = await import("../lib/db"));
    ({ sql } = await import("drizzle-orm"));
    const devMockMod = await import("@workspace/payments");
    DEV_MOCK_SECRET = devMockMod.DEV_MOCK_SECRET;
    const webhooksRouter = (await import("./webhooks")).default;

    // Minimal app — exactly mirrors the production mount in app.ts:
    // raw body parser is required so the HMAC verifier sees the
    // unmodified bytes the signer signed. We deliberately do NOT mount
    // express.json() before the router; that's what the real app
    // depends on and a regression that swapped the order would break
    // the live signature check too.
    app = express();
    app.use("/api/webhooks", express.raw({ type: "*/*", limit: "1mb" }), webhooksRouter);
    await cleanup();
  }, 30_000);

  afterEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("creates exactly one wallet_txns side-effect row for N parallel deliveries of the same event id", async () => {
    const userId = `${TEST_PREFIX}user-${rid()}`;
    const intentId = `${TEST_PREFIX}intent-${rid()}`;
    const reference = `${TEST_PREFIX}ref-${rid()}`;
    const N_DELIVERIES = 20;
    const TOPUP_AMOUNT_MINOR = 12_345_00;

    // Seed: one processing wallet-topup intent. The webhook handler
    // looks the intent up by `reference`, so reference must match.
    await db.insert(schema.paymentIntentsTable).values({
      id: intentId,
      userId,
      purpose: "wallet_topup",
      orderId: null,
      gateway: "devmock",
      reference,
      amountMinor: TOPUP_AMOUNT_MINOR,
      currencyCode: "NGN",
      status: "processing",
    });

    // Build a single (deterministic) signed body. All N requests carry
    // the IDENTICAL body, so the gateway-level eventId
    // (sha256(`devmock:${reference}:${status}`)) is identical for all
    // of them — exactly the shape of a real-world replay storm.
    const body = JSON.stringify({
      reference,
      status: "success",
      amountMinor: TOPUP_AMOUNT_MINOR,
      currencyCode: "NGN",
    });
    const rawBody = Buffer.from(body, "utf8");
    const signature = crypto
      .createHash("sha256")
      .update(DEV_MOCK_SECRET)
      .update(rawBody)
      .digest("hex");

    // Fire N parallel POSTs. Promise.all races them through the same
    // event loop; node's pg driver multiplexes them across the pool so
    // any race in markIntentSucceeded / wallet_txns insert will surface
    // as duplicate rows.
    // NOTE on Content-Type: production mounts the webhook router behind
    // `express.raw({ type: "*/*" })`, so the parser preserves the
    // exact bytes the gateway signed regardless of Content-Type. We
    // send `application/octet-stream` here and pass the Buffer
    // verbatim — calling `.send(rawBody)` together with a JSON
    // Content-Type would let supertest re-serialize the Buffer
    // (turning it into `{"type":"Buffer","data":[...]}`) and break
    // the HMAC check, which is a test-only artifact, not a real
    // production failure mode.
    const responses = await Promise.all(
      Array.from({ length: N_DELIVERIES }, () =>
        request(app)
          .post("/api/webhooks/devmock")
          .set("Content-Type", "application/octet-stream")
          .set("x-devmock-signature", signature)
          .send(rawBody),
      ),
    );

    // Every delivery must respond 200 (gateways disable endpoints that
    // 4xx/5xx repeatedly). Some will succeed, others will be replays —
    // both shapes are 200.
    for (const r of responses) {
      expect(r.status).toBe(200);
    }

    // ---- Side-effect assertion: exactly ONE wallet_txns row. ----
    const walletRows = await db
      .select()
      .from(schema.walletTxnsTable)
      .where(sql`${schema.walletTxnsTable.intentId} = ${intentId}`);
    expect(walletRows).toHaveLength(1);
    const w = walletRows[0]!;
    expect(w.kind).toBe("topup");
    expect(w.amountMinor).toBe(TOPUP_AMOUNT_MINOR);
    expect(w.userId).toBe(userId);
    expect(w.status).toBe("succeeded");

    // ---- Idempotency at the webhook layer: only one row in
    // payment_webhooks for the dedupe key (gateway, gatewayEventId).
    // The unique index guarantees this — a regression that dropped
    // it would let multiple processing attempts run concurrently. ----
    const webhookRows = await db
      .select()
      .from(schema.paymentWebhooksTable)
      .where(sql`${schema.paymentWebhooksTable.reference} = ${reference}`);
    expect(webhookRows).toHaveLength(1);
    expect(webhookRows[0]!.signatureValid).toBe(true);
    expect(webhookRows[0]!.processedAt).not.toBeNull();
    // The losing deliveries observe processedAt set + processError null
    // and respond `{ ok: true, replay: true }`; only the first delivery
    // ran the side-effect path.
    expect(webhookRows[0]!.processError).toBeNull();

    // ---- Intent terminal state: succeeded exactly once. ----
    const [intentAfter] = await db
      .select()
      .from(schema.paymentIntentsTable)
      .where(sql`${schema.paymentIntentsTable.id} = ${intentId}`);
    expect(intentAfter.status).toBe("succeeded");
    expect(intentAfter.paidAt).not.toBeNull();
  }, 30_000);
});
