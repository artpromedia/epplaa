/**
 * Channel-agnostic message representation. Adapters MAY ignore fields they
 * cannot render (e.g. a push notification has no `body` rich text but uses
 * `title`/`body` plain).
 */
export interface NotificationMessage {
  to: string;
  title: string;
  body: string;
  url?: string;
  payload?: Record<string, unknown>;
}

export interface SendResult {
  ok: boolean;
  providerMessageId?: string;
  errorCode?: string;
  errorMessage?: string;
}

export type ChannelKind = "sms" | "whatsapp" | "push" | "email";

export interface NotificationChannel {
  readonly kind: ChannelKind;
  isConfigured(): boolean;
  send(msg: NotificationMessage): Promise<SendResult>;
}

/**
 * Stable list of business event types. The outbox worker uses these to
 * resolve which prefs and channels apply.
 */
export type EventType =
  | "otp_code"
  | "order_placed"
  | "order_paid"
  | "order_payment_failed"
  | "order_dispatched"
  | "order_ready_for_pickup"
  | "order_delivered"
  | "order_refunded"
  | "seller_went_live"
  | "promo"
  | "referral_payout"
  | "wallet_credit"
  | "low_stock"
  | "box_reservation_expired"
  | "mfa_backup_codes_low"
  | "mfa_activated"
  | "mfa_backup_codes_regenerated";
