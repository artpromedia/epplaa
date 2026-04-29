import { logger } from "../logger";

/**
 * Out-of-band paging for the rate-limit store going degraded.
 *
 * The admin console already shows an in-app toast + sticky banner when
 * `/healthz`'s `rateLimitStore.state` flips to `"degraded"`, but those
 * signals only reach operators who happen to be signed into the console.
 * After-hours / weekend incidents need to go to the on-call rotation
 * directly. This module fans the same healthy↔degraded transitions out
 * to a Slack incoming webhook and/or the PagerDuty Events API so the
 * alert lands in the channel/rotation regardless of whether anyone is
 * looking at the admin console.
 *
 * Dedupe semantics (matching `RateLimitStoreAlerts` in the admin console):
 *   - `notifyDegraded` is invoked exactly once per healthy→degraded
 *     transition by the watcher — i.e. the moment `firstFailureAt`
 *     flips null→non-null. The Sentry `thresholdPerMin` breach
 *     detector is intentionally NOT in this path: the in-app banner
 *     toasts on `prevState !== "degraded"` (which uses the same
 *     `state` field, derived purely from `firstFailureAt`), and the
 *     out-of-band page must follow the same edge so on-call and the
 *     operator agree on whether an incident occurred. Additional
 *     failures inside the same streak — including ones that DO cross
 *     the Sentry breach threshold — never re-page.
 *   - `notifyRecovered` is invoked exactly once per degraded→healthy
 *     transition (every closing streak), mirroring the admin console's
 *     `lastRecoveredAt !== prevRecoveredAt` recovery toast. PagerDuty's
 *     shared `dedup_key` makes a paired resolve a no-op when no
 *     trigger ever fired, so emitting recovery for a transient blip
 *     that the operator never saw is safe — it doesn't open spurious
 *     incidents.
 *
 * Configuration (read at notify time so a hot env-var rotation is picked
 * up by the next incident — matches the readyz-config pattern):
 *   - `RATE_LIMIT_INCIDENT_SLACK_WEBHOOK_URL` — full Slack incoming
 *     webhook URL (the URL token is the secret). Unset disables Slack.
 *   - `RATE_LIMIT_INCIDENT_PAGERDUTY_ROUTING_KEY` — PagerDuty Events API
 *     v2 integration / routing key. Unset disables PagerDuty.
 *   - `RATE_LIMIT_INCIDENT_PAGERDUTY_URL` — optional override for the
 *     PagerDuty Events API endpoint (defaults to the v2 enqueue URL).
 *     Useful for tests pointing at a local mock.
 *   - `RATE_LIMIT_INCIDENT_SOURCE` — optional human-readable source label
 *     (e.g. `"epplaa-prod"`) attached to PagerDuty/Slack payloads so the
 *     receiving channel/rotation can tell which environment paged. Falls
 *     back to `HOSTNAME` if unset.
 *
 * When neither webhook target is configured the notifier is a graceful
 * no-op. Dev/preview/CI deploys that don't ship Slack or PagerDuty
 * credentials therefore do not try to page anyone — verified by unit
 * tests that assert zero `fetch` calls when the env is empty.
 *
 * Failures (non-2xx responses, network errors, timeouts) are logged but
 * never thrown back into the caller: the watcher's job is to keep the
 * rate-limit store decision path moving even when the paging transport
 * is itself broken. Sentry already captures the underlying breach via
 * `captureMessage("rate_limit_redis_failure_threshold_breached")`, so a
 * paging-transport outage doesn't lose the incident — it just means the
 * channel/rotation didn't get the duplicate notification.
 */

export interface DegradedTransitionEvent {
  failureCount: number;
  threshold: number;
  /** ms epoch when the streak began. */
  firstFailureAt: number;
  /** ms epoch when the breach was detected (i.e. now). */
  breachedAt: number;
}

export interface RecoveredTransitionEvent {
  /** Length of the breached streak in ms. */
  durationMs: number;
  /** Number of failures observed during the streak. */
  failureCount: number;
  /** ms epoch when the recovery was observed. */
  recoveredAt: number;
}

export interface RateLimitIncidentNotifier {
  notifyDegraded(event: DegradedTransitionEvent): void;
  notifyRecovered(event: RecoveredTransitionEvent): void;
}

/**
 * Hard timeout on each webhook POST. Long enough to absorb the typical
 * Slack / PagerDuty p99 (a few hundred ms) but short enough that a
 * stuck transport doesn't pin the watcher's Node.js event loop or
 * leak timers. Configurable so tests can drive timeout paths quickly.
 */
function webhookTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.RATE_LIMIT_INCIDENT_WEBHOOK_TIMEOUT_MS;
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5_000;
}

function pagerDutyUrl(env: NodeJS.ProcessEnv): string {
  const raw = env.RATE_LIMIT_INCIDENT_PAGERDUTY_URL;
  if (raw && raw.trim() !== "") return raw.trim();
  return "https://events.pagerduty.com/v2/enqueue";
}

function incidentSource(env: NodeJS.ProcessEnv): string {
  const explicit = env.RATE_LIMIT_INCIDENT_SOURCE;
  if (explicit && explicit.trim() !== "") return explicit.trim();
  const hostname = env.HOSTNAME;
  if (hostname && hostname.trim() !== "") return hostname.trim();
  return "api-server";
}

/**
 * Fetch shape we depend on. Pulled into an interface so tests can
 * substitute a deterministic stub without monkey-patching the global.
 */
export type WebhookFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; statusText: string }>;

interface WebhookNotifierOptions {
  fetchImpl?: WebhookFetch;
  /**
   * Read-time env getter. Defaults to `process.env`. Tests can pass a
   * frozen snapshot to avoid global env mutation between cases.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * Wraps the global `fetch` in the WebhookFetch shape and adds an
 * AbortController-driven timeout. Extracted so the singleton can fall
 * back to it while tests inject their own. The timeout is read from
 * `process.env` at call time so a hot-rotated tuning value is picked
 * up by the next webhook POST.
 */
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

/**
 * Build the Slack message body for a degraded transition. The wording
 * mirrors the admin-console toast so an operator who sees both signals
 * isn't second-guessing whether they're the same incident.
 */
export function buildSlackDegradedPayload(
  event: DegradedTransitionEvent,
  source: string,
): string {
  const startedIso = new Date(event.firstFailureAt).toISOString();
  return JSON.stringify({
    text: `:rotating_light: Rate-limit store DEGRADED on ${source}`,
    attachments: [
      {
        color: "danger",
        fields: [
          { title: "Source", value: source, short: true },
          {
            title: "Failure count",
            value: String(event.failureCount),
            short: true,
          },
          {
            title: "Threshold (per minute)",
            value: String(event.threshold),
            short: true,
          },
          { title: "Streak began", value: startedIso, short: true },
        ],
        footer:
          "Rate-limit store is degrading open. Investigate Redis/backing " +
          "store before traffic spreads across replicas without a shared " +
          "quota. See docs/runbooks/rate-limit-store.md.",
      },
    ],
  });
}

export function buildSlackRecoveredPayload(
  event: RecoveredTransitionEvent,
  source: string,
): string {
  const recoveredIso = new Date(event.recoveredAt).toISOString();
  const durationSeconds = Math.max(1, Math.round(event.durationMs / 1000));
  return JSON.stringify({
    text: `:white_check_mark: Rate-limit store RECOVERED on ${source}`,
    attachments: [
      {
        color: "good",
        fields: [
          { title: "Source", value: source, short: true },
          {
            title: "Duration",
            value: `${durationSeconds}s`,
            short: true,
          },
          {
            title: "Failures during streak",
            value: String(event.failureCount),
            short: true,
          },
          { title: "Recovered at", value: recoveredIso, short: true },
        ],
      },
    ],
  });
}

/**
 * Build the PagerDuty Events API v2 payload. We use a stable
 * `dedup_key` so a flapping store inside the same logical incident
 * groups under one PagerDuty incident instead of opening a new one
 * per transition. The trigger and resolve events share the same key
 * so PagerDuty closes the incident automatically on recovery.
 */
export function buildPagerDutyDegradedPayload(
  event: DegradedTransitionEvent,
  source: string,
  routingKey: string,
): string {
  return JSON.stringify({
    routing_key: routingKey,
    event_action: "trigger",
    dedup_key: `rate-limit-store-degraded:${source}`,
    payload: {
      summary: `Rate-limit store degraded on ${source} (${event.failureCount} failures, threshold ${event.threshold}/min)`,
      source,
      severity: "error",
      component: "rate_limit_store",
      group: "api-server",
      class: "subsystem-degraded",
      custom_details: {
        failureCount: event.failureCount,
        threshold: event.threshold,
        firstFailureAt: event.firstFailureAt,
        breachedAt: event.breachedAt,
      },
    },
  });
}

export function buildPagerDutyRecoveredPayload(
  _event: RecoveredTransitionEvent,
  source: string,
  routingKey: string,
): string {
  return JSON.stringify({
    routing_key: routingKey,
    event_action: "resolve",
    dedup_key: `rate-limit-store-degraded:${source}`,
  });
}

/**
 * Production singleton. Reads the env on every notify() call so a hot
 * rotation of the webhook URL / routing key is picked up by the next
 * incident without restarting the server.
 */
export class WebhookIncidentNotifier implements RateLimitIncidentNotifier {
  private readonly fetchImpl: WebhookFetch;
  private readonly envSnapshot?: NodeJS.ProcessEnv;

  constructor(opts: WebhookNotifierOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? defaultFetch();
    this.envSnapshot = opts.env;
  }

  private env(): NodeJS.ProcessEnv {
    return this.envSnapshot ?? process.env;
  }

  notifyDegraded(event: DegradedTransitionEvent): void {
    const env = this.env();
    const source = incidentSource(env);
    const slackUrl = (env.RATE_LIMIT_INCIDENT_SLACK_WEBHOOK_URL ?? "").trim();
    const pdKey = (
      env.RATE_LIMIT_INCIDENT_PAGERDUTY_ROUTING_KEY ?? ""
    ).trim();
    if (slackUrl !== "") {
      this.send(
        slackUrl,
        buildSlackDegradedPayload(event, source),
        "slack_degraded",
      );
    }
    if (pdKey !== "") {
      this.send(
        pagerDutyUrl(env),
        buildPagerDutyDegradedPayload(event, source, pdKey),
        "pagerduty_degraded",
      );
    }
  }

  notifyRecovered(event: RecoveredTransitionEvent): void {
    const env = this.env();
    const source = incidentSource(env);
    const slackUrl = (env.RATE_LIMIT_INCIDENT_SLACK_WEBHOOK_URL ?? "").trim();
    const pdKey = (
      env.RATE_LIMIT_INCIDENT_PAGERDUTY_ROUTING_KEY ?? ""
    ).trim();
    if (slackUrl !== "") {
      this.send(
        slackUrl,
        buildSlackRecoveredPayload(event, source),
        "slack_recovered",
      );
    }
    if (pdKey !== "") {
      this.send(
        pagerDutyUrl(env),
        buildPagerDutyRecoveredPayload(event, source, pdKey),
        "pagerduty_recovered",
      );
    }
  }

  /**
   * Fire-and-forget POST. We deliberately do NOT await the result from
   * the watcher — it would couple the bump path's latency to the
   * webhook RTT, which is the opposite of what an out-of-band paging
   * channel is for. Errors are swallowed and logged; Sentry already
   * has the underlying breach so the incident is never lost.
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
            "rate_limit_incident_webhook_non_2xx",
          );
        } else {
          logger.info(
            { kind, status: res.status },
            "rate_limit_incident_webhook_sent",
          );
        }
      })
      .catch((err: unknown) => {
        logger.warn(
          { kind, err: (err as Error).message },
          "rate_limit_incident_webhook_failed",
        );
      });
  }
}

/**
 * Default no-op notifier used in tests / when no webhook is wired.
 * Kept distinct from `WebhookIncidentNotifier` with empty env so a
 * caller can swap to it explicitly without paying for env reads.
 */
export const NOOP_INCIDENT_NOTIFIER: RateLimitIncidentNotifier = {
  notifyDegraded() {},
  notifyRecovered() {},
};
