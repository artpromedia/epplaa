/**
 * Shared adapter-side helper that decides whether a notification
 * should be rendered with the branded "security alert" template
 * variant, and composes the variant-specific inputs (meta lines,
 * signature, support contact, CTA label) from the outbox payload.
 *
 * Lives next to the email adapters because both Postmark and
 * SendGrid need the exact same decision tree — pulling it into one
 * place means a future MFA event (or a new security email such as
 * "MFA was just disabled" or "new device signed in") can opt in by
 * editing one map instead of two adapters.
 *
 * Pure function — no env reads, no I/O. Adapters pass in
 * `linkBaseUrl` and the resolved support address so unit tests stay
 * deterministic.
 */

import type { EmailMetaLine } from "./emailTemplate";
import type { EventType, NotificationMessage } from "./types";

export interface SecurityEmailDecision {
  /**
   * `true` when the message should render with the security-flavoured
   * template; `false` for the default transactional shell. Adapters
   * still call `renderEpplaaEmail` either way — only the variant +
   * extra fields change.
   */
  isSecurity: boolean;
  /** CTA button label appropriate to the event. */
  ctaLabel: string;
  /** Forensic key/value lines to render in the security meta-table. */
  metaLines: EmailMetaLine[];
  /** Sign-off line shown beneath the CTA on the security variant. */
  signature: string;
}

/**
 * Event types that warrant the "Security alert" branded template.
 * Adding a new type here is the single change a future security
 * notification needs in order to render with the same chrome.
 */
const SECURITY_EVENT_TYPES = new Set<EventType>([
  "mfa_activated",
  "mfa_backup_codes_regenerated",
]);

/**
 * Per-event-type CTA label. Falls through to a generic "Review your
 * security settings" for any future security event we add to
 * SECURITY_EVENT_TYPES without an explicit override. The MFA
 * backup-codes nudge (`mfa_backup_codes_low`) intentionally keeps
 * the existing "Manage backup codes" label by going through the
 * url-suffix fallback in the adapter.
 */
const SECURITY_CTA_LABELS: Partial<Record<EventType, string>> = {
  mfa_activated: "Review your security settings",
  mfa_backup_codes_regenerated: "Review your security settings",
};

/**
 * Inspect a NotificationMessage and return the security-template
 * inputs the adapter should pass to `renderEpplaaEmail`. When the
 * event type is not a security event, returns `isSecurity: false`
 * with empty meta lines so the adapter can fall back to its
 * default-variant rendering.
 */
export function decideSecurityEmail(
  msg: NotificationMessage,
): SecurityEmailDecision {
  const eventType = msg.eventType;
  const isSecurity =
    eventType !== undefined && SECURITY_EVENT_TYPES.has(eventType);
  if (!isSecurity || eventType === undefined) {
    return { isSecurity: false, ctaLabel: "", metaLines: [], signature: "" };
  }

  const payload = msg.payload ?? {};
  const metaLines: EmailMetaLine[] = [];

  // Forensic context — populated by the route layer for
  // mfa_backup_codes_regenerated, omitted (for now) for mfa_activated.
  // We deliberately format the timestamp here rather than echoing the
  // raw ISO string the route already stuffed into the prose body —
  // the meta-table is the canonical place to surface it.
  const occurredAtRaw = payload.occurredAt;
  if (typeof occurredAtRaw === "string" && occurredAtRaw.length > 0) {
    metaLines.push({ label: "When", value: formatOccurredAt(occurredAtRaw) });
  }
  const ipAddress = payload.ipAddress;
  if (typeof ipAddress === "string" && ipAddress.length > 0) {
    metaLines.push({ label: "IP", value: ipAddress });
  }
  const userAgent = payload.userAgent;
  if (typeof userAgent === "string" && userAgent.length > 0) {
    metaLines.push({ label: "Device", value: userAgent });
  }

  return {
    isSecurity: true,
    ctaLabel:
      SECURITY_CTA_LABELS[eventType] ?? "Review your security settings",
    metaLines,
    signature: "— The Epplaa Security Team",
  };
}

/**
 * Best-effort timestamp prettifier. Falls back to the raw value if it
 * doesn't parse — we'd rather render the original ISO string than
 * crash the email send because a payload contained an unexpected
 * format. UTC suffix is appended explicitly so a recipient reading
 * the email from a different timezone is never confused about which
 * clock the event was logged in.
 */
function formatOccurredAt(raw: string): string {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  // Format: "2026-04-29 14:32:10 UTC" — short, unambiguous, locale-free.
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  const mm = pad(d.getUTCMonth() + 1);
  const dd = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const mi = pad(d.getUTCMinutes());
  const ss = pad(d.getUTCSeconds());
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss} UTC`;
}
