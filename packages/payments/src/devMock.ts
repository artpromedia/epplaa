import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  ChargeRequest,
  ChargeResult,
  PaymentGateway,
  PayoutRequest,
  PayoutResult,
  RefundRequest,
  RefundResult,
  SettlementRow,
  VerifyResult,
  WebhookVerifyResult,
} from "./types";

/**
 * Dev / sandbox fallback gateway used when no Paystack or Flutterwave keys are
 * configured. It auto-confirms charges so the rest of the system (intents,
 * webhooks, splits, payouts, reconciliation) can still be exercised end-to-end
 * without a live account.
 *
 * The hosted "checkout page" is served by the api-server itself at
 * `/api/__devpay/:reference` which immediately POSTs back to the webhook
 * endpoint. The signature is HMAC-style: `sha256(secret || rawBody)` where
 * the "secret" is a fixed dev string included in the bundle so verification
 * is exercised end-to-end.
 */
export const DEV_MOCK_SECRET = "epplaa-dev-mock-webhook-secret";

export class DevMockGateway implements PaymentGateway {
  readonly name = "devmock" as const;
  /**
   * In-memory ledger of mock charges so verify() works without a database.
   * Each entry is the raw charge request, keyed by reference.
   */
  private readonly mockLedger = new Map<
    string,
    { req: ChargeRequest; status: "pending" | "success"; createdAt: Date }
  >();

  isConfigured(): boolean {
    return true;
  }

  /** Allow the api-server to fetch a request by reference for the hosted page. */
  getCharge(reference: string) {
    return this.mockLedger.get(reference);
  }

  markSuccess(reference: string): void {
    const entry = this.mockLedger.get(reference);
    if (entry) entry.status = "success";
  }

  async charge(req: ChargeRequest): Promise<ChargeResult> {
    this.mockLedger.set(req.reference, { req, status: "pending", createdAt: new Date() });
    // Authorization URL points at the api-server's hosted dev pay page so the
    // user-facing redirect flow is identical to a real gateway.
    const url = `/api/__devpay/${encodeURIComponent(req.reference)}`;
    return { ok: true, authorizationUrl: url, reference: req.reference };
  }

  async verify(reference: string): Promise<VerifyResult> {
    const entry = this.mockLedger.get(reference);
    if (!entry) {
      return { ok: false, status: "failed", reference, errorMessage: "unknown_reference" };
    }
    return {
      ok: entry.status === "success",
      status: entry.status,
      reference,
      amountMinor: entry.req.amountMinor,
      currencyCode: entry.req.currencyCode,
      channel: "devmock",
      paidAt: entry.status === "success" ? new Date() : undefined,
    };
  }

  async refund(req: RefundRequest): Promise<RefundResult> {
    return {
      ok: true,
      refundReference: `mock_rf_${randomBytes(4).toString("hex")}`,
      status: "processed",
    };
  }

  async payout(req: PayoutRequest): Promise<PayoutResult> {
    return {
      ok: true,
      transferReference: `mock_tr_${randomBytes(4).toString("hex")}`,
      status: "processed",
    };
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): WebhookVerifyResult {
    const sig = headers["x-devmock-signature"];
    if (!sig) {
      return { ok: false, eventId: "", eventType: "", reference: null, status: "unknown", raw: null };
    }
    const expected = createHash("sha256").update(DEV_MOCK_SECRET).update(rawBody).digest("hex");
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(String(sig), "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, eventId: "", eventType: "", reference: null, status: "unknown", raw: null };
    }
    let parsed: { reference?: string; status?: string; amountMinor?: number; currencyCode?: string } = {};
    try {
      parsed = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return { ok: false, eventId: "", eventType: "", reference: null, status: "unknown", raw: null };
    }
    const eventId = createHash("sha256")
      .update(`devmock:${parsed.reference ?? ""}:${parsed.status ?? ""}`)
      .digest("hex");
    return {
      ok: true,
      eventId,
      eventType: "charge.completed",
      reference: parsed.reference ?? null,
      status: parsed.status === "success" ? "success" : "pending",
      amountMinor: parsed.amountMinor,
      currencyCode: parsed.currencyCode,
      raw: parsed,
    };
  }

  async listSettlements(_fromIso: string, _toIso: string): Promise<SettlementRow[]> {
    const out: SettlementRow[] = [];
    for (const entry of this.mockLedger.values()) {
      if (entry.status !== "success") continue;
      out.push({
        reference: entry.req.reference,
        amountMinor: entry.req.amountMinor,
        currencyCode: entry.req.currencyCode,
        status: "success",
        paidAt: entry.createdAt,
      });
    }
    return out;
  }

  /** Build the canonical signature for a body (used by the dev hosted page). */
  static signBody(rawBody: Buffer): string {
    return createHash("sha256").update(DEV_MOCK_SECRET).update(rawBody).digest("hex");
  }
}
