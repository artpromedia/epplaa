import { createHash, timingSafeEqual } from "node:crypto";
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

const FLW_BASE = "https://api.flutterwave.com/v3";

/**
 * Real Flutterwave adapter. Uses FLUTTERWAVE_SECRET_KEY for API auth and the
 * `verif-hash` header equality (configured in the Flutterwave dashboard) for
 * webhook verification.
 *
 * Currency note: Flutterwave's `/payments` endpoint expects the amount in the
 * MAJOR unit (e.g. NGN naira, not kobo). We convert from amountMinor using the
 * minorPerMajor passed in metadata; callers must include that.
 */
export class FlutterwaveGateway implements PaymentGateway {
  readonly name = "flutterwave" as const;
  private secretKey: string;
  private webhookHash: string;

  constructor(secretKey: string | undefined, webhookHash: string | undefined) {
    this.secretKey = secretKey ?? "";
    this.webhookHash = webhookHash ?? "";
  }

  isConfigured(): boolean {
    return this.secretKey.length > 0;
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${FLW_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json()) as Record<string, unknown> & { status?: string; message?: string };
    if (!res.ok || json.status === "error") {
      const err = new Error(`flutterwave_error: ${String(json.message ?? res.statusText)}`);
      (err as Error & { raw?: unknown }).raw = json;
      throw err;
    }
    return json as unknown as T;
  }

  async charge(req: ChargeRequest): Promise<ChargeResult> {
    const minorPerMajor = Number((req.metadata?.minorPerMajor as number | undefined) ?? 100);
    const amountMajor = req.amountMinor / minorPerMajor;
    const payload: Record<string, unknown> = {
      tx_ref: req.reference,
      amount: amountMajor,
      currency: req.currencyCode,
      redirect_url: req.callbackUrl,
      customer: { email: req.email },
      meta: { ...(req.metadata ?? {}), intent_id: req.intentId, purpose: req.purpose },
    };
    if (req.subaccountCode) {
      payload.subaccounts = [
        {
          id: req.subaccountCode,
          // Flutterwave splits by amount or percentage; here we keep it simple and let
          // the platform retain its share, the rest goes to the seller subaccount.
          transaction_charge_type: "flat",
          transaction_charge: req.platformShareBp
            ? Math.round((amountMajor * req.platformShareBp) / 10000)
            : 0,
        },
      ];
    }
    try {
      const resp = await this.request<{ data: { link: string } }>("POST", "/payments", payload);
      return {
        ok: true,
        authorizationUrl: resp.data.link,
        reference: req.reference,
        rawResponse: resp,
      };
    } catch (err) {
      const e = err as Error & { raw?: unknown };
      return {
        ok: false,
        reference: req.reference,
        rawResponse: e.raw,
        errorCode: "charge_failed",
        errorMessage: e.message,
      };
    }
  }

  async verify(reference: string): Promise<VerifyResult> {
    try {
      const resp = await this.request<{
        data: {
          tx_ref: string;
          status: string;
          amount: number;
          currency: string;
          payment_type?: string;
          created_at?: string;
        };
      }>("GET", `/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`);
      const status = mapFlutterwaveStatus(resp.data.status);
      // Convert back to minor units; assumes 100 minor per major (NGN, KES, GHS, ZAR).
      // XOF (CFA) is a 0-decimal currency — the route layer normalizes this.
      return {
        ok: status === "success",
        status,
        reference: resp.data.tx_ref,
        amountMinor: Math.round(resp.data.amount * 100),
        currencyCode: resp.data.currency,
        channel: resp.data.payment_type,
        paidAt: resp.data.created_at ? new Date(resp.data.created_at) : undefined,
        raw: resp,
      };
    } catch (err) {
      return {
        ok: false,
        status: "failed",
        reference,
        errorMessage: (err as Error).message,
      };
    }
  }

  async refund(req: RefundRequest): Promise<RefundResult> {
    try {
      // First fetch the transaction id by reference.
      const verify = await this.request<{ data: { id: number } }>(
        "GET",
        `/transactions/verify_by_reference?tx_ref=${encodeURIComponent(req.reference)}`,
      );
      const id = verify.data.id;
      const resp = await this.request<{ data: { id: number; status: string } }>(
        "POST",
        `/transactions/${id}/refund`,
        req.amountMinor ? { amount: req.amountMinor / 100 } : {},
      );
      return {
        ok: true,
        refundReference: String(resp.data.id),
        status: resp.data.status === "completed" ? "processed" : "pending",
        raw: resp,
      };
    } catch (err) {
      return {
        ok: false,
        refundReference: "",
        status: "failed",
        errorMessage: (err as Error).message,
      };
    }
  }

  async payout(req: PayoutRequest): Promise<PayoutResult> {
    try {
      const resp = await this.request<{ data: { id: number; status: string; reference: string } }>(
        "POST",
        "/transfers",
        {
          account_bank: req.bankCode,
          account_number: req.accountNumber,
          amount: req.amountMinor / 100,
          currency: req.currencyCode,
          reference: req.reference,
          narration: req.reason ?? "Epplaa payout",
        },
      );
      return {
        ok: true,
        transferReference: resp.data.reference ?? String(resp.data.id),
        status: resp.data.status === "SUCCESSFUL" ? "processed" : "pending",
        raw: resp,
      };
    } catch (err) {
      return {
        ok: false,
        transferReference: req.reference,
        status: "failed",
        errorMessage: (err as Error).message,
      };
    }
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): WebhookVerifyResult {
    const sig = headers["verif-hash"] ?? headers["Verif-Hash"];
    if (!this.webhookHash || !sig) {
      return {
        ok: false,
        eventId: "",
        eventType: "",
        reference: null,
        status: "unknown",
        raw: null,
      };
    }
    // Flutterwave sends the configured hash as a static value for comparison.
    const a = Buffer.from(this.webhookHash, "utf8");
    const b = Buffer.from(String(sig), "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return {
        ok: false,
        eventId: "",
        eventType: "",
        reference: null,
        status: "unknown",
        raw: null,
      };
    }
    let parsed: {
      event?: string;
      data?: {
        id?: number | string;
        tx_ref?: string;
        status?: string;
        amount?: number;
        currency?: string;
      };
    } = {};
    try {
      parsed = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return {
        ok: false,
        eventId: "",
        eventType: "",
        reference: null,
        status: "unknown",
        raw: null,
      };
    }
    // Use SHA256 of (event + data.id + tx_ref) as a stable dedupe key, plus
    // include data.id to guarantee uniqueness if the gateway replays.
    const dedupeBase = `flutterwave:${parsed.event ?? "unknown"}:${parsed.data?.id ?? ""}:${parsed.data?.tx_ref ?? ""}`;
    const eventId = createHash("sha256").update(dedupeBase).digest("hex");
    return {
      ok: true,
      eventId,
      eventType: parsed.event ?? "unknown",
      reference: parsed.data?.tx_ref ?? null,
      status: normalizeWebhookStatus(mapFlutterwaveStatus(parsed.data?.status ?? "")),
      amountMinor: parsed.data?.amount ? Math.round(parsed.data.amount * 100) : undefined,
      currencyCode: parsed.data?.currency,
      raw: parsed,
    };
  }

  async listSettlements(fromIso: string, toIso: string): Promise<SettlementRow[]> {
    if (!this.isConfigured()) return [];
    try {
      const params = new URLSearchParams({ from: fromIso, to: toIso });
      const resp = await this.request<{
        data: Array<{
          tx_ref: string;
          amount: number;
          currency: string;
          status: string;
          created_at?: string;
        }>;
      }>("GET", `/transactions?${params.toString()}`);
      return (resp.data ?? []).map((t) => ({
        reference: t.tx_ref,
        amountMinor: Math.round(t.amount * 100),
        currencyCode: t.currency,
        status: mapFlutterwaveStatus(t.status) as "success" | "failed" | "pending",
        paidAt: t.created_at ? new Date(t.created_at) : undefined,
      }));
    } catch {
      return [];
    }
  }
}

function mapFlutterwaveStatus(s: string): "success" | "failed" | "abandoned" | "pending" {
  const normalized = s.toLowerCase();
  if (normalized === "successful" || normalized === "success" || normalized === "completed") return "success";
  if (normalized === "failed" || normalized === "cancelled") return "failed";
  if (normalized === "abandoned") return "abandoned";
  return "pending";
}

function normalizeWebhookStatus(
  s: "success" | "failed" | "abandoned" | "pending",
): "success" | "failed" | "pending" | "unknown" {
  if (s === "abandoned") return "failed";
  return s;
}
