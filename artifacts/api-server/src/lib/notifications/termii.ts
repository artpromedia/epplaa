import { logger } from "../logger";
import { detectNonHostnameProductionSignals } from "../productionSignals";
import type { ChannelKind, NotificationChannel, NotificationMessage, SendResult } from "./types";

const TERMII_BASE = "https://v3.api.termii.com";

/**
 * Boot-time sanity check: production deploys MUST set `TERMII_API_KEY`.
 *
 * The Termii adapter (`TermiiChannel.send`) silently logs an info-level
 * `termii_dev_send` and returns `{ ok: true }` when the API key is
 * absent. The same `!process.env.TERMII_API_KEY` check in `lib/otp.ts`
 * flips the OTP issuer into `devEcho` mode, where the OTP code is
 * returned in the API response so dev callers can read it without a
 * real SMS. On a production deploy that means **every phone OTP is
 * trivially bypassable** — a buyer can claim any phone number without
 * proving control of it.
 *
 * Modelled on the other `assertXxxConfiguredForProduction` helpers
 * (see `docs/runbooks/production-secrets.md`). Warning, not a hard
 * failure: a brand-new internal-only deploy may legitimately ship
 * without SMS while it's being stood up. Operators wire a Sentry /
 * log-aggregator alert on the `termii_api_key_missing_for_production`
 * message tag — see the runbook for the alert configuration.
 *
 * Pure function — takes `env` and a `log` sink so the unit test can
 * exercise the staging-skipped, production-warned, and configured-
 * silent paths without poisoning `process.env` or piping pino output.
 */
export type TermiiConfigOutcome =
  | { ok: true }
  | { ok: false; reason: string };

export function assertTermiiConfiguredForProduction(
  env: NodeJS.ProcessEnv,
  log: { warn: (obj: unknown, msg: string) => void },
): TermiiConfigOutcome {
  const productionSignals = detectNonHostnameProductionSignals(env);
  if (productionSignals.length === 0) return { ok: true };
  const raw = env.TERMII_API_KEY;
  if (raw && raw.trim() !== "") return { ok: true };
  const signalDetails = productionSignals.map((s) => s.detail).join("; ");
  const reason =
    "TERMII_API_KEY is not set on this production deploy. The OTP " +
    "issuer (lib/otp.ts) flips into devEcho mode and returns the OTP " +
    "code in the API response, and the SMS / WhatsApp adapter " +
    "(lib/notifications/termii.ts) becomes a console-log no-op. The " +
    "net effect is that every phone OTP is trivially bypassable — a " +
    "buyer can claim any phone number without proving control of it. " +
    `Detected production signal(s): ${signalDetails}. ` +
    "Set TERMII_API_KEY — see docs/runbooks/production-secrets.md " +
    "(TERMII_API_KEY section).";
  log.warn(
    {
      node_env: env.NODE_ENV,
      replit_deployment: env.REPLIT_DEPLOYMENT,
      deployment_environment: env.DEPLOYMENT_ENVIRONMENT,
      termii_api_key: raw ? "[set-but-empty]" : null,
      production_signals: productionSignals.map((s) => s.signal),
    },
    `termii_api_key_missing_for_production: ${reason}`,
  );
  return { ok: false, reason };
}

/**
 * Termii adapter for SMS and WhatsApp. The same provider serves both so
 * we instantiate twice with different `channel` constructor args.
 *
 * Falls back to console-log behavior (ok=true) when the API key is absent
 * so dev environments do not blow up the outbox worker.
 */
export class TermiiChannel implements NotificationChannel {
  constructor(public readonly kind: Extract<ChannelKind, "sms" | "whatsapp">) {}

  isConfigured(): boolean {
    return Boolean(process.env.TERMII_API_KEY);
  }

  async send(msg: NotificationMessage): Promise<SendResult> {
    const apiKey = process.env.TERMII_API_KEY;
    const sender = process.env.TERMII_SENDER_ID || "Epplaa";
    if (!apiKey) {
      logger.info({ kind: this.kind, to: msg.to, title: msg.title }, "termii_dev_send");
      return { ok: true, providerMessageId: `termii_dev_${Date.now()}` };
    }
    const channel = this.kind === "whatsapp" ? "whatsapp" : "generic";
    const text = msg.title === msg.body ? msg.body : `${msg.title}\n${msg.body}`;
    try {
      const res = await fetch(`${TERMII_BASE}/api/sms/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          to: msg.to,
          from: sender,
          sms: text + (msg.url ? `\n${msg.url}` : ""),
          type: "plain",
          channel,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { message_id?: string; message?: string };
      if (!res.ok) {
        return { ok: false, errorCode: String(res.status), errorMessage: data.message ?? "termii_failed" };
      }
      return { ok: true, providerMessageId: data.message_id };
    } catch (err) {
      return { ok: false, errorMessage: (err as Error).message };
    }
  }
}
