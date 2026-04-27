import { logger } from "../logger";
import type { ChannelKind, NotificationChannel, NotificationMessage, SendResult } from "./types";

const TERMII_BASE = "https://v3.api.termii.com";

/**
 * Termii adapter for SMS and WhatsApp. The same provider serves both so
 * we instantiate twice with different `channel` constructor args.
 *
 * Falls back to console-log behavior (ok=true) when the API key is absent
 * so dev environments do not blow up the outbox worker.
 */
export class TermiiChannel implements NotificationChannel {
  constructor(public readonly kind: Extract<ChannelKind, "sms" | "whatsapp">) {}

  isConfigured(): boolean {
    return Boolean(process.env.TERMII_API_KEY);
  }

  async send(msg: NotificationMessage): Promise<SendResult> {
    const apiKey = process.env.TERMII_API_KEY;
    const sender = process.env.TERMII_SENDER_ID || "Epplaa";
    if (!apiKey) {
      logger.info({ kind: this.kind, to: msg.to, title: msg.title }, "termii_dev_send");
      return { ok: true, providerMessageId: `termii_dev_${Date.now()}` };
    }
    const channel = this.kind === "whatsapp" ? "whatsapp" : "generic";
    const text = msg.title === msg.body ? msg.body : `${msg.title}\n${msg.body}`;
    try {
      const res = await fetch(`${TERMII_BASE}/api/sms/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          to: msg.to,
          from: sender,
          sms: text + (msg.url ? `\n${msg.url}` : ""),
          type: "plain",
          channel,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { message_id?: string; message?: string };
      if (!res.ok) {
        return { ok: false, errorCode: String(res.status), errorMessage: data.message ?? "termii_failed" };
      }
      return { ok: true, providerMessageId: data.message_id };
    } catch (err) {
      return { ok: false, errorMessage: (err as Error).message };
    }
  }
}
