export type GatewayName = "paystack" | "flutterwave" | "devmock";

export type IntentPurpose = "order" | "wallet_topup";

export interface ChargeRequest {
  intentId: string;
  amountMinor: number;
  currencyCode: string;
  email: string;
  reference: string;
  callbackUrl: string;
  purpose: IntentPurpose;
  metadata?: Record<string, unknown>;
  /** Optional Paystack subaccount split / Flutterwave subaccount id. */
  subaccountCode?: string;
  /** Platform commission share (basis points of total) when subaccount is set. */
  platformShareBp?: number;
}

export interface ChargeResult {
  ok: boolean;
  authorizationUrl?: string;
  accessCode?: string;
  reference: string;
  rawResponse?: unknown;
  errorCode?: string;
  errorMessage?: string;
}

export interface VerifyResult {
  ok: boolean;
  status: "success" | "failed" | "abandoned" | "pending";
  reference: string;
  amountMinor?: number;
  currencyCode?: string;
  channel?: string;
  paidAt?: Date;
  raw?: unknown;
  errorMessage?: string;
}

export interface RefundRequest {
  reference: string;
  amountMinor?: number;
  reason?: string;
}

export interface RefundResult {
  ok: boolean;
  refundReference: string;
  status: "processed" | "pending" | "failed";
  raw?: unknown;
  errorMessage?: string;
}

export interface PayoutRequest {
  reference: string;
  amountMinor: number;
  currencyCode: string;
  bankCode: string;
  accountNumber: string;
  accountName: string;
  reason?: string;
}

export interface PayoutResult {
  ok: boolean;
  transferReference: string;
  status: "processed" | "pending" | "failed";
  raw?: unknown;
  errorMessage?: string;
}

export interface WebhookVerifyResult {
  ok: boolean;
  eventId: string;
  eventType: string;
  reference: string | null;
  status: "success" | "failed" | "pending" | "unknown";
  amountMinor?: number;
  currencyCode?: string;
  raw: unknown;
}

export interface SettlementRow {
  reference: string;
  amountMinor: number;
  currencyCode: string;
  status: "success" | "failed" | "pending";
  paidAt?: Date;
  raw?: unknown;
}

export interface PaymentGateway {
  readonly name: GatewayName;
  isConfigured(): boolean;
  charge(req: ChargeRequest): Promise<ChargeResult>;
  verify(reference: string): Promise<VerifyResult>;
  refund(req: RefundRequest): Promise<RefundResult>;
  payout(req: PayoutRequest): Promise<PayoutResult>;
  /** Verify the raw webhook body and signature, returning the parsed event. */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): WebhookVerifyResult;
  /** Pull a list of settled transactions for the given window. Used by reconciliation. */
  listSettlements(fromIso: string, toIso: string): Promise<SettlementRow[]>;
}
