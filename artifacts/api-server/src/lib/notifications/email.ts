import { logger } from "../logger";
import type { ChannelKind, NotificationChannel, NotificationMessage, SendResult } from "./types";

/**
 * Placeholder email adapter. The task scopes "basic template only" — a real
 * SMTP/SendGrid integration is out of scope. We log and return ok so the
 * outbox marks the row delivered without breaking other channels.
 */
export class EmailChannel implements NotificationChannel {
  readonly kind: ChannelKind = "email";
  isConfigured(): boolean {
    return true;
  }
  async send(msg: NotificationMessage): Promise<SendResult> {
    logger.info({ to: msg.to, title: msg.title }, "email_noop_send");
    return { ok: true, providerMessageId: `email_noop_${Date.now()}` };
  }
}
