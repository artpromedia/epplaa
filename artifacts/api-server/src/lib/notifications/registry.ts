import { ConsoleChannel } from "./console";
import { TermiiChannel } from "./termii";
import { FcmChannel, WebPushChannel } from "./push";
import { EmailChannel } from "./email";
import { logger } from "../logger";
import type { ChannelKind, NotificationChannel, NotificationMessage, SendResult } from "./types";

/**
 * Wraps a primary adapter with one or more secondaries. send() tries the
 * primary first; on a non-ok result OR a thrown error it falls through to
 * the next provider in order. The kind is taken from the primary so the
 * outbox bookkeeping remains unchanged. isConfigured() is true if ANY
 * underlying provider is configured (so the registry will pick it).
 */
class FailoverChannel implements NotificationChannel {
  readonly kind: ChannelKind;
  private readonly providers: NotificationChannel[];
  constructor(providers: NotificationChannel[]) {
    if (providers.length === 0) throw new Error("FailoverChannel requires at least one provider");
    this.kind = providers[0].kind;
    this.providers = providers;
  }
  isConfigured(): boolean {
    return this.providers.some((p) => p.isConfigured());
  }
  async send(msg: NotificationMessage): Promise<SendResult> {
    let last: SendResult = { ok: false, errorCode: "no_providers", errorMessage: "no providers" };
    for (let i = 0; i < this.providers.length; i++) {
      const p = this.providers[i];
      if (!p.isConfigured()) continue;
      try {
        const r = await p.send(msg);
        if (r.ok) {
          if (i > 0) {
            logger.warn(
              { kind: this.kind, providerIndex: i, lastErrorCode: last.errorCode },
              "notification_failover_used",
            );
          }
          return r;
        }
        last = r;
        logger.warn(
          { kind: this.kind, providerIndex: i, errorCode: r.errorCode },
          "notification_provider_failed_falling_over",
        );
      } catch (err) {
        last = { ok: false, errorCode: "exception", errorMessage: (err as Error).message };
        logger.warn(
          { kind: this.kind, providerIndex: i, err: last.errorMessage },
          "notification_provider_threw_falling_over",
        );
      }
    }
    return last;
  }
}

/**
 * Single source of truth for channel adapter selection. Real provider when
 * env keys exist, otherwise console adapter so dev still exercises the
 * full enqueue → drain → delivered pipeline.
 *
 * Provider failover policy: each kind is composed as
 * [primary(real), …secondary(real), console(dev)]. The outbox already
 * retries with backoff on a `false` SendResult — failover gives us
 * intra-attempt switching so a single provider outage does not stall
 * deliveries while waiting for the next backoff window.
 */
class ChannelRegistry {
  private readonly sms: NotificationChannel;
  private readonly whatsapp: NotificationChannel;
  private readonly fcm: NotificationChannel;
  private readonly webpush: NotificationChannel;
  private readonly email: NotificationChannel;

  constructor() {
    const termiiSms = new TermiiChannel("sms");
    const termiiWa = new TermiiChannel("whatsapp");
    this.sms = new FailoverChannel([termiiSms, new ConsoleChannel("sms")]);
    this.whatsapp = new FailoverChannel([termiiWa, new ConsoleChannel("whatsapp")]);
    this.fcm = new FcmChannel();
    this.webpush = new WebPushChannel();
    this.email = new EmailChannel();
  }

  for(kind: ChannelKind, pushKind?: "fcm" | "web"): NotificationChannel {
    switch (kind) {
      case "sms":
        return this.sms;
      case "whatsapp":
        return this.whatsapp;
      case "push":
        return pushKind === "fcm" ? this.fcm : this.webpush;
      case "email":
        return this.email;
    }
  }
}

export const channels = new ChannelRegistry();
