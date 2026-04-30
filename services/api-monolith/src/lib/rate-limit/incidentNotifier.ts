import { logger } from "../logger";

/**
 * Out-of-band paging for a backing subsystem going healthy↔degraded.
 *
 * Originally written for the rate-limit Redis store (hence the file
 * path), this notifier is now reused by other backing-service watchers
 * — most notably `dbHealthWatcher` — that need the same Slack +
 * PagerDuty fan-out on every healthy↔degraded edge. Each caller
 * tags its events with a `subsystem` discriminator so PagerDuty
 * groups its incidents under a separate `dedup_key` (e.g.
 * `db-degraded:<source>` vs `rate-limit-store-degraded:<source>`)
 * and the Slack copy names the right panel. The default discriminator
 * is `"rate-limit-store"` so existing rate-limit callers stay
 * byte-identical without code changes.
 *
 * The admin console already shows in-app toasts + sticky banners when
 * `/healthz`'s subsystem entries flip to `"degraded"`, but those
 * signals only reach operators who happen to be signed into the
 * console. After-hours / weekend incidents (rate-limit Redis going
 * down on a Sunday, the Postgres pool going unreachable for many
 * minutes) need to land in the on-call rotation directly. This module
 * fans the same healthy↔degraded transitions out to a Slack incoming
 * webhook and/or the PagerDuty Events API so the alert lands in the
 * channel/rotation regardless of whether anyone is looking at the
 * admin console.
 *
 * Dedupe semantics (matching the in-app banners):
 *   - `notifyDegraded` is invoked exactly once per healthy→degraded
 *     transition by the watcher — i.e. the moment `firstFailureAt`
 *     flips null→non-null. For the rate-limit store the per-minute
 *     Sentry `thresholdPerMin` breach detector is intentionally NOT in
 *     this path: the in-app banner toasts on `prevState !==
 *     "degraded"`, and the out-of-band page must follow the same edge
 *     so on-call and the operator agree on whether an incident
 *     occurred. Additional failures inside the same streak — including
 *     ones that DO cross the Sentry breach threshold — never re-page.
 *   - `notifyRecovered` is invoked exactly once per degraded→healthy
 *     transition (every closing streak), mirroring the admin console's
 *     `lastRecoveredAt !== prevRecoveredAt` recovery toast. PagerDuty's
 *     shared `dedup_key` makes a paired resolve a no-op when no
 *     trigger ever fired, so emitting recovery for a transient blip
 *     that the operator never saw is safe — it doesn't open spurious
 *     incidents.
 *
 * Configuration (read at notify time so a hot env-var rotation is picked
 * up by the next incident — matches the readyz-config pattern). The
 * env vars deliberately keep their `RATE_LIMIT_INCIDENT_*` names even
 * though the notifier now also pages for DB transitions, so reusing
 * the same Slack channel / PagerDuty service for every subsystem
 * needs zero new operator config:
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
 * underlying decision path moving even when the paging transport is
 * itself broken. Sentry already captures the underlying breach (via
 * `captureMessage("rate_limit_redis_failure_threshold_breached")` for
 * the rate-limit store, via the structured `readyz_unhealthy` log for
 * the DB watcher), so a paging-transport outage doesn't lose the
 * incident — it just means the channel/rotation didn't get the
 * duplicate notification.
 */

/**
 * Default subsystem id used when an event omits one. Kept as the
 * legacy `"rate-limit-store"` value so existing call sites and the
 * snapshot in the existing test suite stay byte-identical.
 */
const DEFAULT_SUBSYSTEM = "rate-limit-store";
const DEFAULT_LABEL = "Rate-limit store";

/**
 * Default Slack footer for a degraded message. Kept identical to the
 * previous hard-coded copy when the event is for the rate-limit store
 * so the channel formatting doesn't visibly change for that caller.
 * For other subsystems we fall back to a generic "investigate the
 * underlying dependency" line plus the runbooks directory pointer.
 */
function defaultDegradedFooter(subsystem: string): string {
  if (subsystem === DEFAULT_SUBSYSTEM) {
    return (
      "Rate-limit store is degrading open. Investigate Redis/backing " +
      "store before traffic spreads across replicas without a shared " +
      "quota. See docs/runbooks/rate-limit-store.md."
    );
  }
  if (subsystem === "db") {
    return (
      "Postgres connection is unreachable from this replica. Investigate " +
      "the DB pool, network path, and pgbouncer health before user-facing " +
      "writes start to fail. See docs/runbooks/."
    );
  }
  return (
    `${subsystemLabel(subsystem)} is degraded. Investigate the underlying ` +
    "dependency before user-facing impact spreads. See docs/runbooks/."
  );
}

function subsystemLabel(subsystem: string): string {
  if (subsystem === DEFAULT_SUBSYSTEM) return DEFAULT_LABEL;
  if (subsystem === "db") return "Database";
  // Fallback: humanise `kebab-case` → `Title Case` so an unrecognised
  // subsystem still produces a readable Slack title without anyone
  // having to update this file before adding a new caller.
  return subsystem
    .split(/[-_]/)
    .filter((s) => s.length > 0)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

export interface DegradedTransitionEvent {
  /**
   * Stable subsystem id used to build PagerDuty's `dedup_key` and the
   * Slack title. Defaults to `"rate-limit-store"` so existing
   * rate-limit callers can omit it and stay byte-identical.
   */
  subsystem?: string;
  /**
   * Optional human label override for the Slack title. Defaults to a
   * label derived from `subsystem` (e.g. `"Database"` for `"db"`).
   */
  label?: string;
  failureCount: number;
  /**
   * Optional per-minute breach threshold. Only set by the rate-limit
   * watcher today (it tracks a rolling 60s breach detector for Sentry
   * telemetry). Other subsystems — like the DB watcher — page on a
   * pure healthy↔degraded edge with no per-minute threshold concept,
   * so they omit this field and the Slack panel just doesn't render
   * the "Threshold (per minute)" row.
   */
  threshold?: number;
  /** ms epoch when the streak began. */
  firstFailureAt: number;
  /** ms epoch when the breach was detected (i.e. now). */
  breachedAt: number;
}

export interface RecoveredTransitionEvent {
  subsystem?: string;
  label?: string;
  /** Length of the breached streak in ms. */
  durationMs: number;
  /** Number of failures observed during the streak. */
  failureCount: number;
  /** ms epoch when the recovery was observed. */
  recoveredAt: number;
}

/**
 * Fired exactly once per stuck-degraded streak when the streak's
 * duration crosses `RATE_LIMIT_DEGRADED_DURATION_PAGE_MS` (default
 * 10 min). Distinct from `DegradedTransitionEvent` because the
 * underlying signal is "this incident has been going on too long",
 * not "we just crossed healthy→degraded". The notifier uses a
 * dedup_key namespaced to `rate-limit-store-degraded-duration:` so
 * it cannot collide with the transition page.
 *
 * Why this exists (see task #144 / docs/runbooks/rate-limit-store.md):
 * the transition page fires on the moment Redis flaps unhealthy, but a
 * slow-burn outage that never crosses the per-minute Sentry rate
 * threshold (or a streak the in-process detector keeps in `degraded`
 * for many minutes) currently has no out-of-band paging signal —
 * `scripts/checkHealthzDegraded.ts` exits non-zero in CI but doesn't
 * reach Slack / PagerDuty. This event closes that gap from inside
 * the api-server process.
 *
 * The event currently only carries rate-limit-store data — the
 * duration-page builders below intentionally do NOT use the
 * `eventSubsystem`/`eventLabel` generalisation that the transition
 * builders adopted, because today there's only one caller and the
 * dedup_key namespace + Slack copy are deliberately rate-limit
 * specific. Adding the `subsystem`/`label` fields here would suggest
 * the duration page already supports other subsystems, which it does
 * not. Generalising it is a clean follow-up if/when the DB watcher
 * (or another caller) wants its own duration page.
 */
export interface DegradedDurationTransitionEvent {
  /** ms epoch when the streak began (set on the first failure). */
  firstFailureAt: number;
  /** Number of failures observed in the streak so far. */
  failureCount: number;
  /** Configured duration threshold in ms (e.g. 600_000). */
  durationThresholdMs: number;
  /** Actual streak duration when the page fired (>= durationThresholdMs). */
  durationMs: number;
  /** ms epoch when the duration probe noticed the breach (i.e. now). */
  pagedAt: number;
}

/**
 * Paired recovery event for `DegradedDurationTransitionEvent`. Only
 * fired when the streak that recovered actually crossed the duration
 * threshold (i.e. on-call was paged). Sub-threshold blips never page,
 * so they have no duration-recovery to emit either — those streaks
 * close via the regular `RecoveredTransitionEvent`.
 */
export interface DegradedDurationRecoveredEvent {
  /** Total duration of the breached streak in ms. */
  durationMs: number;
  /** Number of failures observed during the streak. */
  failureCount: number;
  /** ms epoch when the recovery was observed. */
  recoveredAt: number;
}

/**
 * Generic out-of-band incident notifier interface. Kept under the
 * legacy `RateLimitIncidentNotifier` name so existing imports
 * (`apiRateLimit.ts`, the rate-limit unit tests) stay unchanged; the
 * new `IncidentNotifier` alias is the recommended name for new
 * callers that want to make it obvious the notifier isn't rate-limit
 * specific. The `notifyDegraded`/`notifyRecovered` pair is fully
 * subsystem-aware (DB watcher, etc.); the duration-page pair is
 * rate-limit specific for now (see `DegradedDurationTransitionEvent`).
 */
export interface RateLimitIncidentNotifier {
  notifyDegraded(event: DegradedTransitionEvent): void;
  notifyRecovered(event: RecoveredTransitionEvent): void;
  /**
   * Out-of-band page when the rate-limit store has been stuck in
   * `degraded` for longer than the configured duration threshold.
   * Fires AT MOST ONCE per stuck-degraded streak — the watcher gates
   * on a per-incident flag so a slow-burn outage doesn't spam on-call
   * with a fresh page on every additional failure.
   */
  notifyDegradedDuration(event: DegradedDurationTransitionEvent): void;
  /**
   * Paired resolve for `notifyDegradedDuration`. Only fires when a
   * duration-page actually fired during the closing streak — keeps
   * the duration channel's incident timeline self-closing without
   * coupling to the transition page's `dedup_key`.
   */
  notifyDegradedDurationRecovered(
    event: DegradedDurationRecoveredEvent,
  ): void;
}
export type IncidentNotifier = RateLimitIncidentNotifier;

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

function eventSubsystem(
  event: { subsystem?: string },
): string {
  const raw = (event.subsystem ?? "").trim();
  return raw === "" ? DEFAULT_SUBSYSTEM : raw;
}

function eventLabel(event: { subsystem?: string; label?: string }): string {
  const raw = (event.label ?? "").trim();
  if (raw !== "") return raw;
  return subsystemLabel(eventSubsystem(event));
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
  const subsystem = eventSubsystem(event);
  const label = eventLabel(event);
  const startedIso = new Date(event.firstFailureAt).toISOString();
  const fields: Array<{ title: string; value: string; short: boolean }> = [
    { title: "Source", value: source, short: true },
    { title: "Failure count", value: String(event.failureCount), short: true },
  ];
  if (typeof event.threshold === "number") {
    fields.push({
      title: "Threshold (per minute)",
      value: String(event.threshold),
      short: true,
    });
  }
  fields.push({ title: "Streak began", value: startedIso, short: true });
  return JSON.stringify({
    text: `:rotating_light: ${label} DEGRADED on ${source}`,
    attachments: [
      {
        color: "danger",
        fields,
        footer: defaultDegradedFooter(subsystem),
      },
    ],
  });
}

export function buildSlackRecoveredPayload(
  event: RecoveredTransitionEvent,
  source: string,
): string {
  const label = eventLabel(event);
  const recoveredIso = new Date(event.recoveredAt).toISOString();
  const durationSeconds = Math.max(1, Math.round(event.durationMs / 1000));
  return JSON.stringify({
    text: `:white_check_mark: ${label} RECOVERED on ${source}`,
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
 * `dedup_key` so a flapping subsystem inside the same logical
 * incident groups under one PagerDuty incident instead of opening a
 * new one per transition. The trigger and resolve events share the
 * same key so PagerDuty closes the incident automatically on
 * recovery. Different subsystems get different `dedup_key` prefixes
 * (e.g. `rate-limit-store-degraded:` vs `db-degraded:`) so a
 * concurrent rate-limit and DB outage open as two distinct PagerDuty
 * incidents instead of being squashed into one.
 */
export function buildPagerDutyDegradedPayload(
  event: DegradedTransitionEvent,
  source: string,
  routingKey: string,
): string {
  const subsystem = eventSubsystem(event);
  const label = eventLabel(event);
  const summary =
    typeof event.threshold === "number"
      ? `${label} degraded on ${source} (${event.failureCount} failures, threshold ${event.threshold}/min)`
      : `${label} degraded on ${source} (${event.failureCount} failures)`;
  const customDetails: Record<string, unknown> = {
    failureCount: event.failureCount,
    firstFailureAt: event.firstFailureAt,
    breachedAt: event.breachedAt,
  };
  if (typeof event.threshold === "number") {
    customDetails.threshold = event.threshold;
  }
  return JSON.stringify({
    routing_key: routingKey,
    event_action: "trigger",
    dedup_key: `${subsystem}-degraded:${source}`,
    payload: {
      summary,
      source,
      severity: "error",
      component: subsystem === DEFAULT_SUBSYSTEM ? "rate_limit_store" : subsystem,
      group: "api-server",
      class: "subsystem-degraded",
      custom_details: customDetails,
    },
  });
}

export function buildPagerDutyRecoveredPayload(
  event: RecoveredTransitionEvent,
  source: string,
  routingKey: string,
): string {
  const subsystem = eventSubsystem(event);
  return JSON.stringify({
    routing_key: routingKey,
    event_action: "resolve",
    dedup_key: `${subsystem}-degraded:${source}`,
  });
}

/**
 * Slack body for the duration-threshold page. Wording is intentionally
 * distinct from the transition page (`DEGRADED` vs `STUCK DEGRADED`)
 * so an operator scanning the channel can tell at a glance which
 * signal fired — the transition page says "we just went bad", the
 * duration page says "we've been bad too long".
 */
export function buildSlackDegradedDurationPayload(
  event: DegradedDurationTransitionEvent,
  source: string,
): string {
  const startedIso = new Date(event.firstFailureAt).toISOString();
  const durationSeconds = Math.max(1, Math.round(event.durationMs / 1000));
  const thresholdSeconds = Math.max(
    1,
    Math.round(event.durationThresholdMs / 1000),
  );
  return JSON.stringify({
    text: `:rotating_light: Rate-limit store STUCK DEGRADED on ${source} (${durationSeconds}s)`,
    attachments: [
      {
        color: "danger",
        fields: [
          { title: "Source", value: source, short: true },
          {
            title: "Streak duration",
            value: `${durationSeconds}s`,
            short: true,
          },
          {
            title: "Duration threshold",
            value: `${thresholdSeconds}s`,
            short: true,
          },
          {
            title: "Failures so far",
            value: String(event.failureCount),
            short: true,
          },
          { title: "Streak began", value: startedIso, short: true },
        ],
        footer:
          "Rate-limit store has been degraded longer than " +
          `${thresholdSeconds}s — slow-burn outage that the per-minute ` +
          "rate threshold did not catch. Investigate Redis/backing store " +
          "before the bypassable in-memory fallback shapes more traffic. " +
          "See docs/runbooks/rate-limit-store.md.",
      },
    ],
  });
}

export function buildSlackDegradedDurationRecoveredPayload(
  event: DegradedDurationRecoveredEvent,
  source: string,
): string {
  const recoveredIso = new Date(event.recoveredAt).toISOString();
  const durationSeconds = Math.max(1, Math.round(event.durationMs / 1000));
  return JSON.stringify({
    text: `:white_check_mark: Rate-limit store recovered from STUCK DEGRADED on ${source}`,
    attachments: [
      {
        color: "good",
        fields: [
          { title: "Source", value: source, short: true },
          {
            title: "Total streak duration",
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
 * PagerDuty payload for the duration-threshold page. The `dedup_key`
 * is intentionally namespaced under `rate-limit-store-degraded-duration:`
 * so it CANNOT collide with the transition page's `dedup_key`
 * (`rate-limit-store-degraded:`) — a single logical incident produces
 * two separate PagerDuty incidents (transition + duration), each with
 * its own paired resolve, and operators can route them to different
 * services / urgencies if they want. Same routing key, different
 * dedup namespace.
 */
export function buildPagerDutyDegradedDurationPayload(
  event: DegradedDurationTransitionEvent,
  source: string,
  routingKey: string,
): string {
  return JSON.stringify({
    routing_key: routingKey,
    event_action: "trigger",
    dedup_key: `rate-limit-store-degraded-duration:${source}`,
    payload: {
      summary:
        `Rate-limit store stuck DEGRADED on ${source} for ${Math.round(event.durationMs / 1000)}s ` +
        `(> ${Math.round(event.durationThresholdMs / 1000)}s threshold, ${event.failureCount} failures)`,
      source,
      severity: "error",
      component: "rate_limit_store",
      group: "api-server",
      class: "subsystem-stuck-degraded",
      custom_details: {
        firstFailureAt: event.firstFailureAt,
        failureCount: event.failureCount,
        durationThresholdMs: event.durationThresholdMs,
        durationMs: event.durationMs,
        pagedAt: event.pagedAt,
      },
    },
  });
}

export function buildPagerDutyDegradedDurationRecoveredPayload(
  _event: DegradedDurationRecoveredEvent,
  source: string,
  routingKey: string,
): string {
  return JSON.stringify({
    routing_key: routingKey,
    event_action: "resolve",
    dedup_key: `rate-limit-store-degraded-duration:${source}`,
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
    const subsystem = eventSubsystem(event);
    const slackUrl = (env.RATE_LIMIT_INCIDENT_SLACK_WEBHOOK_URL ?? "").trim();
    const pdKey = (
      env.RATE_LIMIT_INCIDENT_PAGERDUTY_ROUTING_KEY ?? ""
    ).trim();
    if (slackUrl !== "") {
      this.send(
        slackUrl,
        buildSlackDegradedPayload(event, source),
        `slack_degraded:${subsystem}`,
      );
    }
    if (pdKey !== "") {
      this.send(
        pagerDutyUrl(env),
        buildPagerDutyDegradedPayload(event, source, pdKey),
        `pagerduty_degraded:${subsystem}`,
      );
    }
  }

  notifyRecovered(event: RecoveredTransitionEvent): void {
    const env = this.env();
    const source = incidentSource(env);
    const subsystem = eventSubsystem(event);
    const slackUrl = (env.RATE_LIMIT_INCIDENT_SLACK_WEBHOOK_URL ?? "").trim();
    const pdKey = (
      env.RATE_LIMIT_INCIDENT_PAGERDUTY_ROUTING_KEY ?? ""
    ).trim();
    if (slackUrl !== "") {
      this.send(
        slackUrl,
        buildSlackRecoveredPayload(event, source),
        `slack_recovered:${subsystem}`,
      );
    }
    if (pdKey !== "") {
      this.send(
        pagerDutyUrl(env),
        buildPagerDutyRecoveredPayload(event, source, pdKey),
        `pagerduty_recovered:${subsystem}`,
      );
    }
  }

  notifyDegradedDuration(event: DegradedDurationTransitionEvent): void {
    const env = this.env();
    const source = incidentSource(env);
    const slackUrl = (env.RATE_LIMIT_INCIDENT_SLACK_WEBHOOK_URL ?? "").trim();
    const pdKey = (
      env.RATE_LIMIT_INCIDENT_PAGERDUTY_ROUTING_KEY ?? ""
    ).trim();
    if (slackUrl !== "") {
      this.send(
        slackUrl,
        buildSlackDegradedDurationPayload(event, source),
        "slack_degraded_duration",
      );
    }
    if (pdKey !== "") {
      this.send(
        pagerDutyUrl(env),
        buildPagerDutyDegradedDurationPayload(event, source, pdKey),
        "pagerduty_degraded_duration",
      );
    }
  }

  notifyDegradedDurationRecovered(
    event: DegradedDurationRecoveredEvent,
  ): void {
    const env = this.env();
    const source = incidentSource(env);
    const slackUrl = (env.RATE_LIMIT_INCIDENT_SLACK_WEBHOOK_URL ?? "").trim();
    const pdKey = (
      env.RATE_LIMIT_INCIDENT_PAGERDUTY_ROUTING_KEY ?? ""
    ).trim();
    if (slackUrl !== "") {
      this.send(
        slackUrl,
        buildSlackDegradedDurationRecoveredPayload(event, source),
        "slack_degraded_duration_recovered",
      );
    }
    if (pdKey !== "") {
      this.send(
        pagerDutyUrl(env),
        buildPagerDutyDegradedDurationRecoveredPayload(event, source, pdKey),
        "pagerduty_degraded_duration_recovered",
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
  notifyDegradedDuration() {},
  notifyDegradedDurationRecovered() {},
};
