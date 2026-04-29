import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  WebhookIncidentNotifier,
  buildPagerDutyDegradedPayload,
  buildPagerDutyRecoveredPayload,
  buildSlackDegradedPayload,
  buildSlackRecoveredPayload,
  type WebhookFetch,
} from "./incidentNotifier";

interface CapturedCall {
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

function makeRecorder(opts?: {
  ok?: boolean;
  status?: number;
  reject?: Error;
}): { fetchImpl: WebhookFetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl: WebhookFetch = async (url, init) => {
    calls.push({
      url,
      headers: init.headers,
      body: JSON.parse(init.body) as unknown,
    });
    if (opts?.reject) throw opts.reject;
    return {
      ok: opts?.ok ?? true,
      status: opts?.status ?? 200,
      statusText: "OK",
    };
  };
  return { fetchImpl, calls };
}

/**
 * Drain the microtask queue so the fire-and-forget POSTs scheduled by
 * `notifyDegraded` / `notifyRecovered` resolve before the assertions
 * run. We don't await the notifier's promises directly because the
 * production code path is intentionally fire-and-forget — exposing
 * them would tempt callers to await and pin the watcher's bump
 * latency to the webhook RTT.
 */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe("WebhookIncidentNotifier — env-driven configuration", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("no-ops when neither Slack nor PagerDuty is configured", async () => {
    const { fetchImpl, calls } = makeRecorder();
    const notifier = new WebhookIncidentNotifier({
      fetchImpl,
      env: {
        // Neither RATE_LIMIT_INCIDENT_SLACK_WEBHOOK_URL nor
        // RATE_LIMIT_INCIDENT_PAGERDUTY_ROUTING_KEY set.
      },
    });
    notifier.notifyDegraded({
      failureCount: 5,
      threshold: 5,
      firstFailureAt: 1_700_000_000_000,
      breachedAt: 1_700_000_010_000,
    });
    notifier.notifyRecovered({
      durationMs: 30_000,
      failureCount: 5,
      recoveredAt: 1_700_000_040_000,
    });
    await flushAsync();
    expect(calls).toEqual([]);
  });

  it("treats whitespace-only env values as unset (no-op)", async () => {
    const { fetchImpl, calls } = makeRecorder();
    const notifier = new WebhookIncidentNotifier({
      fetchImpl,
      env: {
        RATE_LIMIT_INCIDENT_SLACK_WEBHOOK_URL: "   ",
        RATE_LIMIT_INCIDENT_PAGERDUTY_ROUTING_KEY: "\t",
      },
    });
    notifier.notifyDegraded({
      failureCount: 5,
      threshold: 5,
      firstFailureAt: 1_700_000_000_000,
      breachedAt: 1_700_000_010_000,
    });
    await flushAsync();
    expect(calls).toEqual([]);
  });

  it("posts Slack only when only Slack is configured", async () => {
    const { fetchImpl, calls } = makeRecorder();
    const notifier = new WebhookIncidentNotifier({
      fetchImpl,
      env: {
        RATE_LIMIT_INCIDENT_SLACK_WEBHOOK_URL:
          "https://hooks.slack.example/services/T/B/secret",
        RATE_LIMIT_INCIDENT_SOURCE: "test-source",
      },
    });
    notifier.notifyDegraded({
      failureCount: 7,
      threshold: 5,
      firstFailureAt: 1_700_000_000_000,
      breachedAt: 1_700_000_010_000,
    });
    await flushAsync();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://hooks.slack.example/services/T/B/secret",
    );
    expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
    expect(calls[0]!.body).toMatchObject({
      text: expect.stringContaining("DEGRADED"),
    });
  });

  it("posts PagerDuty only when only PagerDuty is configured", async () => {
    const { fetchImpl, calls } = makeRecorder();
    const notifier = new WebhookIncidentNotifier({
      fetchImpl,
      env: {
        RATE_LIMIT_INCIDENT_PAGERDUTY_ROUTING_KEY: "pd-routing-key-xyz",
        RATE_LIMIT_INCIDENT_SOURCE: "prod-replica-7",
      },
    });
    notifier.notifyDegraded({
      failureCount: 5,
      threshold: 5,
      firstFailureAt: 1_700_000_000_000,
      breachedAt: 1_700_000_010_000,
    });
    await flushAsync();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://events.pagerduty.com/v2/enqueue");
    expect(calls[0]!.body).toMatchObject({
      routing_key: "pd-routing-key-xyz",
      event_action: "trigger",
      dedup_key: "rate-limit-store-degraded:prod-replica-7",
    });
  });

  it("posts to BOTH targets when both are configured", async () => {
    const { fetchImpl, calls } = makeRecorder();
    const notifier = new WebhookIncidentNotifier({
      fetchImpl,
      env: {
        RATE_LIMIT_INCIDENT_SLACK_WEBHOOK_URL: "https://slack.example/hook",
        RATE_LIMIT_INCIDENT_PAGERDUTY_ROUTING_KEY: "pd-key",
        RATE_LIMIT_INCIDENT_SOURCE: "prod-7",
      },
    });
    notifier.notifyDegraded({
      failureCount: 5,
      threshold: 5,
      firstFailureAt: 1_700_000_000_000,
      breachedAt: 1_700_000_010_000,
    });
    await flushAsync();
    expect(calls).toHaveLength(2);
    const urls = calls.map((c) => c.url);
    expect(urls).toContain("https://slack.example/hook");
    expect(urls).toContain("https://events.pagerduty.com/v2/enqueue");
  });

  it("uses RATE_LIMIT_INCIDENT_PAGERDUTY_URL override when set", async () => {
    const { fetchImpl, calls } = makeRecorder();
    const notifier = new WebhookIncidentNotifier({
      fetchImpl,
      env: {
        RATE_LIMIT_INCIDENT_PAGERDUTY_ROUTING_KEY: "pd-key",
        RATE_LIMIT_INCIDENT_PAGERDUTY_URL: "https://mock.local/pd",
      },
    });
    notifier.notifyDegraded({
      failureCount: 5,
      threshold: 5,
      firstFailureAt: 1_700_000_000_000,
      breachedAt: 1_700_000_010_000,
    });
    await flushAsync();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://mock.local/pd");
  });

  it("falls back to HOSTNAME for source when RATE_LIMIT_INCIDENT_SOURCE unset", async () => {
    const { fetchImpl, calls } = makeRecorder();
    const notifier = new WebhookIncidentNotifier({
      fetchImpl,
      env: {
        RATE_LIMIT_INCIDENT_PAGERDUTY_ROUTING_KEY: "pd-key",
        HOSTNAME: "hostname-fallback",
      },
    });
    notifier.notifyDegraded({
      failureCount: 5,
      threshold: 5,
      firstFailureAt: 1_700_000_000_000,
      breachedAt: 1_700_000_010_000,
    });
    await flushAsync();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({
      dedup_key: "rate-limit-store-degraded:hostname-fallback",
      payload: { source: "hostname-fallback" },
    });
  });
});

describe("WebhookIncidentNotifier — recovery", () => {
  it("uses event_action=resolve with the matching dedup_key on PagerDuty", async () => {
    const { fetchImpl, calls } = makeRecorder();
    const notifier = new WebhookIncidentNotifier({
      fetchImpl,
      env: {
        RATE_LIMIT_INCIDENT_PAGERDUTY_ROUTING_KEY: "pd-key",
        RATE_LIMIT_INCIDENT_SOURCE: "prod-7",
      },
    });
    notifier.notifyRecovered({
      durationMs: 12_500,
      failureCount: 9,
      recoveredAt: 1_700_000_050_000,
    });
    await flushAsync();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({
      routing_key: "pd-key",
      event_action: "resolve",
      dedup_key: "rate-limit-store-degraded:prod-7",
    });
  });

  it("posts a Slack 'recovered' message with duration formatting", async () => {
    const { fetchImpl, calls } = makeRecorder();
    const notifier = new WebhookIncidentNotifier({
      fetchImpl,
      env: {
        RATE_LIMIT_INCIDENT_SLACK_WEBHOOK_URL: "https://slack.example/hook",
        RATE_LIMIT_INCIDENT_SOURCE: "prod-7",
      },
    });
    notifier.notifyRecovered({
      durationMs: 12_500,
      failureCount: 9,
      recoveredAt: 1_700_000_050_000,
    });
    await flushAsync();
    expect(calls).toHaveLength(1);
    const body = calls[0]!.body as {
      text: string;
      attachments: Array<{
        fields: Array<{ title: string; value: string }>;
      }>;
    };
    expect(body.text).toContain("RECOVERED");
    const fieldMap = Object.fromEntries(
      body.attachments[0]!.fields.map((f) => [f.title, f.value]),
    );
    // 12_500 ms → 13s (rounded).
    expect(fieldMap.Duration).toBe("13s");
    expect(fieldMap["Failures during streak"]).toBe("9");
  });
});

describe("WebhookIncidentNotifier — failure handling", () => {
  it("does not throw when fetch rejects (fire-and-forget)", async () => {
    const { fetchImpl } = makeRecorder({
      reject: new Error("network down"),
    });
    const notifier = new WebhookIncidentNotifier({
      fetchImpl,
      env: {
        RATE_LIMIT_INCIDENT_SLACK_WEBHOOK_URL: "https://slack.example/hook",
      },
    });
    expect(() =>
      notifier.notifyDegraded({
        failureCount: 5,
        threshold: 5,
        firstFailureAt: 1,
        breachedAt: 2,
      }),
    ).not.toThrow();
    await flushAsync();
  });

  it("does not throw on non-2xx response (fire-and-forget)", async () => {
    const { fetchImpl } = makeRecorder({ ok: false, status: 500 });
    const notifier = new WebhookIncidentNotifier({
      fetchImpl,
      env: {
        RATE_LIMIT_INCIDENT_PAGERDUTY_ROUTING_KEY: "pd-key",
      },
    });
    expect(() =>
      notifier.notifyRecovered({
        durationMs: 1,
        failureCount: 1,
        recoveredAt: 1,
      }),
    ).not.toThrow();
    await flushAsync();
  });
});

describe("payload builders — pure functions", () => {
  it("buildSlackDegradedPayload includes failure and threshold", () => {
    const body = JSON.parse(
      buildSlackDegradedPayload(
        {
          failureCount: 7,
          threshold: 5,
          firstFailureAt: 1_700_000_000_000,
          breachedAt: 1_700_000_010_000,
        },
        "src",
      ),
    ) as {
      text: string;
      attachments: Array<{
        color: string;
        fields: Array<{ title: string; value: string }>;
      }>;
    };
    expect(body.text).toContain("DEGRADED");
    expect(body.text).toContain("src");
    expect(body.attachments[0]!.color).toBe("danger");
    const fieldMap = Object.fromEntries(
      body.attachments[0]!.fields.map((f) => [f.title, f.value]),
    );
    expect(fieldMap["Failure count"]).toBe("7");
    expect(fieldMap["Threshold (per minute)"]).toBe("5");
  });

  it("buildSlackRecoveredPayload uses the 'good' colour", () => {
    const body = JSON.parse(
      buildSlackRecoveredPayload(
        { durationMs: 1_000, failureCount: 1, recoveredAt: 1 },
        "src",
      ),
    ) as {
      attachments: Array<{ color: string }>;
    };
    expect(body.attachments[0]!.color).toBe("good");
  });

  it("buildPagerDutyDegradedPayload uses error severity and stable dedup_key", () => {
    const body = JSON.parse(
      buildPagerDutyDegradedPayload(
        {
          failureCount: 7,
          threshold: 5,
          firstFailureAt: 1_700_000_000_000,
          breachedAt: 1_700_000_010_000,
        },
        "prod-7",
        "pd-key",
      ),
    ) as {
      routing_key: string;
      event_action: string;
      dedup_key: string;
      payload: { severity: string; source: string };
    };
    expect(body.routing_key).toBe("pd-key");
    expect(body.event_action).toBe("trigger");
    expect(body.dedup_key).toBe("rate-limit-store-degraded:prod-7");
    expect(body.payload.severity).toBe("error");
    expect(body.payload.source).toBe("prod-7");
  });

  it("uses a per-subsystem dedup_key prefix and Slack title when subsystem is tagged", () => {
    // The DB watcher (and any other future caller) tags its events
    // with `subsystem: "db"` so PagerDuty groups DB incidents under
    // their own `db-degraded:<source>` dedup_key — concurrent DB and
    // rate-limit outages must open as two distinct PagerDuty
    // incidents instead of being squashed into one. The Slack title
    // and PagerDuty summary swap to the subsystem's human label.
    const dbBody = JSON.parse(
      buildPagerDutyDegradedPayload(
        {
          subsystem: "db",
          label: "Database",
          failureCount: 3,
          firstFailureAt: 1_700_000_000_000,
          breachedAt: 1_700_000_010_000,
        },
        "prod-7",
        "pd-key",
      ),
    ) as {
      dedup_key: string;
      payload: {
        summary: string;
        component: string;
        custom_details: Record<string, unknown>;
      };
    };
    expect(dbBody.dedup_key).toBe("db-degraded:prod-7");
    expect(dbBody.payload.summary).toContain("Database");
    expect(dbBody.payload.summary).toContain("3 failures");
    // No "threshold" field in the summary when the event omits it —
    // the DB watcher pages on a pure healthy↔degraded edge with no
    // per-minute threshold concept.
    expect(dbBody.payload.summary).not.toContain("threshold");
    expect(dbBody.payload.component).toBe("db");
    expect(dbBody.payload.custom_details).not.toHaveProperty("threshold");

    const dbResolve = JSON.parse(
      buildPagerDutyRecoveredPayload(
        {
          subsystem: "db",
          label: "Database",
          durationMs: 30_000,
          failureCount: 3,
          recoveredAt: 1_700_000_030_000,
        },
        "prod-7",
        "pd-key",
      ),
    ) as { dedup_key: string; event_action: string };
    // Trigger and resolve must share the same dedup_key so PagerDuty
    // closes the incident automatically on recovery.
    expect(dbResolve.dedup_key).toBe("db-degraded:prod-7");
    expect(dbResolve.event_action).toBe("resolve");

    const slackBody = JSON.parse(
      buildSlackDegradedPayload(
        {
          subsystem: "db",
          label: "Database",
          failureCount: 3,
          firstFailureAt: 1_700_000_000_000,
          breachedAt: 1_700_000_010_000,
        },
        "prod-7",
      ),
    ) as {
      text: string;
      attachments: Array<{
        fields: Array<{ title: string; value: string }>;
      }>;
    };
    expect(slackBody.text).toContain("Database DEGRADED");
    expect(slackBody.text).toContain("prod-7");
    // No "Threshold (per minute)" Slack field when the event omits
    // the threshold — the panel just doesn't render that row.
    const fieldTitles = slackBody.attachments[0]!.fields.map((f) => f.title);
    expect(fieldTitles).not.toContain("Threshold (per minute)");
  });

  it("buildPagerDutyRecoveredPayload mirrors the trigger dedup_key", () => {
    const trigger = JSON.parse(
      buildPagerDutyDegradedPayload(
        {
          failureCount: 5,
          threshold: 5,
          firstFailureAt: 1,
          breachedAt: 2,
        },
        "prod-7",
        "pd-key",
      ),
    ) as { dedup_key: string };
    const resolve = JSON.parse(
      buildPagerDutyRecoveredPayload(
        { durationMs: 1, failureCount: 1, recoveredAt: 3 },
        "prod-7",
        "pd-key",
      ),
    ) as { dedup_key: string; event_action: string };
    expect(resolve.dedup_key).toBe(trigger.dedup_key);
    expect(resolve.event_action).toBe("resolve");
  });
});
