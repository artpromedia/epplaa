import { describe, it, expect, vi } from "vitest";

/**
 * Regression suite for the gateway-selection rule that the live-payments
 * pipeline depends on:
 *
 *   "When ANY real gateway secret is present, the router MUST NOT pick
 *    the dev-mock gateway for either the primary or the secondary slot."
 *
 * This rule was rebuilt three times during the original payments work
 * (see task-11.md). Each regression had the same shape: a small change
 * to env-handling or the selection helper let `devmock` slip into the
 * primary or secondary slot on a production deploy where Paystack or
 * Flutterwave WAS configured. The failure mode is silent — checkout
 * appears to succeed and order rows get created, but no real
 * authorization happens — so it does not surface until reconciliation
 * the next day. We pin the rule with a unit test so any future change
 * to `selectPrimaryAndSecondary` (the only function that can create
 * the bug) breaks here first.
 *
 * The module-level `paystack` / `flutterwave` instances in `payments.ts`
 * are constructed at import time from `process.env`, which makes them
 * awkward to flip per-test. To keep the test focused on the selection
 * logic itself rather than env juggling, we construct synthetic stub
 * gateways and pass them to the (now-injectable) helper. The mocks at
 * the top of the file exist solely to neutralize the heavy-weight
 * downstream module graph (db, notifications, fulfillment) that would
 * otherwise be pulled in by the import.
 */

const valuesMock = vi.fn().mockReturnValue({
  onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
  returning: vi.fn().mockResolvedValue([]),
});
const limitMock = vi.fn().mockResolvedValue([]);
const whereSelectMock = vi.fn().mockReturnValue({ limit: limitMock });
const fromMock = vi.fn().mockReturnValue({ where: whereSelectMock });
const setMock = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
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
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

vi.mock("./notifications", () => ({ enqueueNotification: vi.fn() }));
vi.mock("./fulfillment/dispatch", () => ({ dispatchShipmentForOrder: vi.fn() }));
vi.mock("./kyc", () => ({ requiredTierForOrder: () => 1 }));
vi.mock("./sanctions", () => ({
  sellerSanctionsBlocked: () => false,
  manufacturerSanctionsBlocked: () => false,
}));
vi.mock("./audit", () => ({ recordAudit: vi.fn() }));

import type {
  ChargeRequest,
  ChargeResult,
  GatewayName,
  PaymentGateway,
  PayoutRequest,
  PayoutResult,
  RefundRequest,
  RefundResult,
  SettlementRow,
  VerifyResult,
  WebhookVerifyResult,
} from "@workspace/payments";

const { selectPrimaryAndSecondary } = await import("./payments");

/**
 * Minimal gateway stub used to drive `selectPrimaryAndSecondary` without
 * touching any real gateway's constructor (which would observe
 * `process.env` and load HTTP clients we don't need here). Every method
 * other than `name` and `isConfigured()` throws — the selection helper
 * must never call them, and a thrown error in any non-isConfigured path
 * is itself a regression worth surfacing.
 */
class StubGateway implements PaymentGateway {
  constructor(
    public readonly name: GatewayName,
    private readonly configured: boolean,
  ) {}
  isConfigured(): boolean {
    return this.configured;
  }
  charge(_req: ChargeRequest): Promise<ChargeResult> {
    throw new Error(`${this.name}: charge() must not be called by selection logic`);
  }
  verify(_reference: string): Promise<VerifyResult> {
    throw new Error(`${this.name}: verify() must not be called by selection logic`);
  }
  refund(_req: RefundRequest): Promise<RefundResult> {
    throw new Error(`${this.name}: refund() must not be called by selection logic`);
  }
  payout(_req: PayoutRequest): Promise<PayoutResult> {
    throw new Error(`${this.name}: payout() must not be called by selection logic`);
  }
  verifyWebhook(_rawBody: Buffer, _headers: Record<string, string | undefined>): WebhookVerifyResult {
    throw new Error(`${this.name}: verifyWebhook() must not be called by selection logic`);
  }
  listSettlements(_fromIso: string, _toIso: string): Promise<SettlementRow[]> {
    throw new Error(`${this.name}: listSettlements() must not be called by selection logic`);
  }
}

describe("selectPrimaryAndSecondary — devmock containment regression", () => {
  // Three permutations cover every "any real key is configured" branch:
  // both real, paystack-only, flutterwave-only. The all-unconfigured
  // case (the only legal devmock branch) is asserted separately so a
  // refactor that accidentally swaps the branch order trips a test.
  const realKeyPermutations: Array<{
    label: string;
    paystack: boolean;
    flutterwave: boolean;
    expectedMode: "live" | "live-only-paystack" | "live-only-flutterwave";
    expectedPrimary: GatewayName;
    expectedSecondary: GatewayName;
  }> = [
    {
      label: "both Paystack AND Flutterwave configured",
      paystack: true,
      flutterwave: true,
      expectedMode: "live",
      expectedPrimary: "paystack",
      expectedSecondary: "flutterwave",
    },
    {
      label: "only Paystack configured",
      paystack: true,
      flutterwave: false,
      expectedMode: "live-only-paystack",
      expectedPrimary: "paystack",
      // No failover → secondary === primary so a primary failure surfaces
      // as a real error instead of silently routing to devmock.
      expectedSecondary: "paystack",
    },
    {
      label: "only Flutterwave configured",
      paystack: false,
      flutterwave: true,
      expectedMode: "live-only-flutterwave",
      expectedPrimary: "flutterwave",
      expectedSecondary: "flutterwave",
    },
  ];

  for (const p of realKeyPermutations) {
    it(`never selects devmock when ${p.label}`, () => {
      const paystack = new StubGateway("paystack", p.paystack);
      const flutterwave = new StubGateway("flutterwave", p.flutterwave);
      // The devmock stub is `isConfigured: true` to mirror the real
      // DevMockGateway (which always reports configured). The test is
      // proving that even a permanently-configured devmock is NOT
      // chosen when a real key exists.
      const devMock = new StubGateway("devmock", true);

      const sel = selectPrimaryAndSecondary(paystack, flutterwave, devMock);

      expect(sel.primary.name).not.toBe("devmock");
      expect(sel.secondary.name).not.toBe("devmock");
      expect(sel.primary.name).toBe(p.expectedPrimary);
      expect(sel.secondary.name).toBe(p.expectedSecondary);
      expect(sel.effectiveMode).toBe(p.expectedMode);
    });
  }

  it("falls through to devmock ONLY when neither real gateway is configured", () => {
    // Sanity-check the legal devmock branch so a future refactor that
    // makes the "any real key" branch never match can't masquerade as
    // a passing suite.
    const paystack = new StubGateway("paystack", false);
    const flutterwave = new StubGateway("flutterwave", false);
    const devMock = new StubGateway("devmock", true);

    const sel = selectPrimaryAndSecondary(paystack, flutterwave, devMock);
    expect(sel.primary.name).toBe("devmock");
    expect(sel.secondary.name).toBe("devmock");
    expect(sel.effectiveMode).toBe("dev-mock");
  });

  it("does not consult devMock.isConfigured() when a real gateway is present", () => {
    // A regression that consulted devmock first and short-circuited on
    // its always-true `isConfigured()` would still have routed to
    // devmock under the old code path. We assert the helper prefers
    // a real gateway BEFORE evaluating devmock by giving devmock a
    // spy that throws if called.
    const paystack = new StubGateway("paystack", true);
    const flutterwave = new StubGateway("flutterwave", false);
    const devMock = new StubGateway("devmock", true);
    const devMockSpy = vi.spyOn(devMock, "isConfigured");

    const sel = selectPrimaryAndSecondary(paystack, flutterwave, devMock);

    expect(sel.primary.name).toBe("paystack");
    expect(sel.secondary.name).toBe("paystack");
    // The devmock branch must not be reached when paystack is set;
    // calling isConfigured() on devmock would still be benign here,
    // but it would mean the implementation is doing unnecessary work
    // on the hot configuration path.
    expect(devMockSpy).not.toHaveBeenCalled();
  });
});
