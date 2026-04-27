import { logger } from "../logger";
import type { ChannelKind, NotificationChannel, NotificationMessage, SendResult } from "./types";

/**
 * Dev / fallback adapter that just logs. Used whenever the real provider
 * (Termii, FCM, Web Push) has no credentials configured. Returning ok=true
 * lets the rest of the pipeline (outbox -> delivered) be exercised end to
 * end without external services.
 */
export class ConsoleChannel implements NotificationChannel {
  constructor(public readonly kind: ChannelKind) {}
  isConfigured(): boolean {
    return true;
  }
  async send(msg: NotificationMessage): Promise<SendResult> {
    logger.info(
      { kind: this.kind, to: msg.to, title: msg.title, body: msg.body, url: msg.url },
      "notification_console_send",
    );
    return { ok: true, providerMessageId: `console_${Date.now()}` };
  }
}
