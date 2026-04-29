import { logger } from "../logger";
import type { schema } from "../db";
import type { TransportResult } from "./delivery";

/**
 * Postmark transport for the PUDO daily push. We deliberately call
 * Postmark's REST API directly here (instead of routing through the
 * notifications outbox / channel registry) because:
 *
 *   - The outbox is keyed on `userId` and resolves channel via user
 *     prefs — but PUDO partners are NOT users in our auth system,
 *     they're external organisations identified by `partner.code`.
 *   - The manifest is a CSV attachment, which the existing
 *     `NotificationChannel` interface has no slot for.
 *
 * Configured via the same env vars as the regular Postmark adapter
 * (`POSTMARK_API_TOKEN`, `EMAIL_FROM`, `EMAIL_REPLY_TO`,
 * `POSTMARK_MESSAGE_STREAM`) so a deploy that's already wired for
 * transactional email gets PUDO push for free.
 *
 * `partner.manifestEmail` may be a comma-separated list (Pargo's ops
 * desk likes `ops@pargo.com,manifests@pargo.com`); we forward the
 * raw string and let Postmark fan out — its `To` field accepts up to
 * 50 RFC-5322 recipients per request.
 */
export interface EmailTransportArgs {
  partner: typeof schema.pudoPartnersTable.$inferSelect;
  forDate: string;
  csv: string;
}

const POSTMARK_BASE = "https://api.postmarkapp.com";

export async function sendManifestEmail(
  args: EmailTransportArgs,
): Promise<TransportResult> {
  const { partner, forDate, csv } = args;
  const recipients = partner.manifestEmail.trim();
  if (!recipients) {
    return {
      ok: false,
      destination: `email:${partner.code}`,
      errorCode: "no_recipient",
      errorMessage: "partner.manifestEmail is empty",
    };
  }

  const token = process.env.POSTMARK_API_TOKEN;
  if (!token) {
    // Fail-clean: the run row stays queued and the next tick retries.
    // Operators get the same alert pattern as a real transport flap so
    // the misconfiguration is paged on instead of silently no-op'd.
    return {
      ok: false,
      destination: `email:${recipients}`,
      errorCode: "not_configured",
      errorMessage: "POSTMARK_API_TOKEN unset",
    };
  }

  const from = process.env.EMAIL_FROM || "Epplaa <noreply@epplaa.com>";
  const replyTo = process.env.EMAIL_REPLY_TO;
  const messageStream = process.env.POSTMARK_MESSAGE_STREAM || "outbound";
  const subject = `Epplaa PUDO manifest — ${partner.name} — ${forDate}`;
  const filename = `${partner.code}-${forDate}.csv`;
  const body =
    `Hi ${partner.name},\n\n` +
    `Attached is the Epplaa PUDO manifest for ${forDate} (Africa/Lagos unless your timezone is configured otherwise).\n\n` +
    `Please scan the parcels into your inbound system on receipt and confirm collections via\n` +
    `POST /pudo/${partner.code}/collected. The same CSV is also available on demand at\n` +
    `GET /pudo/${partner.code}/manifest if you need to re-pull.\n\n` +
    `If anything looks wrong (missing parcels, mismatched locations, OTP gaps), reply to\n` +
    `this thread and the Epplaa fulfillment team will investigate.\n\n` +
    `— Epplaa\n`;

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
        To: recipients,
        Subject: subject,
        TextBody: body,
        MessageStream: messageStream,
        Attachments: [
          {
            Name: filename,
            Content: Buffer.from(csv, "utf8").toString("base64"),
            ContentType: "text/csv",
          },
        ],
        ...(replyTo ? { ReplyTo: replyTo } : {}),
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      MessageID?: string;
      ErrorCode?: number;
      Message?: string;
    };
    if (!res.ok || (typeof data.ErrorCode === "number" && data.ErrorCode !== 0)) {
      const errorCode =
        data.ErrorCode != null ? String(data.ErrorCode) : String(res.status);
      logger.warn(
        {
          partnerCode: partner.code,
          httpStatus: res.status,
          errorCode,
          message: data.Message,
        },
        "pudo_manifest_email_failed",
      );
      return {
        ok: false,
        destination: `email:${recipients}`,
        errorCode,
        errorMessage: data.Message ?? `http ${res.status}`,
      };
    }
    return {
      ok: true,
      destination: `email:${recipients}`,
    };
  } catch (err) {
    return {
      ok: false,
      destination: `email:${recipients}`,
      errorCode: "exception",
      errorMessage: (err as Error).message,
    };
  }
}
