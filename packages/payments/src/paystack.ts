import { createHmac, timingSafeEqual } from "node:crypto";
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

const PAYSTACK_BASE = "https://api.paystack.co";

/**
 * Real Paystack adapter. Uses PAYSTACK_SECRET_KEY for API auth and HMAC SHA512
 * with the same key for webhook signature verification (per Paystack docs).
 *
 * Currency note: Paystack expects amounts in the smallest currency unit
 * (kobo/pesewa) which already matches our internal "amountMinor" representation.
 */
export class PaystackGateway implements PaymentGateway {
  readonly name = "paystack" as const;
  private secretKey: string;

  constructor(secretKey: string | undefined) {
    this.secretKey = secretKey ?? "";
  }

  isConfigured(): boolean {
    return this.secretKey.length > 0;
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${PAYSTACK_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json()) as Record<string, unknown> & { status?: boolean; message?: string };
    if (!res.ok || json.status === false) {
      const err = new Error(`paystack_error: ${String(json.message ?? res.statusText)}`);
      (err as Error & { raw?: unknown }).raw = json;
      throw err;
    }
    return json as unknown as T;
  }

  async charge(req: ChargeRequest): Promise<ChargeResult> {
    const payload: Record<string, unknown> = {
      amount: req.amountMinor,
      email: req.email,
      currency: req.currencyCode,
      reference: req.reference,
      callback_url: req.callbackUrl,
      metadata: { ...(req.metadata ?? {}), intent_id: req.intentId, purpose: req.purpose },
    };
    if (req.subaccountCode) {
      payload.subaccount = req.subaccountCode;
      payload.bearer = "subaccount";
      if (typeof req.platformShareBp === "number") {
        // Paystack expects flat platform amount in subunit when using "subaccount".
        // We compute platform share = platformShareBp / 10000 of total.
        payload.transaction_charge = Math.round((req.amountMinor * req.platformShareBp) / 10000);
      }
    }
    try {
      const resp = await this.request<{
        data: { authorization_url: string; access_code: string; reference: string };
      }>("POST", "/transaction/initialize", payload);
      return {
        ok: true,
        authorizationUrl: resp.data.authorization_url,
        accessCode: resp.data.access_code,
        reference: resp.data.reference,
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
          status: string;
          reference: string;
          amount: number;
          currency: string;
          channel?: string;
          paid_at?: string;
        };
      }>("GET", `/transaction/verify/${encodeURIComponent(reference)}`);
      const status = mapPaystackStatus(resp.data.status);
      return {
        ok: status === "success",
        status,
        reference: resp.data.reference,
        amountMinor: resp.data.amount,
        currencyCode: resp.data.currency,
        channel: resp.data.channel,
        paidAt: resp.data.paid_at ? new Date(resp.data.paid_at) : undefined,
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
      const payload: Record<string, unknown> = { transaction: req.reference };
      if (req.amountMinor) payload.amount = req.amountMinor;
      if (req.reason) payload.merchant_note = req.reason;
      const resp = await this.request<{ data: { id: number; status: string } }>(
        "POST",
        "/refund",
        payload,
      );
      return {
        ok: true,
        refundReference: String(resp.data.id),
        status: resp.data.status === "processed" ? "processed" : "pending",
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
      // 1) Create or fetch transfer recipient.
      const recipient = await this.request<{ data: { recipient_code: string } }>(
        "POST",
        "/transferrecipient",
        {
          type: "nuban",
          name: req.accountName,
          account_number: req.accountNumber,
          bank_code: req.bankCode,
          currency: req.currencyCode,
        },
      );
      // 2) Initiate transfer.
      const transfer = await this.request<{ data: { transfer_code: string; status: string } }>(
        "POST",
        "/transfer",
        {
          source: "balance",
          amount: req.amountMinor,
          recipient: recipient.data.recipient_code,
          reason: req.reason ?? "Epplaa seller payout",
          reference: req.reference,
        },
      );
      return {
        ok: true,
        transferReference: transfer.data.transfer_code,
        status: transfer.data.status === "success" ? "processed" : "pending",
        raw: transfer,
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

  /**
   * Paystack signs every webhook body with HMAC SHA512 of the raw body using
   * the merchant secret key. The signature is the `x-paystack-signature` header.
   */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): WebhookVerifyResult {
    const sig = headers["x-paystack-signature"] ?? headers["X-Paystack-Signature"];
    if (!this.secretKey || !sig) {
      return {
        ok: false,
        eventId: "",
        eventType: "",
        reference: null,
        status: "unknown",
        raw: null,
      };
    }
    const expected = createHmac("sha512", this.secretKey).update(rawBody).digest("hex");
    const a = Buffer.from(expected, "utf8");
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
    let parsed: { event?: string; data?: { id?: number | string; reference?: string; status?: string; amount?: number; currency?: string } } = {};
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
    return {
      ok: true,
      // Paystack does not send a unique webhook id; combine event + data id + ref for dedupe.
      eventId: `paystack:${parsed.event ?? "unknown"}:${parsed.data?.id ?? ""}:${parsed.data?.reference ?? ""}`,
      eventType: parsed.event ?? "unknown",
      reference: parsed.data?.reference ?? null,
      status: normalizeWebhookStatus(mapPaystackStatus(parsed.data?.status ?? "")),
      amountMinor: parsed.data?.amount,
      currencyCode: parsed.data?.currency,
      raw: parsed,
    };
  }

  async listSettlements(fromIso: string, toIso: string): Promise<SettlementRow[]> {
    if (!this.isConfigured()) return [];
    try {
      const params = new URLSearchParams({ from: fromIso, to: toIso, perPage: "100" });
      const resp = await this.request<{
        data: Array<{
          reference: string;
          amount: number;
          currency: string;
          status: string;
          paid_at?: string;
        }>;
      }>("GET", `/transaction?${params.toString()}`);
      return (resp.data ?? []).map((t) => ({
        reference: t.reference,
        amountMinor: t.amount,
        currencyCode: t.currency,
        status: mapPaystackStatus(t.status) as "success" | "failed" | "pending",
        paidAt: t.paid_at ? new Date(t.paid_at) : undefined,
      }));
    } catch {
      return [];
    }
  }
}

function mapPaystackStatus(s: string): "success" | "failed" | "abandoned" | "pending" {
  if (s === "success") return "success";
  if (s === "failed") return "failed";
  if (s === "abandoned") return "abandoned";
  return "pending";
}

function normalizeWebhookStatus(
  s: "success" | "failed" | "abandoned" | "pending",
): "success" | "failed" | "pending" | "unknown" {
  if (s === "abandoned") return "failed";
  return s;
}
