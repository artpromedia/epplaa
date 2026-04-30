import { ConsoleChannel } from "./console";
import { TermiiChannel } from "./termii";
import { AfricasTalkingSmsChannel } from "./africastalking";
import { FcmChannel, WebPushChannel } from "./push";
import { PostmarkEmailChannel } from "./postmark";
import { SendGridEmailChannel } from "./sendgrid";
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
 * Single source of truth for channel adapter selection.
 *
 * Production composition rule: chain ONLY real providers in the
 * FailoverChannel. Console is NEVER part of a failover chain — using
 * console as a fallback would mask real provider outages and falsely
 * mark outbox rows delivered. Console is only used when zero real
 * providers are configured (i.e. local dev), in which case it stands
 * alone so the enqueue → drain → delivered pipeline still completes.
 *
 * Failover semantics: when a real primary fails, the next real
 * secondary is tried in the same attempt. If ALL real providers fail,
 * the channel returns ok:false and the outbox owns retry/backoff —
 * which is the authoritative reliability layer.
 */
function buildChannel(kind: ChannelKind, providers: NotificationChannel[]): NotificationChannel {
  const real = providers.filter((p) => p.isConfigured());
  if (real.length === 0) {
    return new ConsoleChannel(kind);
  }
  if (real.length === 1) return real[0];
  return new FailoverChannel(real);
}

class ChannelRegistry {
  private readonly sms: NotificationChannel;
  private readonly whatsapp: NotificationChannel;
  private readonly fcm: NotificationChannel;
  private readonly webpush: NotificationChannel;
  private readonly email: NotificationChannel;

  constructor() {
    // Real providers in priority order. Termii is primary across all
    // 16 markets; Africa's Talking is the SMS secondary covering NG/KE/
    // ZA/GH/UG/TZ/MW/RW/CI/CM/SN. WhatsApp currently has only Termii;
    // a Twilio WA adapter can be appended here without caller changes.
    // buildChannel() filters out unconfigured providers and only wraps
    // in FailoverChannel when 2+ real providers are present.
    this.sms = buildChannel("sms", [new TermiiChannel("sms"), new AfricasTalkingSmsChannel()]);
    this.whatsapp = buildChannel("whatsapp", [new TermiiChannel("whatsapp")]);
    this.fcm = new FcmChannel();
    this.webpush = new WebPushChannel();
    // Email: Postmark is the primary transactional provider (purpose-
    // built segregated transactional pool — better deliverability for
    // single-recipient security nudges like the MFA backup-codes
    // email). SendGrid is the secondary so a Postmark outage rolls
    // over to a real provider, NOT to the no-op stub that this
    // channel used to default to (which silently marked outbox rows
    // delivered without anyone receiving the email — see task #72).
    // buildChannel() filters out unconfigured providers and only
    // wraps in FailoverChannel when 2+ real providers are present;
    // when zero are configured (local dev) it falls back to the
    // ConsoleChannel so the enqueue → drain → delivered pipeline
    // still completes without external services.
    this.email = buildChannel("email", [new PostmarkEmailChannel(), new SendGridEmailChannel()]);
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
