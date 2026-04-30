import { describe, it, expect } from "vitest";
import {
  WebhookSubsystemAlertNotifier,
  buildPagerDutyDegradedPayload,
  buildPagerDutyRecoveredPayload,
  buildSlackDegradedPayload,
  buildSlackRecoveredPayload,
  type WebhookFetch,
} from "./subsystemAlertNotifier";

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

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const SAMPLE_DEGRADED = {
  subsystem: "payment-gateway:paystack",
  label: "paystack payment gateway",
  firstFailureAt: 1_700_000_000_000,
  detectedAt: 1_700_000_000_000,
  details: { gateway: "paystack" },
};

const SAMPLE_RECOVERED = {
  subsystem: "payment-gateway:paystack",
  label: "paystack payment gateway",
  recoveredAt: 1_700_000_300_000,
  durationMs: 300_000,
  details: { gateway: "paystack" },
};

describe("WebhookSubsystemAlertNotifier — env-driven configuration", () => {
  it("no-ops when neither Slack nor PagerDuty is configured", async () => {
    const { fetchImpl, calls } = makeRecorder();
    const notifier = new WebhookSubsystemAlertNotifier({ fetchImpl, env: {} });
    notifier.notifyDegraded(SAMPLE_DEGRADED);
    notifier.notifyRecovered(SAMPLE_RECOVERED);
    await flushAsync();
    expect(calls).toEqual([]);
  });

  it("treats whitespace-only env values as unset", async () => {
    const { fetchImpl, calls } = makeRecorder();
    const notifier = new WebhookSubsystemAlertNotifier({
      fetchImpl,
      env: {
        SUBSYSTEM_ALERT_SLACK_WEBHOOK_URL: "   ",
        SUBSYSTEM_ALERT_PAGERDUTY_ROUTING_KEY: "\t",
      },
    });
    notifier.notifyDegraded(SAMPLE_DEGRADED);
    await flushAsync();
    expect(calls).toEqual([]);
  });

  it("posts Slack only when only Slack is configured", async () => {
    const { fetchImpl, calls } = makeRecorder();
    const notifier = new WebhookSubsystemAlertNotifier({
      fetchImpl,
      env: {
        SUBSYSTEM_ALERT_SLACK_WEBHOOK_URL: "https://slack.example/hook",
        SUBSYSTEM_ALERT_SOURCE: "test-source",
      },
    });
    notifier.notifyDegraded(SAMPLE_DEGRADED);
    await flushAsync();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://slack.example/hook");
    expect(calls[0]!.body).toMatchObject({
      text: expect.stringContaining("DEGRADED"),
    });
  });

  it("posts to BOTH targets when both are configured", async () => {
    const { fetchImpl, calls } = makeRecorder();
    const notifier = new WebhookSubsystemAlertNotifier({
      fetchImpl,
      env: {
        SUBSYSTEM_ALERT_SLACK_WEBHOOK_URL: "https://slack.example/hook",
        SUBSYSTEM_ALERT_PAGERDUTY_ROUTING_KEY: "pd-key",
        SUBSYSTEM_ALERT_SOURCE: "prod-7",
      },
    });
    notifier.notifyDegraded(SAMPLE_DEGRADED);
    await flushAsync();
    expect(calls).toHaveLength(2);
    const urls = calls.map((c) => c.url);
    expect(urls).toContain("https://slack.example/hook");
    expect(urls).toContain("https://events.pagerduty.com/v2/enqueue");
  });

  it("falls back to RATE_LIMIT_INCIDENT_* env vars so existing wiring covers new subsystems", async () => {
    const { fetchImpl, calls } = makeRecorder();
    const notifier = new WebhookSubsystemAlertNotifier({
      fetchImpl,
      env: {
        // Only the legacy rate-limit names are set — the new generic
        // notifier should still reach Slack/PagerDuty via fallback.
        RATE_LIMIT_INCIDENT_SLACK_WEBHOOK_URL: "https://slack.example/legacy",
        RATE_LIMIT_INCIDENT_PAGERDUTY_ROUTING_KEY: "legacy-pd-key",
        RATE_LIMIT_INCIDENT_SOURCE: "prod-legacy",
      },
    });
    notifier.notifyDegraded(SAMPLE_DEGRADED);
    await flushAsync();
    expect(calls).toHaveLength(2);
    const urls = calls.map((c) => c.url);
    expect(urls).toContain("https://slack.example/legacy");
    const pdCall = calls.find((c) =>
      c.url.includes("pagerduty"),
    );
    expect(pdCall).toBeDefined();
    expect(pdCall!.body).toMatchObject({
      routing_key: "legacy-pd-key",
      dedup_key: "subsystem-degraded:payment-gateway:paystack:prod-legacy",
    });
  });

  it("prefers SUBSYSTEM_ALERT_* over RATE_LIMIT_INCIDENT_* when both set", async () => {
    const { fetchImpl, calls } = makeRecorder();
    const notifier = new WebhookSubsystemAlertNotifier({
      fetchImpl,
      env: {
        SUBSYSTEM_ALERT_SLACK_WEBHOOK_URL: "https://slack.example/preferred",
        RATE_LIMIT_INCIDENT_SLACK_WEBHOOK_URL: "https://slack.example/legacy",
        SUBSYSTEM_ALERT_SOURCE: "preferred-source",
      },
    });
    notifier.notifyDegraded(SAMPLE_DEGRADED);
    await flushAsync();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://slack.example/preferred");
  });

  it("uses RATE_LIMIT_INCIDENT_PAGERDUTY_URL fallback for endpoint override", async () => {
    const { fetchImpl, calls } = makeRecorder();
    const notifier = new WebhookSubsystemAlertNotifier({
      fetchImpl,
      env: {
        SUBSYSTEM_ALERT_PAGERDUTY_ROUTING_KEY: "pd-key",
        RATE_LIMIT_INCIDENT_PAGERDUTY_URL: "https://mock.local/pd-legacy",
      },
    });
    notifier.notifyDegraded(SAMPLE_DEGRADED);
    await flushAsync();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://mock.local/pd-legacy");
  });

  it("falls back to HOSTNAME for source when no explicit source set", async () => {
    const { fetchImpl, calls } = makeRecorder();
    const notifier = new WebhookSubsystemAlertNotifier({
      fetchImpl,
      env: {
        SUBSYSTEM_ALERT_PAGERDUTY_ROUTING_KEY: "pd-key",
        HOSTNAME: "hostname-fallback",
      },
    });
    notifier.notifyDegraded(SAMPLE_DEGRADED);
    await flushAsync();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({
      dedup_key:
        "subsystem-degraded:payment-gateway:paystack:hostname-fallback",
      payload: { source: "hostname-fallback" },
    });
  });
});

describe("WebhookSubsystemAlertNotifier — recovery", () => {
  it("uses event_action=resolve with the matching dedup_key on PagerDuty", async () => {
    const { fetchImpl, calls } = makeRecorder();
    const notifier = new WebhookSubsystemAlertNotifier({
      fetchImpl,
      env: {
        SUBSYSTEM_ALERT_PAGERDUTY_ROUTING_KEY: "pd-key",
        SUBSYSTEM_ALERT_SOURCE: "prod-7",
      },
    });
    notifier.notifyRecovered(SAMPLE_RECOVERED);
    await flushAsync();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({
      routing_key: "pd-key",
      event_action: "resolve",
      dedup_key: "subsystem-degraded:payment-gateway:paystack:prod-7",
    });
  });

  it("posts a Slack 'recovered' message with duration formatting", async () => {
    const { fetchImpl, calls } = makeRecorder();
    const notifier = new WebhookSubsystemAlertNotifier({
      fetchImpl,
      env: {
        SUBSYSTEM_ALERT_SLACK_WEBHOOK_URL: "https://slack.example/hook",
        SUBSYSTEM_ALERT_SOURCE: "prod-7",
      },
    });
    notifier.notifyRecovered({
      ...SAMPLE_RECOVERED,
      durationMs: 12_500,
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
    expect(fieldMap.Duration).toBe("13s");
  });
});

describe("WebhookSubsystemAlertNotifier — failure handling", () => {
  it("does not throw when fetch rejects (fire-and-forget)", async () => {
    const { fetchImpl } = makeRecorder({ reject: new Error("network down") });
    const notifier = new WebhookSubsystemAlertNotifier({
      fetchImpl,
      env: { SUBSYSTEM_ALERT_SLACK_WEBHOOK_URL: "https://slack.example/hook" },
    });
    expect(() => notifier.notifyDegraded(SAMPLE_DEGRADED)).not.toThrow();
    await flushAsync();
  });

  it("does not throw on non-2xx response", async () => {
    const { fetchImpl } = makeRecorder({ ok: false, status: 500 });
    const notifier = new WebhookSubsystemAlertNotifier({
      fetchImpl,
      env: { SUBSYSTEM_ALERT_PAGERDUTY_ROUTING_KEY: "pd-key" },
    });
    expect(() => notifier.notifyRecovered(SAMPLE_RECOVERED)).not.toThrow();
    await flushAsync();
  });
});

describe("payload builders — pure functions", () => {
  it("buildSlackDegradedPayload includes subsystem and details", () => {
    const body = JSON.parse(
      buildSlackDegradedPayload(SAMPLE_DEGRADED, "src"),
    ) as {
      text: string;
      attachments: Array<{
        color: string;
        fields: Array<{ title: string; value: string }>;
      }>;
    };
    expect(body.text).toContain("DEGRADED");
    expect(body.text).toContain("paystack payment gateway");
    expect(body.attachments[0]!.color).toBe("danger");
    const fieldMap = Object.fromEntries(
      body.attachments[0]!.fields.map((f) => [f.title, f.value]),
    );
    expect(fieldMap.Subsystem).toBe("payment-gateway:paystack");
    expect(fieldMap.gateway).toBe("paystack");
  });

  it("buildSlackRecoveredPayload uses the 'good' colour", () => {
    const body = JSON.parse(
      buildSlackRecoveredPayload(SAMPLE_RECOVERED, "src"),
    ) as { attachments: Array<{ color: string }> };
    expect(body.attachments[0]!.color).toBe("good");
  });

  it("PagerDuty trigger and resolve share the same dedup_key", () => {
    const trigger = JSON.parse(
      buildPagerDutyDegradedPayload(SAMPLE_DEGRADED, "prod-7", "pd-key"),
    ) as { dedup_key: string; event_action: string };
    const resolve = JSON.parse(
      buildPagerDutyRecoveredPayload(SAMPLE_RECOVERED, "prod-7", "pd-key"),
    ) as { dedup_key: string; event_action: string };
    expect(trigger.event_action).toBe("trigger");
    expect(resolve.event_action).toBe("resolve");
    expect(resolve.dedup_key).toBe(trigger.dedup_key);
    expect(resolve.dedup_key).toBe(
      "subsystem-degraded:payment-gateway:paystack:prod-7",
    );
  });

  it("buildPagerDutyDegradedPayload surfaces details under custom_details", () => {
    const body = JSON.parse(
      buildPagerDutyDegradedPayload(SAMPLE_DEGRADED, "src", "pd-key"),
    ) as {
      payload: { custom_details: Record<string, unknown>; component: string };
    };
    expect(body.payload.component).toBe("payment-gateway:paystack");
    expect(body.payload.custom_details.gateway).toBe("paystack");
    expect(body.payload.custom_details.firstFailureAt).toBe(
      SAMPLE_DEGRADED.firstFailureAt,
    );
  });
});

describe("payload builders — optional runbookUrl field (task #121)", () => {
  // The dependency-probe alert monitor (lib/alerts/dependencyProbeAlerts.ts)
  // attaches a runbook link to every page so on-call sees the
  // "in-incident escape hatch" section without grepping. Existing
  // callers (rate-limit, gateway) MUST keep their current behaviour
  // when they don't pass the field — no Runbook field, no PagerDuty
  // `links` entry.

  it("Slack: omits the Runbook field when runbookUrl is undefined", () => {
    const body = JSON.parse(
      buildSlackDegradedPayload(SAMPLE_DEGRADED, "src"),
    ) as { attachments: Array<{ fields: Array<{ title: string }> }> };
    const titles = body.attachments[0]!.fields.map((f) => f.title);
    expect(titles).not.toContain("Runbook");
  });

  it("Slack: includes the Runbook field when runbookUrl is set", () => {
    const body = JSON.parse(
      buildSlackDegradedPayload(
        { ...SAMPLE_DEGRADED, runbookUrl: "https://docs.example/runbook" },
        "src",
      ),
    ) as {
      attachments: Array<{ fields: Array<{ title: string; value: string }> }>;
    };
    const fieldMap = Object.fromEntries(
      body.attachments[0]!.fields.map((f) => [f.title, f.value]),
    );
    expect(fieldMap.Runbook).toBe("https://docs.example/runbook");
  });

  it("Slack: trims whitespace-only runbookUrl as 'unset'", () => {
    const body = JSON.parse(
      buildSlackDegradedPayload(
        { ...SAMPLE_DEGRADED, runbookUrl: "   " },
        "src",
      ),
    ) as { attachments: Array<{ fields: Array<{ title: string }> }> };
    expect(
      body.attachments[0]!.fields.map((f) => f.title),
    ).not.toContain("Runbook");
  });

  it("Slack recovery payload: mirrors the Runbook field on resolve", () => {
    const body = JSON.parse(
      buildSlackRecoveredPayload(
        { ...SAMPLE_RECOVERED, runbookUrl: "https://docs.example/runbook" },
        "src",
      ),
    ) as {
      attachments: Array<{ fields: Array<{ title: string; value: string }> }>;
    };
    const fieldMap = Object.fromEntries(
      body.attachments[0]!.fields.map((f) => [f.title, f.value]),
    );
    expect(fieldMap.Runbook).toBe("https://docs.example/runbook");
  });

  it("PagerDuty: omits the top-level `links` array when runbookUrl is undefined", () => {
    const body = JSON.parse(
      buildPagerDutyDegradedPayload(SAMPLE_DEGRADED, "src", "pd-key"),
    ) as { links?: unknown };
    expect(body.links).toBeUndefined();
  });

  it("PagerDuty: emits both `links` and custom_details.runbookUrl when set", () => {
    const body = JSON.parse(
      buildPagerDutyDegradedPayload(
        { ...SAMPLE_DEGRADED, runbookUrl: "https://docs.example/runbook" },
        "src",
        "pd-key",
      ),
    ) as {
      links: Array<{ href: string; text: string }>;
      payload: { custom_details: Record<string, unknown> };
    };
    expect(body.links).toEqual([
      { href: "https://docs.example/runbook", text: "Runbook" },
    ]);
    // The mirror under custom_details exists so notification
    // pipelines that strip the top-level `links` array still surface
    // the URL as plaintext.
    expect(body.payload.custom_details.runbookUrl).toBe(
      "https://docs.example/runbook",
    );
  });
});
