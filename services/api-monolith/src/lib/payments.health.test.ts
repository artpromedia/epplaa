import { describe, it, expect, vi, beforeAll } from "vitest";

/**
 * Verify that the boot-time wiring in `lib/payments.ts` correctly
 * registers a `SubsystemFailureWatcher` for every configured real
 * gateway AND that the in-DB `DbHealthStore.record` path also feeds
 * the watcher with each success/failure observation.
 *
 * This is the analogue of the DB-watcher tests in
 * `routes/health.test.ts` (which drive `dbHealthWatcher` end-to-end
 * through `/readyz`), except the equivalent driver here is
 * `gatewayRouter.withFailover` — there is no HTTP endpoint that
 * directly exercises `lib/payments.ts`, so the test invokes the
 * router with a synthetic op the way `createPaymentIntent` does.
 *
 * The DB layer is mocked out so the test runs without a live
 * Postgres pool: the only DB call exercised at module init or
 * during `health.record(...)` is the gateway_health upsert in
 * `DbHealthStore.record`, which we stub to a no-op.
 */

// Set BEFORE any import: PaystackGateway/FlutterwaveGateway capture
// these at construction in lib/payments.ts module init. Putting both
// keys in means both watchers get registered, which lets us verify
// that the registry correctly differentiates by gateway name.
process.env.PAYSTACK_SECRET_KEY = "sk_test_health_check";
process.env.FLUTTERWAVE_SECRET_KEY = "FLWSECK_TEST-health-check";
process.env.FLUTTERWAVE_WEBHOOK_HASH = "hash_health_check";

// Mock db just enough to satisfy the drizzle chains hit on the
// tested code paths. Most tests only reach DbHealthStore.record
// (`insert().values().onConflictDoUpdate()` + `select().from().where().limit()`)
// — the callsite-level integration tests for `reverifyIntent` and
// `processDuePayouts` reach a few more chains and override
// `limitMock` / `whereUpdateMock` per-test via `mockResolvedValueOnce`
// / `mockReturnValueOnce` to inject row fixtures.
const onConflictDoUpdateMock = vi.fn().mockResolvedValue(undefined);
const valuesMock = vi.fn().mockReturnValue({
  onConflictDoUpdate: onConflictDoUpdateMock,
  returning: vi.fn().mockResolvedValue([]),
});
const limitMock = vi.fn().mockResolvedValue([]);
const whereSelectMock = vi.fn().mockReturnValue({ limit: limitMock });
const fromMock = vi.fn().mockReturnValue({ where: whereSelectMock });
// `update().set().where(...)` is awaited directly in most call sites
// (DbHealthStore.openCircuit, payout-status updates, etc.), but
// `processDuePayouts` does `update().set().where(...).returning()` to
// atomically claim due payouts. The default is a thenable that
// resolves to undefined AND exposes `.returning()` so both shapes
// work without the existing tests breaking, and tests that need to
// inject claimed-row fixtures can do
// `whereUpdateMock.mockReturnValueOnce(makeWhereUpdateResult([row]))`.
function makeWhereUpdateResult(returningRows: unknown[] = []) {
  // Thenable so `await where(...)` resolves to undefined (the previous
  // behaviour), with a `.returning()` escape hatch so the same handle
  // also satisfies `update().set().where().returning()`.
  return {
    then: (resolve: (v: undefined) => unknown) => resolve(undefined),
    returning: vi.fn().mockResolvedValue(returningRows),
  };
}
const whereUpdateMock = vi
  .fn()
  .mockImplementation(() => makeWhereUpdateResult());
const setMock = vi.fn().mockReturnValue({ where: whereUpdateMock });
vi.mock("./db", () => ({
  db: {
    insert: () => ({ values: valuesMock }),
    select: () => ({ from: fromMock }),
    update: () => ({ set: setMock }),
  },
  schema: {
    gatewayHealthTable: { gateway: "gateway" },
    paymentIntentsTable: {},
    paymentAttemptsTable: {},
    walletTxnsTable: {},
    ordersTable: {},
    payoutsTable: {},
    productsTable: {},
    sellersTable: {},
    manufacturersTable: {},
  },
}));

vi.mock("./logger", () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

// Heavy downstream deps that lib/payments.ts reaches at runtime but
// not at module init. Stubbed to avoid pulling in their own module
// graphs (db, schemas, etc.) when this test loads payments.ts.
vi.mock("./notifications", () => ({ enqueueNotification: vi.fn() }));
vi.mock("./fulfillment/dispatch", () => ({
  dispatchShipmentForOrder: vi.fn(),
}));
vi.mock("./kyc", () => ({ requiredTierForOrder: () => 1 }));
vi.mock("./sanctions", () => ({
  sellerSanctionsBlocked: () => false,
  manufacturerSanctionsBlocked: () => false,
}));
vi.mock("./audit", () => ({ recordAudit: vi.fn() }));

const {
  getPaymentGatewayWatcher,
  __resetPaymentGatewayWatchersForTests,
} = await import("./subsystemHealth");

// IMPORTANT: importing lib/payments.ts triggers the boot-time
// registerPaymentGatewayWatcher loop, which is exactly what we want
// to assert on. Resetting the registry BEFORE the import would clear
// the entries we are about to verify, so do it after the import is
// in flight via `beforeAll` — but only for the *re-run* path.
const { gatewayRouter, gateways, reverifyIntent, processDuePayouts } =
  await import("./payments");

describe("lib/payments — payment-gateway watcher integration with subsystemHealth", () => {
  beforeAll(() => {
    // Don't reset between cases: the registry was populated at module
    // init (the behaviour under test). Re-resetting would lose that
    // and force every case to re-register manually, which would no
    // longer prove the boot-time wiring works.
  });

  it("registers a watcher for every real, configured gateway at module init", () => {
    // Both keys were set above before the dynamic `await import`, so
    // selectPrimaryAndSecondary() picks `live` mode and the registry
    // loop registers both watchers. A regression that registered only
    // the primary would silently mask Flutterwave outages on a deploy
    // where Paystack stays healthy.
    expect(getPaymentGatewayWatcher("paystack")).toBeDefined();
    expect(getPaymentGatewayWatcher("flutterwave")).toBeDefined();
  });

  it("does NOT register a watcher for the dev-mock gateway", () => {
    // Dev-mock is selected only when neither real gateway is
    // configured; it returns fake `{ ok: true }` results and a
    // permanently-healthy `paymentGatewayDevmock` entry would mask
    // the matching `payment_provider_missing_for_production` boot
    // warning during triage.
    expect(getPaymentGatewayWatcher("devmock")).toBeUndefined();
  });

  it("flips the gateway watcher to degraded across a stuck-failure streak driven through GatewayRouter.withFailover", async () => {
    // Equivalent to the rate-limit and DB stuck-degraded scenarios:
    // a gateway that keeps returning errors should accumulate a
    // failure streak with a sticky firstFailureAt. We drive the
    // router with an op that always returns `{ ok: false }`, the
    // way createPaymentIntent does for a charge that the gateway
    // rejects.
    __resetPaymentGatewayWatchersForTests();
    const { registerPaymentGatewayWatcher } = await import(
      "./subsystemHealth"
    );
    registerPaymentGatewayWatcher("paystack");
    registerPaymentGatewayWatcher("flutterwave");

    // Two consecutive failures on the primary. withFailover will
    // also try the secondary on each call (also failing here), so
    // the secondary will accumulate failures too — that's a
    // realistic correlated-outage scenario.
    const failingOp = vi
      .fn()
      .mockResolvedValue({ ok: false, errorMessage: "gateway_5xx" });
    await gatewayRouter.withFailover("paystack", failingOp);
    await gatewayRouter.withFailover("paystack", failingOp);

    const paystackSnap = getPaymentGatewayWatcher("paystack")!.getSnapshot();
    const flutterwaveSnap = getPaymentGatewayWatcher(
      "flutterwave",
    )!.getSnapshot();
    expect(paystackSnap.state).toBe("degraded");
    expect(paystackSnap.failureCount).toBeGreaterThanOrEqual(2);
    expect(typeof paystackSnap.firstFailureAt).toBe("number");
    // The secondary saw failover traffic and also failed in this
    // synthetic scenario — both watchers degrade independently.
    expect(flutterwaveSnap.state).toBe("degraded");
  });

  it("clears the gateway streak and stamps lastRecoveredAt on the next successful op", async () => {
    // Recovery semantics must match dbHealthWatcher: a single
    // success closes the streak, resets failureCount, and stamps
    // lastRecoveredAt so dashboards can timeline the incident.
    __resetPaymentGatewayWatchersForTests();
    const { registerPaymentGatewayWatcher } = await import(
      "./subsystemHealth"
    );
    registerPaymentGatewayWatcher("paystack");
    registerPaymentGatewayWatcher("flutterwave");

    const failingOp = vi
      .fn()
      .mockResolvedValue({ ok: false, errorMessage: "gateway_5xx" });
    await gatewayRouter.withFailover("paystack", failingOp);
    await gatewayRouter.withFailover("paystack", failingOp);
    expect(getPaymentGatewayWatcher("paystack")!.getSnapshot().state).toBe(
      "degraded",
    );

    const okOp = vi.fn().mockResolvedValue({ ok: true });
    await gatewayRouter.withFailover("paystack", okOp);

    const snap = getPaymentGatewayWatcher("paystack")!.getSnapshot();
    expect(snap.state).toBe("healthy");
    expect(snap.failureCount).toBe(0);
    expect(snap.firstFailureAt).toBeNull();
    expect(typeof snap.lastRecoveredAt).toBe("number");
  });

  it("flips the gateway watcher to degraded for a stuck-verify scenario via recordDirectCallOutcome", async () => {
    // Mirror the charge-path stuck-failure test, but for the
    // `reverifyIntent` call site that hits `gw.verify(...)` directly
    // (no failover — verify must hit the gateway that issued the
    // original charge). Without `recordDirectCallOutcome` the verify
    // path would silently bypass the `paymentGatewayWatchers` streak,
    // so a Paystack outage that only stalls /verify would never page
    // on-call via the duration-based stuck-degraded alert.
    __resetPaymentGatewayWatchersForTests();
    const { registerPaymentGatewayWatcher } = await import(
      "./subsystemHealth"
    );
    registerPaymentGatewayWatcher("paystack");
    registerPaymentGatewayWatcher("flutterwave");

    // Synthetic verify op that always returns { ok: false } — the
    // way Paystack's /transaction/verify would behave during a
    // reconciliation outage. We drive the same outcome-recording
    // helper that the real call site invokes.
    const stuckVerifyResult = { ok: false, errorMessage: "verify_5xx" };
    await gatewayRouter.recordDirectCallOutcome(
      "paystack",
      stuckVerifyResult.ok,
    );
    await gatewayRouter.recordDirectCallOutcome(
      "paystack",
      stuckVerifyResult.ok,
    );

    const paystackSnap = getPaymentGatewayWatcher("paystack")!.getSnapshot();
    expect(paystackSnap.state).toBe("degraded");
    expect(paystackSnap.failureCount).toBeGreaterThanOrEqual(2);
    expect(typeof paystackSnap.firstFailureAt).toBe("number");
    // Verify is single-gateway (no failover), so the secondary's
    // watcher should remain healthy — unlike the charge-path test
    // where failover spreads failures to both watchers.
    const flutterwaveSnap = getPaymentGatewayWatcher(
      "flutterwave",
    )!.getSnapshot();
    expect(flutterwaveSnap.state).toBe("healthy");
  });

  it("flips the gateway watcher to degraded for a stuck-payout scenario via recordDirectCallOutcome", async () => {
    // Same shape as the stuck-verify test but for the
    // `processDuePayouts` call site that hits `gw.payout(...)`
    // directly. Manufacturer payouts pin the Flutterwave
    // international rail regardless of which gateway charged the
    // buyer, so a stuck Flutterwave disbursement endpoint has to
    // surface on the Flutterwave-specific watcher even when Paystack
    // (the charge primary) is perfectly healthy.
    __resetPaymentGatewayWatchersForTests();
    const { registerPaymentGatewayWatcher } = await import(
      "./subsystemHealth"
    );
    registerPaymentGatewayWatcher("paystack");
    registerPaymentGatewayWatcher("flutterwave");

    const stuckPayoutResult = { ok: false, errorMessage: "transfer_timeout" };
    await gatewayRouter.recordDirectCallOutcome(
      "flutterwave",
      stuckPayoutResult.ok,
    );
    await gatewayRouter.recordDirectCallOutcome(
      "flutterwave",
      stuckPayoutResult.ok,
    );

    const flutterwaveSnap = getPaymentGatewayWatcher(
      "flutterwave",
    )!.getSnapshot();
    expect(flutterwaveSnap.state).toBe("degraded");
    expect(flutterwaveSnap.failureCount).toBeGreaterThanOrEqual(2);
    expect(typeof flutterwaveSnap.firstFailureAt).toBe("number");
    // Paystack's watcher must NOT be tripped by a Flutterwave-only
    // disbursement outage — the per-gateway separation is the whole
    // point of registering one watcher per gateway rather than a
    // single combined `paymentGateway` entry.
    const paystackSnap = getPaymentGatewayWatcher("paystack")!.getSnapshot();
    expect(paystackSnap.state).toBe("healthy");
  });

  it("records a verify/payout failure observation even when the underlying call throws", async () => {
    // The most dangerous failure mode for a "stuck" upstream is a
    // hung connection that eventually throws (timeout / socket
    // error). The wrappers in `reverifyIntent` and `processDuePayouts`
    // must catch+record before re-raising, otherwise the streak
    // would silently stay at zero on the worst kind of outage.
    // Simulate that contract here by recording a failure exactly
    // once per thrown-and-caught call, then re-raising.
    __resetPaymentGatewayWatchersForTests();
    const { registerPaymentGatewayWatcher } = await import(
      "./subsystemHealth"
    );
    registerPaymentGatewayWatcher("paystack");

    const hangingVerify = vi.fn().mockRejectedValue(new Error("ETIMEDOUT"));
    for (let i = 0; i < 2; i++) {
      try {
        await hangingVerify();
      } catch {
        await gatewayRouter.recordDirectCallOutcome("paystack", false);
      }
    }
    const snap = getPaymentGatewayWatcher("paystack")!.getSnapshot();
    expect(snap.state).toBe("degraded");
    expect(snap.failureCount).toBeGreaterThanOrEqual(2);
  });

  it("ignores observations for unregistered gateway names instead of throwing", async () => {
    // Defensive: GatewayName is a typed union but the call site
    // ultimately passes a string into the registry lookup. A bogus
    // value (e.g. a future gateway whose watcher hasn't been wired
    // yet, or a typo in a test fixture) must not crash the router's
    // record path — silently no-op-ing matches the runtime
    // contract documented on getPaymentGatewayWatcher.
    __resetPaymentGatewayWatchersForTests();
    // No watchers registered. A failed op driven through the router
    // should still complete cleanly because feedPaymentGatewayWatcher
    // returns early when the gateway isn't in the registry.
    const failingOp = vi
      .fn()
      .mockResolvedValue({ ok: false, errorMessage: "gateway_5xx" });
    await expect(
      gatewayRouter.withFailover("paystack", failingOp),
    ).resolves.toBeDefined();
    expect(getPaymentGatewayWatcher("paystack")).toBeUndefined();
  });

  it("[callsite] reverifyIntent feeds the watcher via recordDirectCallOutcome", async () => {
    // Callsite-level integration test: drive `reverifyIntent` end-to-
    // end through stubbed db rows + a spied gateway, and assert that
    // the wiring added in this task actually invokes
    // `gatewayRouter.recordDirectCallOutcome` with the gateway and
    // outcome. This guards against an accidental future removal of
    // the helper call (which would silently bypass the watcher and
    // re-introduce the original bug).
    __resetPaymentGatewayWatchersForTests();
    const { registerPaymentGatewayWatcher } = await import(
      "./subsystemHealth"
    );
    registerPaymentGatewayWatcher("paystack");

    // First select inside reverifyIntent reads the intent row. The
    // health-store's own selects (called from inside
    // recordDirectCallOutcome) fall through to the default `[]`.
    limitMock.mockResolvedValueOnce([
      {
        id: "pi_test",
        gateway: "paystack",
        reference: "ref_stuck_verify",
        status: "processing",
      },
    ]);
    const verifySpy = vi
      .spyOn(gateways.paystack, "verify")
      .mockResolvedValue({
        ok: false,
        status: "failed",
        reference: "ref_stuck_verify",
        errorMessage: "verify_5xx",
      });
    const recordSpy = vi.spyOn(gatewayRouter, "recordDirectCallOutcome");

    await reverifyIntent("pi_test");

    expect(verifySpy).toHaveBeenCalledWith("ref_stuck_verify");
    // The wiring contract: the verify outcome MUST be recorded on
    // the same gateway that issued the original charge, so the
    // duration-based stuck-degraded probe can observe a
    // verify-only Paystack outage.
    expect(recordSpy).toHaveBeenCalledWith("paystack", false);
    // And the watcher is now in degraded state — proves the path
    // didn't just pretend to record but actually drove the streak.
    const snap = getPaymentGatewayWatcher("paystack")!.getSnapshot();
    expect(snap.state).toBe("degraded");

    verifySpy.mockRestore();
    recordSpy.mockRestore();
  });

  it("[callsite] processDuePayouts feeds the watcher via recordDirectCallOutcome", async () => {
    // Symmetric callsite-level test for the payout path: a
    // claimed-due payout is run through `gw.payout(...)` which we
    // spy to return `{ ok: false }`, and we assert the wiring
    // invokes `recordDirectCallOutcome` so a stuck disbursement
    // endpoint contributes to the gateway's failure streak. The
    // manufacturer-share payout shape is used because it pins
    // Flutterwave (the international rail), which proves the
    // recorded gateway name comes from the actually-invoked
    // gateway rather than a hard-coded primary.
    __resetPaymentGatewayWatchersForTests();
    const { registerPaymentGatewayWatcher } = await import(
      "./subsystemHealth"
    );
    registerPaymentGatewayWatcher("flutterwave");

    // The blocked-rows scan uses `db.select().from(payoutsTable).where(eq(...))`
    // with NO `.limit()` chain — the awaited result is the rows
    // themselves. The default whereSelectMock returns `{limit: limitMock}`
    // (the right shape for the limit-based selects elsewhere) which
    // would not be iterable. Override per-test to return [].
    whereSelectMock.mockReturnValueOnce([]);
    // The atomic claim does `update().set().where().returning()`.
    // Stage one claimed-due manufacturer payout for the
    // disbursement loop.
    whereUpdateMock.mockReturnValueOnce(
      makeWhereUpdateResult([
        {
          id: "po_stuck_payout",
          userId: "mfr_test",
          sellerId: "mfr_test",
          orderId: "ord_test",
          intentId: "pi_test",
          amountMinor: 50000,
          currencyCode: "NGN",
          gateway: "flutterwave",
          kind: "manufacturer_share",
          reference: "MO-ord_test-mfr_te",
          requiredKycTier: 1,
          bankCode: null,
        },
      ]),
    );
    // The first `limit(1)` call reached on this path is
    // loadPayoutDestination's lookup of the manufacturer row —
    // bank details flow through the returned `application` JSON.
    limitMock.mockResolvedValueOnce([
      {
        userId: "mfr_test",
        application: {
          bankCode: "058",
          bankAccount: "0123456789",
          bankName: "Acme Bank",
        },
      },
    ]);

    const payoutSpy = vi
      .spyOn(gateways.flutterwave, "payout")
      .mockResolvedValue({
        ok: false,
        transferReference: "",
        status: "failed",
        errorMessage: "transfer_timeout",
      });
    const recordSpy = vi.spyOn(gatewayRouter, "recordDirectCallOutcome");

    await processDuePayouts();

    expect(payoutSpy).toHaveBeenCalled();
    // Wiring contract: the payout outcome MUST be recorded on the
    // gateway that actually executed the transfer (Flutterwave
    // here, regardless of which gateway charged the buyer).
    expect(recordSpy).toHaveBeenCalledWith("flutterwave", false);
    const snap = getPaymentGatewayWatcher("flutterwave")!.getSnapshot();
    expect(snap.state).toBe("degraded");

    payoutSpy.mockRestore();
    recordSpy.mockRestore();
  });
});
