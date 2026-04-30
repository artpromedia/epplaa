import { logger } from "../logger";
import { renderEpplaaEmail } from "./emailTemplate";
import { decideSecurityEmail } from "./securityEmail";
import type { ChannelKind, NotificationChannel, NotificationMessage, SendResult } from "./types";

const POSTMARK_BASE = "https://api.postmarkapp.com";

/**
 * Postmark adapter — primary transactional email provider.
 *
 * Why Postmark first: it's purpose-built for transactional mail
 * (their pool is segregated from bulk senders so deliverability for
 * single-recipient security nudges like the MFA backup-codes email
 * is consistently better than a marketing-oriented provider). The
 * API is a single POST and the failure surface is small.
 *
 * Configured via env:
 *   POSTMARK_API_TOKEN     — server token from the Postmark dashboard
 *   EMAIL_FROM             — RFC 5322 mailbox; defaults to
 *                            "Epplaa <noreply@epplaa.com>"
 *   EMAIL_REPLY_TO         — optional Reply-To header
 *   EMAIL_LINK_BASE_URL    — absolute origin used to resolve relative
 *                            CTA URLs (e.g. `/account/security`).
 *                            Defaults to `https://epplaa.com`.
 *   POSTMARK_MESSAGE_STREAM — optional message stream ID; defaults
 *                            to "outbound" (Postmark's default
 *                            transactional stream).
 *
 * When unconfigured, isConfigured() returns false and the registry
 * skips this provider in the failover chain. If NO real email
 * provider is configured anywhere, the registry falls back to the
 * Console adapter (dev) — never to a silent no-op success.
 */
export class PostmarkEmailChannel implements NotificationChannel {
  readonly kind: ChannelKind = "email";

  isConfigured(): boolean {
    // EMAIL_FROM has a sensible default ("Epplaa <noreply@epplaa.com>")
    // so the token alone is enough to flip the adapter into real-send
    // mode. Operators who need a different From address set EMAIL_FROM
    // alongside the token.
    return Boolean(process.env.POSTMARK_API_TOKEN);
  }

  async send(msg: NotificationMessage): Promise<SendResult> {
    const token = process.env.POSTMARK_API_TOKEN;
    if (!token) {
      // Defensive: registry filters by isConfigured() before composing
      // the FailoverChannel, but if called directly we treat it as a
      // hard fail so the outbox does not record a false success.
      return { ok: false, errorCode: "not_configured", errorMessage: "postmark not configured" };
    }
    const from = process.env.EMAIL_FROM || "Epplaa <noreply@epplaa.com>";
    const replyTo = process.env.EMAIL_REPLY_TO;
    const linkBaseUrl = process.env.EMAIL_LINK_BASE_URL || "https://epplaa.com";
    const supportEmail = process.env.EMAIL_SUPPORT_ADDRESS || "support@epplaa.com";
    const messageStream = process.env.POSTMARK_MESSAGE_STREAM || "outbound";

    const security = decideSecurityEmail(msg);
    const rendered = renderEpplaaEmail({
      title: msg.title,
      body: msg.body,
      ctaUrl: msg.url ?? null,
      ctaLabel: security.isSecurity ? security.ctaLabel : pickCtaLabel(msg),
      linkBaseUrl,
      variant: security.isSecurity ? "security" : "default",
      metaLines: security.isSecurity ? security.metaLines : undefined,
      signature: security.isSecurity ? security.signature : undefined,
      supportEmail: security.isSecurity ? supportEmail : undefined,
    });

    try {
      const res = await fetch(`${POSTMARK_BASE}/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "X-Postmark-Server-Token": token,
        },
        body: JSON.stringify({
          From: from,
          To: msg.to,
          Subject: rendered.subject,
          HtmlBody: rendered.html,
          TextBody: rendered.text,
          MessageStream: messageStream,
          ...(replyTo ? { ReplyTo: replyTo } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        MessageID?: string;
        ErrorCode?: number;
        Message?: string;
      };
      if (!res.ok || (typeof data.ErrorCode === "number" && data.ErrorCode !== 0)) {
        const errorCode = data.ErrorCode != null ? String(data.ErrorCode) : String(res.status);
        logger.warn(
          { httpStatus: res.status, errorCode, message: data.Message },
          "postmark_send_failed",
        );
        return {
          ok: false,
          errorCode,
          errorMessage: data.Message ?? `http ${res.status}`,
          provider: "postmark",
        };
      }
      return { ok: true, providerMessageId: data.MessageID, provider: "postmark" };
    } catch (err) {
      return {
        ok: false,
        errorCode: "exception",
        errorMessage: (err as Error).message,
        provider: "postmark",
      };
    }
  }
}

/**
 * Pick a context-appropriate CTA label. The MFA backup-codes nudge
 * routes to `/account/security` and benefits from a more specific
 * label than the generic "Open Epplaa" — recipients are more likely
 * to click "Manage backup codes" than a brand-only button.
 */
function pickCtaLabel(msg: NotificationMessage): string {
  if (msg.url && msg.url.includes("/account/security")) {
    return "Manage backup codes";
  }
  return "Open Epplaa";
}
