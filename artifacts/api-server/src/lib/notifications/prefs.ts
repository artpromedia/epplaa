import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import type { ChannelKind, EventType } from "./types";

/**
 * Default per-event channel set when the user has not customised prefs.
 * OTP MUST always go to the requested channel — the outbox bypasses pref
 * resolution for `otp_code` since the user explicitly chose sms/whatsapp.
 */
const EVENT_CHANNEL_DEFAULTS: Record<EventType, ChannelKind[]> = {
  otp_code: [],
  order_placed: ["whatsapp", "push", "email"],
  order_paid: ["whatsapp", "push"],
  order_payment_failed: ["whatsapp", "push", "email"],
  order_dispatched: ["whatsapp", "push"],
  order_ready_for_pickup: ["whatsapp", "sms", "push"],
  order_delivered: ["whatsapp", "push"],
  order_refunded: ["whatsapp", "push", "email"],
  seller_went_live: ["push"],
  promo: ["push"],
  referral_payout: ["push", "whatsapp"],
  wallet_credit: ["push", "whatsapp"],
  low_stock: ["push", "email"],
  box_reservation_expired: ["whatsapp", "sms", "push"],
  // Security nudge — email only. The whole point of this event is to
  // reach a seller who hasn't opened the app in months, so transient
  // channels (push/whatsapp) aren't the right delivery surface.
  mfa_backup_codes_low: ["email"],
  // Security confirmations — email only. These are paper-trail style
  // notifications a seller can search their inbox for after the fact
  // ("when did I turn on MFA?", "did I really regenerate codes on
  // April 3rd?"). Push/SMS would be intrusive for a routine confirm
  // and wouldn't survive a phone replacement.
  mfa_activated: ["email"],
  // Security alert — fired when a fresh sheet of backup codes is
  // minted. Email-only so it acts as an out-of-band tripwire that an
  // attacker controlling the in-app session/push surface cannot
  // suppress, and so the alert lands in the user's inbox where it can
  // be reviewed weeks later if needed.
  mfa_backup_codes_regenerated: ["email"],
  // Trust & Safety: due-process notifications. Push for in-app
  // immediacy, email for the audit trail the seller / reporter can
  // search later (e.g. "when was my listing removed?", "what reason
  // code did the moderator give?"). Never SMS — these messages contain
  // structured reason codes + appeal URLs that don't render well in 160
  // chars.
  content_takedown: ["push", "email"],
  safety_report_decided: ["push", "email"],
};

/**
 * Map event type → which top-level pref toggle gates it. Events with `null`
 * (OTP) always send.
 */
const EVENT_CATEGORY: Record<EventType, "orderUpdates" | "liveDrops" | "promos" | "referrals" | "walletCredits" | "marketing" | null> = {
  otp_code: null,
  order_placed: "orderUpdates",
  order_paid: "orderUpdates",
  order_payment_failed: "orderUpdates",
  order_dispatched: "orderUpdates",
  order_ready_for_pickup: "orderUpdates",
  order_delivered: "orderUpdates",
  order_refunded: "orderUpdates",
  seller_went_live: "liveDrops",
  promo: "promos",
  referral_payout: "referrals",
  wallet_credit: "walletCredits",
  low_stock: "orderUpdates",
  box_reservation_expired: "orderUpdates",
  // Security: never gated by user preference categories — if you have
  // MFA enabled, you get told when your backup codes run out.
  mfa_backup_codes_low: null,
  // Security confirmations: also ungated. A seller who has muted every
  // marketing category still needs the audit trail when their account
  // gains or rotates a second factor — that's the whole point of
  // sending the email.
  mfa_activated: null,
  // Security: a backup-code regeneration is the user's tripwire for a
  // silent takeover, so it must reach them regardless of which
  // marketing categories they've muted.
  mfa_backup_codes_regenerated: null,
  // Trust & Safety due-process notifications: never gated by category
  // toggles. Telling a seller their content was removed (and how to
  // appeal) is a regulatory requirement under EU/UK transparency
  // rules, and confirming a report decision back to the original
  // reporter is core buyer protection. Both must reach the user even
  // if they've muted every marketing category.
  content_takedown: null,
  safety_report_decided: null,
};

const COUNTRY_TZ: Record<string, string> = {
  NG: "Africa/Lagos",
  ZA: "Africa/Johannesburg",
  KE: "Africa/Nairobi",
  GH: "Africa/Accra",
  EG: "Africa/Cairo",
  MA: "Africa/Casablanca",
  CI: "Africa/Abidjan",
  SN: "Africa/Dakar",
  ET: "Africa/Addis_Ababa",
  TZ: "Africa/Dar_es_Salaam",
  UG: "Africa/Kampala",
  RW: "Africa/Kigali",
  CM: "Africa/Douala",
  DZ: "Africa/Algiers",
  TN: "Africa/Tunis",
  ZM: "Africa/Lusaka",
};

export interface ResolvedPrefs {
  channels: ChannelKind[];
  inQuietHours: boolean;
  whatsappNumber: string;
  smsNumber: string;
}

function localMinutesNow(tz: string): number | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
    const parts = fmt.formatToParts(new Date());
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    return h * 60 + m;
  } catch {
    return null;
  }
}

function inQuietWindow(nowMin: number, startMin: number, endMin: number): boolean {
  // Allow wrap-around (e.g. 22:00–07:00).
  if (startMin === endMin) return false;
  if (startMin < endMin) return nowMin >= startMin && nowMin < endMin;
  return nowMin >= startMin || nowMin < endMin;
}

/**
 * Compute the channels we should fan out to for `eventType`, taking into
 * account the user's prefs and quiet hours. OTP bypasses all of this.
 */
export async function resolveChannelsForEvent(
  userId: string,
  eventType: EventType,
): Promise<ResolvedPrefs> {
  const [prefs] = await db
    .select()
    .from(schema.notificationPrefsTable)
    .where(eq(schema.notificationPrefsTable.userId, userId))
    .limit(1);
  const [user] = await db
    .select({ phone: schema.usersTable.phone, countryCode: schema.usersTable.countryCode })
    .from(schema.usersTable)
    .where(eq(schema.usersTable.clerkId, userId))
    .limit(1);
  const phoneFromUser = user?.phone ?? "";
  const whatsappNumber = (prefs?.whatsappNumber || phoneFromUser || "").trim();
  const smsNumber = (prefs?.smsNumber || phoneFromUser || "").trim();

  // Category gating — if the user disabled the category, send nothing.
  const category = EVENT_CATEGORY[eventType];
  if (category && prefs && prefs[category] === false) {
    return { channels: [], inQuietHours: false, whatsappNumber, smsNumber };
  }

  // Channel toggles.
  const wantSms = prefs ? prefs.sms : false;
  const wantWa = prefs ? prefs.whatsapp : true;
  const wantPush = prefs ? prefs.push : true;
  const wantEmail = prefs ? prefs.email : true;
  const allowed: ChannelKind[] = [];
  for (const c of EVENT_CHANNEL_DEFAULTS[eventType]) {
    if (c === "sms" && wantSms && smsNumber) allowed.push(c);
    else if (c === "whatsapp" && wantWa && whatsappNumber) allowed.push(c);
    else if (c === "push" && wantPush) allowed.push(c);
    else if (c === "email" && wantEmail) allowed.push(c);
  }

  // Quiet hours suppress non-urgent classes (`promo`, `seller_went_live`,
  // `low_stock`). Order/payment/refund updates are considered urgent.
  let inQuietHours = false;
  const tz = (prefs?.timezone || COUNTRY_TZ[user?.countryCode ?? "NG"] || "UTC").trim() || "UTC";
  if (
    prefs?.quietHoursEnabled &&
    typeof prefs.quietHoursStartMinutes === "number" &&
    typeof prefs.quietHoursEndMinutes === "number"
  ) {
    const nowMin = localMinutesNow(tz);
    if (nowMin !== null && inQuietWindow(nowMin, prefs.quietHoursStartMinutes, prefs.quietHoursEndMinutes)) {
      inQuietHours = true;
    }
  }
  const NON_URGENT: EventType[] = ["promo", "seller_went_live", "low_stock"];
  if (inQuietHours && NON_URGENT.includes(eventType)) {
    return { channels: [], inQuietHours, whatsappNumber, smsNumber };
  }

  return { channels: allowed, inQuietHours, whatsappNumber, smsNumber };
}
