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
  /**
   * Originating outbox event type. Optional so existing callers
   * (tests, ad-hoc sends) keep working, but the outbox always
   * populates it so adapters can pick a variant — e.g. the email
   * adapters render `mfa_activated` and `mfa_backup_codes_regenerated`
   * with the branded "security alert" template instead of the
   * default transactional shell.
   */
  eventType?: EventType;
}

export interface SendResult {
  ok: boolean;
  providerMessageId?: string;
  errorCode?: string;
  errorMessage?: string;
  /**
   * Identifies which underlying adapter produced this result. Set by
   * each adapter (e.g. `"postmark"`, `"sendgrid"`) so the outbox can
   * route provider-specific error codes through
   * `classifyEmailErrorForSuppression()` — Postmark `406` and SendGrid
   * `5xx` both mean "stop sending to this address" but they share no
   * vocabulary. Optional because legacy adapters and the console stub
   * do not need it.
   */
  provider?: string;
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
  | "mfa_backup_codes_regenerated"
  // Trust & Safety due-process notifications. `content_takedown` is sent to
  // the seller whose stream/listing/post was removed; `safety_report_decided`
  // is sent to the original reporter when their case is closed. Both are
  // ungated by marketing/category prefs (see prefs.ts).
  | "content_takedown"
  | "safety_report_decided";
