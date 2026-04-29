import { logger } from "../logger";
import { renderEpplaaEmail } from "./emailTemplate";
import type { ChannelKind, NotificationChannel, NotificationMessage, SendResult } from "./types";

const SENDGRID_BASE = "https://api.sendgrid.com/v3";

/**
 * SendGrid adapter — secondary transactional email provider used as
 * the failover target when Postmark returns an error or is down.
 *
 * Composition: the registry chains [Postmark, SendGrid] inside a
 * `FailoverChannel` so a Postmark outage (or a deliverability-driven
 * temporary suspension) automatically rolls to SendGrid in the same
 * outbox attempt — without the operator having to flip a flag, and
 * without the outbox row falling back to the no-op stub that the
 * channel was BEFORE this adapter existed (which silently marked
 * rows delivered without anyone receiving the email).
 *
 * Configured via env:
 *   SENDGRID_API_KEY       — bearer token from the SendGrid dashboard
 *   EMAIL_FROM             — RFC 5322 mailbox; defaults to
 *                            "Epplaa <noreply@epplaa.com>" (shared
 *                            with Postmark so both providers send
 *                            from the same identity).
 *   EMAIL_REPLY_TO         — optional Reply-To header
 *   EMAIL_LINK_BASE_URL    — absolute origin used to resolve relative
 *                            CTA URLs. Defaults to https://epplaa.com.
 *
 * When unconfigured, isConfigured() returns false and the registry
 * skips this provider — a single-provider production deploy that
 * uses only Postmark remains a valid configuration.
 */
export class SendGridEmailChannel implements NotificationChannel {
  readonly kind: ChannelKind = "email";

  isConfigured(): boolean {
    return Boolean(process.env.SENDGRID_API_KEY);
  }

  async send(msg: NotificationMessage): Promise<SendResult> {
    const apiKey = process.env.SENDGRID_API_KEY;
    if (!apiKey) {
      return { ok: false, errorCode: "not_configured", errorMessage: "sendgrid not configured" };
    }
    const fromMailbox = process.env.EMAIL_FROM || "Epplaa <noreply@epplaa.com>";
    const replyTo = process.env.EMAIL_REPLY_TO;
    const linkBaseUrl = process.env.EMAIL_LINK_BASE_URL || "https://epplaa.com";

    const rendered = renderEpplaaEmail({
      title: msg.title,
      body: msg.body,
      ctaUrl: msg.url ?? null,
      ctaLabel: pickCtaLabel(msg),
      linkBaseUrl,
    });

    const fromParsed = parseMailbox(fromMailbox);
    if (!fromParsed) {
      return {
        ok: false,
        errorCode: "bad_from",
        errorMessage: `EMAIL_FROM is not a valid mailbox: ${fromMailbox}`,
        provider: "sendgrid",
      };
    }

    try {
      const res = await fetch(`${SENDGRID_BASE}/mail/send`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          personalizations: [
            {
              to: [{ email: msg.to }],
              subject: rendered.subject,
            },
          ],
          from: fromParsed,
          ...(replyTo ? { reply_to: parseMailbox(replyTo) ?? { email: replyTo } } : {}),
          content: [
            { type: "text/plain", value: rendered.text },
            { type: "text/html", value: rendered.html },
          ],
        }),
      });
      // SendGrid returns 202 Accepted with an empty body on success
      // and the message id in the X-Message-Id response header.
      if (res.status === 202 || (res.status >= 200 && res.status < 300)) {
        const providerMessageId = res.headers.get("x-message-id") ?? undefined;
        return { ok: true, providerMessageId, provider: "sendgrid" };
      }
      const data = (await res.json().catch(() => ({}))) as {
        errors?: { message?: string }[];
      };
      const message = data.errors?.[0]?.message ?? `http ${res.status}`;
      logger.warn(
        { httpStatus: res.status, errorCode: res.status, message },
        "sendgrid_send_failed",
      );
      return {
        ok: false,
        errorCode: String(res.status),
        errorMessage: message,
        provider: "sendgrid",
      };
    } catch (err) {
      return {
        ok: false,
        errorCode: "exception",
        errorMessage: (err as Error).message,
        provider: "sendgrid",
      };
    }
  }
}

/**
 * Parse `Display Name <addr@host>` (or a bare `addr@host`) into the
 * `{name?, email}` shape SendGrid wants. Returns null when the string
 * does not contain a usable email — the adapter then fails closed
 * rather than sending mail with a syntactically broken From header.
 *
 * Intentionally permissive: this is not a full RFC 5322 parser, it
 * just covers the two shapes operators write into EMAIL_FROM in
 * practice. SendGrid validates the From mailbox server-side so a
 * malformed address still gets caught in the API response.
 */
function parseMailbox(input: string): { name?: string; email: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const angleMatch = trimmed.match(/^\s*(.*?)\s*<\s*([^>\s]+@[^>\s]+)\s*>\s*$/);
  if (angleMatch) {
    const [, name, email] = angleMatch;
    return name && name.length > 0 ? { name, email } : { email };
  }
  if (/^[^\s@]+@[^\s@]+$/.test(trimmed)) {
    return { email: trimmed };
  }
  return null;
}

function pickCtaLabel(msg: NotificationMessage): string {
  if (msg.url && msg.url.includes("/account/security")) {
    return "Manage backup codes";
  }
  return "Open Epplaa";
}
