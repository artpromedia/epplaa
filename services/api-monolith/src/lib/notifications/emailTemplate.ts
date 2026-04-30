/**
 * Branded transactional email template for Epplaa notifications.
 *
 * Originally built for the MFA backup-codes nudge (`mfa_backup_codes_low`),
 * the same shell now also renders the higher-stakes MFA security
 * notifications (`mfa_activated`, `mfa_backup_codes_regenerated`) via
 * the optional `variant: "security"` mode. Adapters call
 * `renderEpplaaEmail` to produce the {subject, html, text} they hand
 * to Postmark / SendGrid.
 *
 * Template shape:
 *   - Default variant: short title, one paragraph, optional CTA button.
 *   - Security variant: same chrome PLUS a coloured "Security alert"
 *     ribbon under the brand bar, an optional meta-line table
 *     (When / IP / Device / etc.), a security-team signature line,
 *     and a "Need help?" support contact in the footer.
 *
 * Why a hand-written template (vs MJML / react-email):
 * - Email clients are notoriously hostile to modern CSS. We use only
 *   the widely-supported subset (table layout, inline styles, web-safe
 *   fonts) so the rendering is consistent across Gmail/Outlook/Apple
 *   Mail/the dozen mobile clients we know our buyers use.
 * - Pulling in a dependency to render two templates is overkill at
 *   the current scale and adds a transitive surface area for security
 *   advisories.
 *
 * Pure function — no env reads, no I/O. The link base URL, support
 * address, and signature are passed in by the adapter so unit tests
 * can pin them deterministically and the same template can be
 * rendered from a worker process / job runner that may not share env
 * with the request context.
 */

/**
 * One key/value row rendered into the security variant's meta-table
 * (e.g. `{ label: "IP", value: "203.0.113.10" }`). Adapters compose
 * these from the notification payload (ipAddress, userAgent,
 * occurredAt) so the template never has to know which fields exist.
 */
export interface EmailMetaLine {
  label: string;
  value: string;
}

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
  /**
   * Visual flavour. `"default"` is the original transactional shell
   * used by nudges/promos; `"security"` renders a high-trust security
   * alert layout (alert ribbon, meta table, signature, support
   * contact in footer). Defaults to `"default"`.
   */
  variant?: "default" | "security";
  /**
   * Forensic key/value lines (When / IP / Device …). Rendered as a
   * compact table between the body and the CTA. Empty/omitted lines
   * are dropped so callers can pass `value: ""` for unknown fields
   * without leaking "unknown"-style placeholders into the inbox.
   */
  metaLines?: ReadonlyArray<EmailMetaLine>;
  /**
   * Sign-off line (e.g. "— The Epplaa Security Team"). Rendered after
   * the CTA on the security variant only. Adapters control the exact
   * wording so a future translation pass can localise it without
   * touching the template.
   */
  signature?: string;
  /**
   * Support contact address. When present, the security variant
   * renders a "Need help? Contact <a href=mailto:…>" line in the
   * footer. The default variant ignores this field (the nudge email
   * intentionally has no support hook).
   */
  supportEmail?: string;
}

export interface RenderedEpplaaEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Conservative HTML escaper. We render user-controlled `title` /
 * `body` from the notification payload (e.g. an order number, a
 * remaining-codes count, an IP address, a user-agent string) so
 * anything that could break out of an attribute or inject markup
 * must be escaped. `&` first to avoid double-encoding the entities
 * we add for the others.
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
 * Validate a support address before letting it into a `mailto:` href
 * or a Reply-To footer line. We only need to catch the obvious
 * "EMAIL_SUPPORT_ADDRESS got set to a marketing blurb" misconfig —
 * the deliverability layer (Postmark/SendGrid) does the real RFC 5321
 * check on the actual From / Reply-To headers. Returns the trimmed
 * address when it parses, or null when it doesn't (so the security
 * footer falls back to omitting the line rather than rendering a
 * broken `mailto:`).
 */
function sanitiseSupportEmail(input: string | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  return trimmed;
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
  const variant = args.variant ?? "default";
  const ctaLabel = args.ctaLabel ?? "Open Epplaa";
  const resolvedCta = args.ctaUrl ? resolveCtaUrl(args.ctaUrl, linkBaseUrl) : null;
  // The security-only fields (meta-table, signature, support contact)
  // are intentionally gated on `variant === "security"`. The default
  // transactional shell (e.g. the `mfa_backup_codes_low` nudge) keeps
  // its existing pinned rendering even if a future caller passes
  // these fields by mistake — that prevents a silent contract drift
  // for the snapshot tests that pin the nudge layout.
  const metaLines =
    variant === "security"
      ? (args.metaLines ?? []).filter((m) => m.value.trim().length > 0)
      : [];
  const signature = args.signature?.trim() ?? "";
  const supportEmail = variant === "security" ? sanitiseSupportEmail(args.supportEmail) : null;

  const safeTitle = escapeHtml(title);
  const safeBody = escapeHtml(body);
  const safeCtaLabel = escapeHtml(ctaLabel);

  // ---------- HTML pieces ----------

  // Coloured "Security alert" ribbon. Rendered for the security
  // variant so the email is recognisable as a tripwire even before
  // the recipient reads the headline. Amber (vs red) keeps the tone
  // informational rather than alarming for the common case where
  // the user is the one who triggered the action.
  const securityRibbon =
    variant === "security"
      ? `
            <tr>
              <td style="padding:10px 32px;background-color:#fff4e0;border-bottom:1px solid #f1d8a8;">
                <span style="font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:#7a4a00;">
                  Security alert
                </span>
              </td>
            </tr>`
      : "";

  // Meta-table block (When / IP / Device …). Rendered as a borderless
  // two-column table so even Outlook lays it out tidily. Empty lines
  // are dropped above so we never render a label with no value.
  const metaBlock =
    metaLines.length > 0
      ? `
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 0 0;border-collapse:collapse;width:100%;background-color:#f7f8fa;border:1px solid #e6e8ec;border-radius:6px;">
                ${metaLines
                  .map(
                    (m) => `
                <tr>
                  <td style="padding:8px 14px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#5b6470;width:90px;vertical-align:top;">${escapeHtml(m.label)}</td>
                  <td style="padding:8px 14px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#0F1A2A;word-break:break-word;">${escapeHtml(m.value)}</td>
                </tr>`,
                  )
                  .join("")}
              </table>`
      : "";

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

  const signatureBlock =
    variant === "security" && signature
      ? `
              <p style="margin:24px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#2c333d;">
                ${escapeHtml(signature)}
              </p>`
      : "";

  const supportBlock = supportEmail
    ? `
                <p style="margin:8px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#7a8290;">
                  Need help? Contact <a href="mailto:${escapeHtml(supportEmail)}" style="color:#0F1A2A;text-decoration:underline;">${escapeHtml(supportEmail)}</a>.
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
            </tr>${securityRibbon}
            <tr>
              <td style="padding:32px 32px 24px 32px;">
                <h1 style="margin:0 0 16px 0;font-family:Arial,Helvetica,sans-serif;font-size:22px;line-height:1.3;color:#0F1A2A;">
                  ${safeTitle}
                </h1>
                <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#2c333d;">
                  ${safeBody}
                </p>${metaBlock}${ctaBlock}${signatureBlock}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px 28px 32px;border-top:1px solid #e6e8ec;background-color:#fafbfc;">
                <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#7a8290;">
                  You're receiving this email because of activity on your Epplaa account. If you didn't expect this message, you can safely ignore it.
                </p>${supportBlock}
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

  // ---------- Plain-text fallback ----------
  // Mirrors the HTML so a recipient on a text-only client (or a
  // screen reader that prefers text/plain) still gets the alert
  // ribbon, meta lines, CTA, signature and support contact.
  const textLines: string[] = ["Epplaa"];
  if (variant === "security") {
    textLines.push("[ SECURITY ALERT ]");
  }
  textLines.push("", title, "", body);
  if (metaLines.length > 0) {
    textLines.push("");
    for (const m of metaLines) {
      textLines.push(`${m.label}: ${m.value}`);
    }
  }
  if (resolvedCta) {
    textLines.push("", `${ctaLabel}: ${resolvedCta}`);
  }
  if (variant === "security" && signature) {
    textLines.push("", signature);
  }
  textLines.push(
    "",
    "—",
    "You're receiving this email because of activity on your Epplaa account.",
    "If you didn't expect this message, you can safely ignore it.",
  );
  if (supportEmail) {
    textLines.push(`Need help? Contact ${supportEmail}.`);
  }
  const text = textLines.join("\n");

  return { subject: title, html, text };
}
