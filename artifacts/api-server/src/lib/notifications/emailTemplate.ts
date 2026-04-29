/**
 * Branded transactional email template for Epplaa notifications.
 *
 * Designed for the MFA backup-codes nudge (`mfa_backup_codes_low`) but
 * usable for any future transactional email that follows the same
 * shape: a short title, one paragraph of body copy, and a single
 * primary call-to-action button. Adapters call `renderEpplaaEmail` to
 * produce the {subject, html, text} they hand to Postmark / SendGrid.
 *
 * Why a hand-written template (vs MJML / react-email):
 * - Email clients are notoriously hostile to modern CSS. We use only
 *   the widely-supported subset (table layout, inline styles, web-safe
 *   fonts) so the rendering is consistent across Gmail/Outlook/Apple
 *   Mail/the dozen mobile clients we know our buyers use.
 * - Pulling in a dependency to render one template is overkill at the
 *   current scale and adds a transitive surface area for security
 *   advisories.
 *
 * Pure function — no env reads, no I/O. The link base URL is passed
 * in by the adapter so unit tests can pin it deterministically and so
 * the same template can be rendered from a worker process / job
 * runner that may not share env with the request context.
 */

export interface RenderEpplaaEmailArgs {
  /** Short headline shown as the email subject AND the H1. */
  title: string;
  /** One short paragraph of body copy under the headline. */
  body: string;
  /**
   * Optional CTA URL. May be relative (e.g. `/account/security`) — it
   * is resolved against `linkBaseUrl` so the resulting link is always
   * an absolute https:// URL when opened from an inbox. Pass `null`
   * to render the email without a button.
   */
  ctaUrl?: string | null;
  /** Button label. Defaults to "Open Epplaa". */
  ctaLabel?: string;
  /**
   * Absolute base URL used to resolve a relative `ctaUrl`. Adapters
   * derive this from env (`EMAIL_LINK_BASE_URL`) with a sensible
   * default so the template stays a pure function.
   */
  linkBaseUrl: string;
}

export interface RenderedEpplaaEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Conservative HTML escaper. We render user-controlled `title` /
 * `body` from the notification payload (e.g. an order number, a
 * remaining-codes count) so anything that could break out of an
 * attribute or inject markup must be escaped. `&` first to avoid
 * double-encoding the entities we add for the others.
 */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Resolve a CTA URL against the email link base. We accept absolute
 * https:// / http:// / mailto: as-is so callers can override per
 * email if needed; everything else is treated as a path and joined
 * onto `linkBaseUrl`. We deliberately do NOT pass through `javascript:`
 * or other exotic schemes — only http/https/mailto are honoured.
 */
export function resolveCtaUrl(ctaUrl: string, linkBaseUrl: string): string | null {
  const trimmed = ctaUrl.trim();
  if (!trimmed) return null;
  if (/^(https?:|mailto:)/i.test(trimmed)) {
    return trimmed;
  }
  // Defense in depth: refuse anything that looks like a non-path
  // scheme (`javascript:`, `data:`, `file:`, etc.) so a future
  // payload bug can't smuggle a hostile scheme into a CTA button.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return null;
  }
  const base = linkBaseUrl.replace(/\/+$/, "");
  const path = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return `${base}${path}`;
}

/**
 * Render the branded email. Returns subject + html + plain-text
 * fallback. The plain-text version is required by best-practice
 * deliverability — providers that drop multipart/alternative score
 * worse with spam filters and accessibility tools (some screen
 * readers prefer the text part).
 */
export function renderEpplaaEmail(args: RenderEpplaaEmailArgs): RenderedEpplaaEmail {
  const { title, body, linkBaseUrl } = args;
  const ctaLabel = args.ctaLabel ?? "Open Epplaa";
  const resolvedCta = args.ctaUrl ? resolveCtaUrl(args.ctaUrl, linkBaseUrl) : null;

  const safeTitle = escapeHtml(title);
  const safeBody = escapeHtml(body);
  const safeCtaLabel = escapeHtml(ctaLabel);

  const ctaBlock = resolvedCta
    ? `
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 8px 0;">
                <tr>
                  <td align="center" bgcolor="#0F1A2A" style="border-radius:6px;">
                    <a href="${escapeHtml(resolvedCta)}"
                       style="display:inline-block;padding:14px 28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:600;line-height:1;color:#ffffff;text-decoration:none;border-radius:6px;background-color:#0F1A2A;">
                      ${safeCtaLabel}
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:8px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;color:#5b6470;">
                If the button doesn't work, copy and paste this link into your browser:<br>
                <a href="${escapeHtml(resolvedCta)}" style="color:#0F1A2A;word-break:break-all;">${escapeHtml(resolvedCta)}</a>
              </p>`
    : "";

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="x-apple-disable-message-reformatting">
    <title>${safeTitle}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f4f5f7;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f5f7;">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background-color:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e6e8ec;">
            <tr>
              <td style="padding:24px 32px;background-color:#0F1A2A;">
                <span style="font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:700;letter-spacing:0.5px;color:#ffffff;">
                  Epplaa
                </span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px 32px 24px 32px;">
                <h1 style="margin:0 0 16px 0;font-family:Arial,Helvetica,sans-serif;font-size:22px;line-height:1.3;color:#0F1A2A;">
                  ${safeTitle}
                </h1>
                <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#2c333d;">
                  ${safeBody}
                </p>${ctaBlock}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px 28px 32px;border-top:1px solid #e6e8ec;background-color:#fafbfc;">
                <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#7a8290;">
                  You're receiving this email because of activity on your Epplaa account. If you didn't expect this message, you can safely ignore it.
                </p>
                <p style="margin:8px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#7a8290;">
                  &copy; Epplaa
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const textLines = [
    "Epplaa",
    "",
    title,
    "",
    body,
  ];
  // (Plain-text fallback continues below; rendering ends after we
  // optionally append the CTA + footer.)
  if (resolvedCta) {
    textLines.push("", `${ctaLabel}: ${resolvedCta}`);
  }
  textLines.push(
    "",
    "—",
    "You're receiving this email because of activity on your Epplaa account.",
    "If you didn't expect this message, you can safely ignore it.",
  );
  const text = textLines.join("\n");

  return { subject: title, html, text };
}
