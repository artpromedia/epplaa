import { logger } from "../logger";
import type { ChannelKind, NotificationChannel, NotificationMessage, SendResult } from "./types";

/**
 * Africa's Talking SMS adapter — secondary SMS gateway for failover when
 * the primary (Termii) returns errors or times out. Coverage: NG, KE, ZA,
 * GH, UG, TZ, MW, RW, CI, CM, SN — i.e. the bulk of Epplaa's 16 markets.
 *
 * Configured via env:
 *   AFRICASTALKING_USERNAME
 *   AFRICASTALKING_API_KEY
 *   AFRICASTALKING_SENDER_ID (optional; defaults to "EPPLAA")
 *
 * When unconfigured, isConfigured() returns false and the registry will
 * skip this provider in the failover chain. This means setting only the
 * primary keys remains a valid prod configuration; adding the AT keys
 * activates failover automatically without code changes.
 */
export class AfricasTalkingSmsChannel implements NotificationChannel {
  readonly kind: ChannelKind = "sms";

  isConfigured(): boolean {
    return Boolean(process.env.AFRICASTALKING_USERNAME && process.env.AFRICASTALKING_API_KEY);
  }

  async send(msg: NotificationMessage): Promise<SendResult> {
    if (!this.isConfigured()) {
      // Defensive: registry filters by isConfigured() before composing the
      // FailoverChannel, but if called directly we treat it as a hard fail
      // so the outbox does not record a false success.
      return { ok: false, errorCode: "not_configured", errorMessage: "africastalking not configured" };
    }
    const username = process.env.AFRICASTALKING_USERNAME!;
    const apiKey = process.env.AFRICASTALKING_API_KEY!;
    const from = process.env.AFRICASTALKING_SENDER_ID || "EPPLAA";
    const sandbox = username === "sandbox";
    const url = sandbox
      ? "https://api.sandbox.africastalking.com/version1/messaging"
      : "https://api.africastalking.com/version1/messaging";
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
          apiKey,
        },
        body: new URLSearchParams({
          username,
          to: msg.to,
          message: `${msg.title}\n${msg.body}`.trim(),
          from,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        SMSMessageData?: { Recipients?: { status?: string; statusCode?: number; messageId?: string }[] };
      };
      const recipient = data.SMSMessageData?.Recipients?.[0];
      // AT returns 100..103 for success codes per their docs (101=Success,
      // 102=Sent, 100=Processed). Anything else is a failure.
      const code = recipient?.statusCode ?? 0;
      if (res.ok && code >= 100 && code < 104) {
        return { ok: true, providerMessageId: recipient?.messageId };
      }
      logger.warn(
        { code, status: recipient?.status, httpStatus: res.status },
        "africastalking_send_failed",
      );
      return {
        ok: false,
        errorCode: String(code || res.status),
        errorMessage: recipient?.status ?? `http ${res.status}`,
      };
    } catch (err) {
      return { ok: false, errorCode: "exception", errorMessage: (err as Error).message };
    }
  }
}
