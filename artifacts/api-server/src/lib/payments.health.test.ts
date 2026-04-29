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

// Mock db just enough to satisfy DbHealthStore.record's drizzle
// chain (`insert(...).values(...).onConflictDoUpdate(...)`). The
// health-store write is the only DB interaction reached on the test
// path; createPaymentIntent / reverifyIntent / payouts are not
// exercised here so their drizzle chains don't need stubbing.
const onConflictDoUpdateMock = vi.fn().mockResolvedValue(undefined);
const valuesMock = vi.fn().mockReturnValue({
  onConflictDoUpdate: onConflictDoUpdateMock,
  returning: vi.fn().mockResolvedValue([]),
});
const limitMock = vi.fn().mockResolvedValue([]);
const whereSelectMock = vi.fn().mockReturnValue({ limit: limitMock });
const fromMock = vi.fn().mockReturnValue({ where: whereSelectMock });
const whereUpdateMock = vi.fn().mockResolvedValue(undefined);
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
const { gatewayRouter } = await import("./payments");

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
});
