import { logger } from "../logger";

/**
 * Generic out-of-band paging for any subsystem on `/admin/status` that
 * tracks a healthy↔degraded transition.
 *
 * The admin console's status page surfaces several panels — rate-limit
 * store health, payment-gateway circuit breakers, and (in time) more.
 * The in-app banner only reaches operators who happen to be signed
 * into the console. After-hours / weekend incidents need to land in
 * Slack or PagerDuty regardless. The rate-limit store wires this via
 * `lib/rate-limit/incidentNotifier.ts`; this module is the
 * payments/etc equivalent — same Slack + PagerDuty fan-out, just
 * parameterized by the subsystem identifier so the dedup key, summary
 * line, and on-call message all carry the panel name.
 *
 * Configuration (read at notify time so a hot env-var rotation is
 * picked up by the next incident — matches the readyz-config and
 * rate-limit-incident patterns):
 *
 *   - `SUBSYSTEM_ALERT_SLACK_WEBHOOK_URL`     — full Slack incoming
 *     webhook URL. Falls back to `RATE_LIMIT_INCIDENT_SLACK_WEBHOOK_URL`
 *     so an operator who already wired the rate-limit channel
 *     automatically receives gateway alerts on the same channel
 *     without re-rotating env vars.
 *   - `SUBSYSTEM_ALERT_PAGERDUTY_ROUTING_KEY` — PagerDuty Events API v2
 *     integration / routing key. Falls back to
 *     `RATE_LIMIT_INCIDENT_PAGERDUTY_ROUTING_KEY` for the same reason.
 *   - `SUBSYSTEM_ALERT_PAGERDUTY_URL`         — optional override for
 *     the PagerDuty enqueue endpoint (defaults to v2). Useful for
 *     tests pointing at a local mock. Falls back to
 *     `RATE_LIMIT_INCIDENT_PAGERDUTY_URL`.
 *   - `SUBSYSTEM_ALERT_SOURCE`                — human-readable source
 *     label attached to payloads so the on-call channel can tell which
 *     environment paged. Falls back to `RATE_LIMIT_INCIDENT_SOURCE`,
 *     then `HOSTNAME`, then "api-server".
 *   - `SUBSYSTEM_ALERT_WEBHOOK_TIMEOUT_MS`    — per-POST hard timeout
 *     (default 5000). Falls back to
 *     `RATE_LIMIT_INCIDENT_WEBHOOK_TIMEOUT_MS`.
 *
 * When neither Slack nor PagerDuty is configured the notifier is a
 * graceful no-op — dev / preview / CI deploys do not try to page
 * anyone. Failures (non-2xx, network, timeout) are logged but never
 * thrown back into the caller.
 */

export interface SubsystemDegradedEvent {
  /** Stable id for the subsystem panel (e.g. "payment-gateway:paystack"). */
  subsystem: string;
  /** Human-readable label for the page summary (e.g. "Paystack gateway"). */
  label: string;
  /** ms epoch when the streak/incident began. */
  firstFailureAt: number;
  /** ms epoch when this transition was detected (i.e. now). */
  detectedAt: number;
  /** Free-form structured details surfaced under PagerDuty `custom_details`
   *  and rendered as Slack fields. Values are coerced to strings for Slack. */
  details?: Record<string, string | number | null>;
}

export interface SubsystemRecoveredEvent {
  subsystem: string;
  label: string;
  /** ms epoch when recovery was observed. */
  recoveredAt: number;
  /** Length of the degraded streak in ms (clamped to >= 0). */
  durationMs: number;
  details?: Record<string, string | number | null>;
}

export interface SubsystemAlertNotifier {
  notifyDegraded(event: SubsystemDegradedEvent): void;
  notifyRecovered(event: SubsystemRecoveredEvent): void;
}

function readEnvWithFallback(
  env: NodeJS.ProcessEnv,
  primary: string,
  fallback: string,
): string {
  const p = (env[primary] ?? "").trim();
  if (p !== "") return p;
  return (env[fallback] ?? "").trim();
}

function webhookTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw =
    env.SUBSYSTEM_ALERT_WEBHOOK_TIMEOUT_MS ??
    env.RATE_LIMIT_INCIDENT_WEBHOOK_TIMEOUT_MS;
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5_000;
}

function pagerDutyUrl(env: NodeJS.ProcessEnv): string {
  const raw = readEnvWithFallback(
    env,
    "SUBSYSTEM_ALERT_PAGERDUTY_URL",
    "RATE_LIMIT_INCIDENT_PAGERDUTY_URL",
  );
  if (raw !== "") return raw;
  return "https://events.pagerduty.com/v2/enqueue";
}

function alertSource(env: NodeJS.ProcessEnv): string {
  const explicit = readEnvWithFallback(
    env,
    "SUBSYSTEM_ALERT_SOURCE",
    "RATE_LIMIT_INCIDENT_SOURCE",
  );
  if (explicit !== "") return explicit;
  const hostname = (env.HOSTNAME ?? "").trim();
  if (hostname !== "") return hostname;
  return "api-server";
}

/**
 * Fetch shape we depend on. Matches the shape used by the rate-limit
 * incident notifier so tests can re-use the same recorder helpers.
 */
export type WebhookFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; statusText: string }>;

interface NotifierOptions {
  fetchImpl?: WebhookFetch;
  /** Frozen env snapshot for tests. Defaults to live `process.env`. */
  env?: NodeJS.ProcessEnv;
}

function defaultFetch(): WebhookFetch {
  return async (url, init) => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      webhookTimeoutMs(process.env),
    );
    timer.unref?.();
    try {
      const res = await fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: controller.signal,
      });
      return { ok: res.ok, status: res.status, statusText: res.statusText };
    } finally {
      clearTimeout(timer);
    }
  };
}

function detailFields(
  details: Record<string, string | number | null> | undefined,
): Array<{ title: string; value: string; short: boolean }> {
  if (!details) return [];
  return Object.entries(details).map(([title, value]) => ({
    title,
    value: value === null ? "—" : String(value),
    short: true,
  }));
}

/**
 * Build the Slack message body for a degraded transition. Keep wording
 * symmetrical with the rate-limit notifier so on-call recognises both
 * channels at a glance.
 */
export function buildSlackDegradedPayload(
  event: SubsystemDegradedEvent,
  source: string,
): string {
  const startedIso = new Date(event.firstFailureAt).toISOString();
  return JSON.stringify({
    text: `:rotating_light: ${event.label} DEGRADED on ${source}`,
    attachments: [
      {
        color: "danger",
        fields: [
          { title: "Source", value: source, short: true },
          { title: "Subsystem", value: event.subsystem, short: true },
          { title: "Streak began", value: startedIso, short: true },
          ...detailFields(event.details),
        ],
        footer:
          `${event.label} flipped from healthy to degraded. Investigate the ` +
          "underlying dependency. See docs/runbooks/ for the matching runbook.",
      },
    ],
  });
}

export function buildSlackRecoveredPayload(
  event: SubsystemRecoveredEvent,
  source: string,
): string {
  const recoveredIso = new Date(event.recoveredAt).toISOString();
  const durationSeconds = Math.max(1, Math.round(event.durationMs / 1000));
  return JSON.stringify({
    text: `:white_check_mark: ${event.label} RECOVERED on ${source}`,
    attachments: [
      {
        color: "good",
        fields: [
          { title: "Source", value: source, short: true },
          { title: "Subsystem", value: event.subsystem, short: true },
          { title: "Duration", value: `${durationSeconds}s`, short: true },
          { title: "Recovered at", value: recoveredIso, short: true },
          ...detailFields(event.details),
        ],
      },
    ],
  });
}

function dedupKey(subsystem: string, source: string): string {
  return `subsystem-degraded:${subsystem}:${source}`;
}

export function buildPagerDutyDegradedPayload(
  event: SubsystemDegradedEvent,
  source: string,
  routingKey: string,
): string {
  return JSON.stringify({
    routing_key: routingKey,
    event_action: "trigger",
    dedup_key: dedupKey(event.subsystem, source),
    payload: {
      summary: `${event.label} degraded on ${source}`,
      source,
      severity: "error",
      component: event.subsystem,
      group: "api-server",
      class: "subsystem-degraded",
      custom_details: {
        subsystem: event.subsystem,
        firstFailureAt: event.firstFailureAt,
        detectedAt: event.detectedAt,
        ...(event.details ?? {}),
      },
    },
  });
}

export function buildPagerDutyRecoveredPayload(
  event: SubsystemRecoveredEvent,
  source: string,
  routingKey: string,
): string {
  return JSON.stringify({
    routing_key: routingKey,
    event_action: "resolve",
    dedup_key: dedupKey(event.subsystem, source),
  });
}

/**
 * Production singleton-style notifier. Reads env on every notify so a
 * hot-rotated webhook URL or routing key is picked up by the next
 * incident without restarting the server.
 */
export class WebhookSubsystemAlertNotifier implements SubsystemAlertNotifier {
  private readonly fetchImpl: WebhookFetch;
  private readonly envSnapshot?: NodeJS.ProcessEnv;

  constructor(opts: NotifierOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? defaultFetch();
    this.envSnapshot = opts.env;
  }

  private env(): NodeJS.ProcessEnv {
    return this.envSnapshot ?? process.env;
  }

  notifyDegraded(event: SubsystemDegradedEvent): void {
    const env = this.env();
    const source = alertSource(env);
    const slackUrl = readEnvWithFallback(
      env,
      "SUBSYSTEM_ALERT_SLACK_WEBHOOK_URL",
      "RATE_LIMIT_INCIDENT_SLACK_WEBHOOK_URL",
    );
    const pdKey = readEnvWithFallback(
      env,
      "SUBSYSTEM_ALERT_PAGERDUTY_ROUTING_KEY",
      "RATE_LIMIT_INCIDENT_PAGERDUTY_ROUTING_KEY",
    );
    if (slackUrl !== "") {
      this.send(
        slackUrl,
        buildSlackDegradedPayload(event, source),
        `slack_degraded:${event.subsystem}`,
      );
    }
    if (pdKey !== "") {
      this.send(
        pagerDutyUrl(env),
        buildPagerDutyDegradedPayload(event, source, pdKey),
        `pagerduty_degraded:${event.subsystem}`,
      );
    }
  }

  notifyRecovered(event: SubsystemRecoveredEvent): void {
    const env = this.env();
    const source = alertSource(env);
    const slackUrl = readEnvWithFallback(
      env,
      "SUBSYSTEM_ALERT_SLACK_WEBHOOK_URL",
      "RATE_LIMIT_INCIDENT_SLACK_WEBHOOK_URL",
    );
    const pdKey = readEnvWithFallback(
      env,
      "SUBSYSTEM_ALERT_PAGERDUTY_ROUTING_KEY",
      "RATE_LIMIT_INCIDENT_PAGERDUTY_ROUTING_KEY",
    );
    if (slackUrl !== "") {
      this.send(
        slackUrl,
        buildSlackRecoveredPayload(event, source),
        `slack_recovered:${event.subsystem}`,
      );
    }
    if (pdKey !== "") {
      this.send(
        pagerDutyUrl(env),
        buildPagerDutyRecoveredPayload(event, source, pdKey),
        `pagerduty_recovered:${event.subsystem}`,
      );
    }
  }

  /**
   * Fire-and-forget POST. Never await the result from the caller path
   * — that would couple the operational hot path (e.g. the payment
   * router's `recordAndMaybeTrip`) to the webhook RTT, which is the
   * opposite of what an out-of-band paging channel is for.
   */
  private send(url: string, body: string, kind: string): void {
    void this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    })
      .then((res) => {
        if (!res.ok) {
          logger.warn(
            { kind, status: res.status, statusText: res.statusText },
            "subsystem_alert_webhook_non_2xx",
          );
        } else {
          logger.info(
            { kind, status: res.status },
            "subsystem_alert_webhook_sent",
          );
        }
      })
      .catch((err: unknown) => {
        logger.warn(
          { kind, err: (err as Error).message },
          "subsystem_alert_webhook_failed",
        );
      });
  }
}

/** No-op for tests / explicit disabling without paying for env reads. */
export const NOOP_SUBSYSTEM_ALERT_NOTIFIER: SubsystemAlertNotifier = {
  notifyDegraded() {},
  notifyRecovered() {},
};
