import { ConsoleChannel } from "./console";
import { TermiiChannel } from "./termii";
import { FcmChannel, WebPushChannel } from "./push";
import { EmailChannel } from "./email";
import type { ChannelKind, NotificationChannel } from "./types";

/**
 * Single source of truth for channel adapter selection. Real provider when
 * env keys exist, otherwise console adapter so dev still exercises the
 * full enqueue → drain → delivered pipeline.
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
    this.sms = termiiSms.isConfigured() ? termiiSms : new ConsoleChannel("sms");
    this.whatsapp = termiiWa.isConfigured() ? termiiWa : new ConsoleChannel("whatsapp");
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
