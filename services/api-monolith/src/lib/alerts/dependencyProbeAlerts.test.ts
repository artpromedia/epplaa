import { describe, it, expect } from "vitest";
import {
  createDependencyProbeAlertMonitor,
  type DependencyProbeAlertMonitor,
} from "./dependencyProbeAlerts";
import type {
  SubsystemAlertNotifier,
  SubsystemDegradedEvent,
  SubsystemRecoveredEvent,
} from "./subsystemAlertNotifier";

interface DegradedCall {
  kind: "degraded";
  event: SubsystemDegradedEvent;
}
interface RecoveredCall {
  kind: "recovered";
  event: SubsystemRecoveredEvent;
}
type Call = DegradedCall | RecoveredCall;

function makeStubNotifier(): {
  notifier: SubsystemAlertNotifier;
  calls: Call[];
} {
  const calls: Call[] = [];
  const notifier: SubsystemAlertNotifier = {
    notifyDegraded(event) {
      calls.push({ kind: "degraded", event });
    },
    notifyRecovered(event) {
      calls.push({ kind: "recovered", event });
    },
  };
  return { notifier, calls };
}

function makeMonitor(opts: {
  threshold?: number;
  cooldownMs?: number;
  runbookUrl?: string;
} = {}): {
  monitor: DependencyProbeAlertMonitor;
  calls: Call[];
} {
  const { notifier, calls } = makeStubNotifier();
  const monitor = createDependencyProbeAlertMonitor({
    notifier,
    threshold: opts.threshold ?? 3,
    cooldownMs: opts.cooldownMs ?? 60_000,
    runbookUrl:
      opts.runbookUrl ??
      "docs/runbooks/readyz-dependency-probes.md#in-incident-escape-hatch-the-circuit-breaker",
  });
  return { monitor, calls };
}

describe("DependencyProbeAlertMonitor — debounce / streak semantics", () => {
  it("does not page for failures below the threshold — single transient blips are swallowed", () => {
    const { monitor, calls } = makeMonitor({ threshold: 3 });
    monitor.observe("clerk", { ok: false, error: "ECONNREFUSED" }, 1_000);
    monitor.observe("clerk", { ok: false, error: "ECONNREFUSED" }, 2_000);
    expect(calls).toEqual([]);
    // The streak state is still tracked so the next failure pushes us
    // to threshold — the debounce is "wait until N", not "ignore the
    // first N forever".
    const s = monitor.getState("clerk");
    expect(s.consecutiveFailures).toBe(2);
    expect(s.firstFailureAt).toBe(1_000);
    expect(s.incidentOpen).toBe(false);
    expect(s.degradedNotifiedAt).toBeNull();
  });

  it("pages exactly once when the consecutive-failure threshold is crossed", () => {
    const { monitor, calls } = makeMonitor({ threshold: 3 });
    monitor.observe("clerk", { ok: false, error: "x" }, 1_000);
    monitor.observe("clerk", { ok: false, error: "x" }, 2_000);
    monitor.observe(
      "clerk",
      { ok: false, error: "http_probe_timeout_after_2000ms" },
      3_000,
    );
    // Subsequent failures within the same streak update internal
    // state but MUST NOT re-page — matches the rate-limit and
    // gateway monitors' "exactly once per healthy→degraded
    // transition" contract.
    monitor.observe("clerk", { ok: false, error: "x" }, 4_000);
    monitor.observe("clerk", { ok: false, error: "x" }, 5_000);
    expect(calls.filter((c) => c.kind === "degraded")).toHaveLength(1);
    const event = (calls[0] as DegradedCall).event;
    expect(event.subsystem).toBe("dependency-probe:clerk");
    expect(event.label).toBe("clerk dependency probe");
    expect(event.firstFailureAt).toBe(1_000);
    expect(event.detectedAt).toBe(3_000);
    // The freshest failure marker (the third failure) is what we
    // surface to on-call — not the first — so the pager sees the
    // current cause.
    expect(event.details).toMatchObject({
      probe: "clerk",
      failureMarker: "http_probe_timeout_after_2000ms",
      consecutiveFailures: 3,
      threshold: 3,
    });
  });

  it("includes the runbook link in the degraded payload so on-call can disable the probe immediately", () => {
    const { monitor, calls } = makeMonitor({
      threshold: 1,
      runbookUrl: "https://example/docs/runbook#disable",
    });
    monitor.observe("paystack", { ok: false, error: "boom" }, 1_000);
    expect(calls).toHaveLength(1);
    expect((calls[0] as DegradedCall).event.runbookUrl).toBe(
      "https://example/docs/runbook#disable",
    );
  });

  it("a single ok result clears the streak BEFORE the threshold is reached — no page is fired", () => {
    const { monitor, calls } = makeMonitor({ threshold: 3 });
    monitor.observe("paystack", { ok: false, error: "x" }, 1_000);
    monitor.observe("paystack", { ok: false, error: "x" }, 2_000);
    monitor.observe("paystack", { ok: true }, 3_000);
    // Counter resets, no degraded page emitted, AND no recovery page
    // (because we never paged degraded for this streak).
    expect(calls).toEqual([]);
    expect(monitor.getState("paystack").consecutiveFailures).toBe(0);
    expect(monitor.getState("paystack").firstFailureAt).toBeNull();
  });

  it("a single ok result AFTER a degraded page emits exactly one paired recovery", () => {
    const { monitor, calls } = makeMonitor({ threshold: 1 });
    monitor.observe("flutterwave", { ok: false, error: "boom" }, 1_000);
    monitor.observe("flutterwave", { ok: true }, 5_000);
    expect(calls.map((c) => c.kind)).toEqual(["degraded", "recovered"]);
    const recovered = (calls[1] as RecoveredCall).event;
    expect(recovered.subsystem).toBe("dependency-probe:flutterwave");
    expect(recovered.recoveredAt).toBe(5_000);
    expect(recovered.durationMs).toBe(4_000);
    expect(recovered.runbookUrl).toBeDefined();
    expect(recovered.details).toMatchObject({
      probe: "flutterwave",
      lastFailureMarker: "boom",
    });
  });

  it("each probe is tracked independently — clerk failures do not advance paystack's streak", () => {
    const { monitor, calls } = makeMonitor({ threshold: 2 });
    monitor.observe("clerk", { ok: false, error: "x" }, 1_000);
    monitor.observe("paystack", { ok: false, error: "y" }, 2_000);
    monitor.observe("clerk", { ok: false, error: "x" }, 3_000);
    // Clerk reaches threshold → one degraded call, paystack does not.
    expect(calls).toHaveLength(1);
    expect((calls[0] as DegradedCall).event.subsystem).toBe(
      "dependency-probe:clerk",
    );
    monitor.observe("paystack", { ok: false, error: "y" }, 4_000);
    expect(calls).toHaveLength(2);
    expect((calls[1] as DegradedCall).event.subsystem).toBe(
      "dependency-probe:paystack",
    );
  });

  it("re-trips after recovery only after the cooldown window has elapsed", () => {
    const { monitor, calls } = makeMonitor({
      threshold: 1,
      cooldownMs: 60_000,
    });
    // First trip + recovery.
    monitor.observe("clerk", { ok: false, error: "x" }, 1_000);
    monitor.observe("clerk", { ok: true }, 2_000);
    expect(calls.map((c) => c.kind)).toEqual(["degraded", "recovered"]);

    // Second failure 10s after recovery — inside the cooldown window.
    // We MUST NOT re-page; flapping is exactly what the cooldown
    // exists to prevent.
    monitor.observe("clerk", { ok: false, error: "x" }, 12_000);
    expect(calls.map((c) => c.kind)).toEqual(["degraded", "recovered"]);

    // Failure outside the cooldown window — pages normally. The
    // probe stays failed across the cooldown boundary and is paged
    // once the boundary is crossed; no intervening ok is needed.
    monitor.observe("clerk", { ok: false, error: "y" }, 100_000);
    expect(calls.filter((c) => c.kind === "degraded")).toHaveLength(2);
  });

  it("REGRESSION: a streak suppressed by cooldown still pages once the cooldown elapses (no intervening ok)", () => {
    // Earlier implementation set `degradedNotifiedAt = now` on
    // cooldown-suppressed trips, which then permanently
    // short-circuited every future failure in the streak via the
    // "already paged" early return. Result: a real, sustained
    // dependency outage that started inside the cooldown window
    // would silently never page on-call.
    //
    // Correct semantics: cooldown suppresses the notifier call ONLY
    // — the next observation after the window elapses re-evaluates
    // and pages on-call.
    const { monitor, calls } = makeMonitor({
      threshold: 1,
      cooldownMs: 60_000,
    });
    monitor.observe("paystack", { ok: false, error: "first" }, 1_000);
    monitor.observe("paystack", { ok: true }, 2_000);
    expect(calls.map((c) => c.kind)).toEqual(["degraded", "recovered"]);

    // Sustained failure starting inside the cooldown window.
    monitor.observe("paystack", { ok: false, error: "second" }, 10_000);
    monitor.observe("paystack", { ok: false, error: "second" }, 20_000);
    monitor.observe("paystack", { ok: false, error: "second" }, 50_000);
    expect(calls.filter((c) => c.kind === "degraded")).toHaveLength(1); // suppressed

    // Cooldown anchor was the original degraded at t=1000, so 60s
    // has elapsed at t=61_001. The next observation MUST page.
    monitor.observe("paystack", { ok: false, error: "second" }, 70_000);
    expect(calls.filter((c) => c.kind === "degraded")).toHaveLength(2);
    const second = calls
      .filter((c): c is DegradedCall => c.kind === "degraded")
      .at(-1)!.event;
    expect(second.details?.failureMarker).toBe("second");
    // The streak began at t=10_000 (the first failure of the new
    // outage), and we should report that as `firstFailureAt` — not
    // the post-cooldown observation time.
    expect(second.firstFailureAt).toBe(10_000);
  });

  it("REGRESSION: an ok that follows a cooldown-suppressed trip does NOT emit a phantom recovery", () => {
    // Earlier implementation set `degradedNotifiedAt = now` on
    // cooldown-suppressed trips and then the next ok used that as
    // proof "we paged degraded → emit recovery". Result: PagerDuty
    // received a resolve event for an incident that was never
    // opened — confusing on-call.
    //
    // Correct semantics: recovery is gated on
    // `incidentOpen` (true only after a real degraded notification),
    // so a suppressed trip → ok is silent.
    const { monitor, calls } = makeMonitor({
      threshold: 1,
      cooldownMs: 60_000,
    });
    // Establish the cooldown by paging once and recovering.
    monitor.observe("flutterwave", { ok: false, error: "x" }, 1_000);
    monitor.observe("flutterwave", { ok: true }, 2_000);
    expect(calls.map((c) => c.kind)).toEqual(["degraded", "recovered"]);

    // Suppressed trip inside the cooldown window.
    monitor.observe("flutterwave", { ok: false, error: "y" }, 10_000);
    expect(calls.map((c) => c.kind)).toEqual(["degraded", "recovered"]);

    // Recovery while the trip is suppressed. We MUST NOT emit a
    // resolve here — there's no open incident to resolve.
    monitor.observe("flutterwave", { ok: true }, 11_000);
    expect(calls.map((c) => c.kind)).toEqual(["degraded", "recovered"]);
    expect(monitor.getState("flutterwave").incidentOpen).toBe(false);
  });

  it("REGRESSION: a `skipped` after a cooldown-suppressed trip does NOT emit a phantom recovery", () => {
    // Same root cause as above, but exercising the env-flag escape
    // hatch path through `handleSkipped`.
    const { monitor, calls } = makeMonitor({
      threshold: 1,
      cooldownMs: 60_000,
    });
    monitor.observe("clerk", { ok: false, error: "x" }, 1_000);
    monitor.observe("clerk", { ok: true }, 2_000);
    expect(calls.map((c) => c.kind)).toEqual(["degraded", "recovered"]);

    monitor.observe("clerk", { ok: false, error: "y" }, 10_000);
    expect(calls.map((c) => c.kind)).toEqual(["degraded", "recovered"]); // suppressed

    monitor.observe("clerk", null, 11_000); // operator flips the kill switch
    expect(calls.map((c) => c.kind)).toEqual(["degraded", "recovered"]);
    expect(monitor.getState("clerk").incidentOpen).toBe(false);
  });

  it("a `skipped` (env flag flipped off) result mid-incident emits a recovery so PagerDuty closes the open page", () => {
    // The runbook documents flipping the env flag as the in-incident
    // escape hatch. Once disabled, the next /readyz reports
    // `<name>: "skipped"` and the monitor MUST treat that as
    // recovery — otherwise PagerDuty leaves the open incident
    // dangling after the operator obviously turned the alert off.
    const { monitor, calls } = makeMonitor({ threshold: 1 });
    monitor.observe("clerk", { ok: false, error: "x" }, 1_000);
    monitor.observe("clerk", null, 5_000);
    expect(calls.map((c) => c.kind)).toEqual(["degraded", "recovered"]);
    const recovered = (calls[1] as RecoveredCall).event;
    expect(recovered.details?.lastFailureMarker).toBe(
      "probe_disabled_via_env_flag",
    );
    // State is reset so a re-enable starts a fresh streak. The
    // incident is closed (`incidentOpen=false`), but
    // `degradedNotifiedAt` is intentionally preserved so the
    // cooldown gate still anchors on the original trigger time if
    // the operator quickly re-enables the probe and it trips again.
    expect(monitor.getState("clerk").consecutiveFailures).toBe(0);
    expect(monitor.getState("clerk").incidentOpen).toBe(false);
  });

  it("a `skipped` result when no incident is open is a no-op — no spurious recovery alert", () => {
    const { monitor, calls } = makeMonitor({ threshold: 1 });
    monitor.observe("clerk", null, 1_000);
    monitor.observe("clerk", null, 2_000);
    expect(calls).toEqual([]);
  });

  it("an ok result before the threshold is crossed clears the streak counter without paging recovery", () => {
    // Distinct from "ok after degraded page" — here we never paged,
    // so emitting recovery would open a phantom resolve in PagerDuty
    // for an incident that never existed.
    const { monitor, calls } = makeMonitor({ threshold: 5 });
    monitor.observe("paystack", { ok: false, error: "x" }, 1_000);
    monitor.observe("paystack", { ok: false, error: "x" }, 2_000);
    monitor.observe("paystack", { ok: true }, 3_000);
    expect(calls).toEqual([]);
    expect(monitor.getState("paystack").consecutiveFailures).toBe(0);
  });
});

describe("DependencyProbeAlertMonitor — env parsing", () => {
  it("defaults to threshold=3, cooldown=60s, and the in-repo runbook anchor on a clean env", () => {
    const { notifier } = makeStubNotifier();
    const monitor = createDependencyProbeAlertMonitor({
      notifier,
      env: {},
    });
    // Drive 2 failures — should NOT page (threshold defaults to 3).
    monitor.observe("clerk", { ok: false, error: "x" }, 1_000);
    monitor.observe("clerk", { ok: false, error: "x" }, 2_000);
    expect(monitor.getState("clerk").degradedNotifiedAt).toBeNull();
    monitor.observe("clerk", { ok: false, error: "x" }, 3_000);
    expect(monitor.getState("clerk").degradedNotifiedAt).toBe(3_000);
  });

  it("honours DEPENDENCY_PROBE_ALERT_THRESHOLD when set to a positive integer", () => {
    const { notifier, calls } = makeStubNotifier();
    const monitor = createDependencyProbeAlertMonitor({
      notifier,
      env: { DEPENDENCY_PROBE_ALERT_THRESHOLD: "5" },
    });
    for (let i = 1; i <= 4; i++) {
      monitor.observe("clerk", { ok: false, error: "x" }, i * 1_000);
    }
    expect(calls).toEqual([]);
    monitor.observe("clerk", { ok: false, error: "x" }, 5_000);
    expect(calls).toHaveLength(1);
  });

  it("sanitises malformed thresholds (NaN / 0 / negative) and falls back to the default", () => {
    // 0 would page on every single failure (defeating the debounce);
    // NaN/negative are most likely typos. Same sanitisation
    // philosophy as the readyz timeout parsing.
    for (const v of ["not-a-number", "0", "-3", ""]) {
      const { notifier } = makeStubNotifier();
      const monitor = createDependencyProbeAlertMonitor({
        notifier,
        env: { DEPENDENCY_PROBE_ALERT_THRESHOLD: v },
      });
      monitor.observe("clerk", { ok: false, error: "x" }, 1_000);
      monitor.observe("clerk", { ok: false, error: "x" }, 2_000);
      // 2 failures must NOT page — proving the fallback is the
      // default 3, not the malformed `v`.
      expect(
        monitor.getState("clerk").degradedNotifiedAt,
        `value=${JSON.stringify(v)}`,
      ).toBeNull();
    }
  });

  it("honours DEPENDENCY_PROBE_ALERT_COOLDOWN_MS=0 as 'no debounce' and pages on every transition", () => {
    const { notifier, calls } = makeStubNotifier();
    const monitor = createDependencyProbeAlertMonitor({
      notifier,
      env: {
        DEPENDENCY_PROBE_ALERT_THRESHOLD: "1",
        DEPENDENCY_PROBE_ALERT_COOLDOWN_MS: "0",
      },
    });
    monitor.observe("clerk", { ok: false, error: "x" }, 1_000);
    monitor.observe("clerk", { ok: true }, 2_000);
    monitor.observe("clerk", { ok: false, error: "y" }, 3_000);
    // With cooldown=0 the second trip pages immediately — no
    // suppression. Useful for tests / chaos drills.
    expect(calls.map((c) => c.kind)).toEqual([
      "degraded",
      "recovered",
      "degraded",
    ]);
  });

  it("honours DEPENDENCY_PROBE_ALERT_RUNBOOK_URL override", () => {
    const { notifier, calls } = makeStubNotifier();
    const monitor = createDependencyProbeAlertMonitor({
      notifier,
      env: {
        DEPENDENCY_PROBE_ALERT_THRESHOLD: "1",
        DEPENDENCY_PROBE_ALERT_RUNBOOK_URL:
          "https://internal.wiki/runbook#dep-probes",
      },
    });
    monitor.observe("paystack", { ok: false, error: "x" }, 1_000);
    expect((calls[0] as DegradedCall).event.runbookUrl).toBe(
      "https://internal.wiki/runbook#dep-probes",
    );
  });
});

describe("DependencyProbeAlertMonitor — failure handling in the notifier path", () => {
  it("a thrown notifier does NOT propagate back to the caller (probe path stays clean)", () => {
    const notifier: SubsystemAlertNotifier = {
      notifyDegraded() {
        throw new Error("slack down");
      },
      notifyRecovered() {
        throw new Error("slack down");
      },
    };
    const monitor = createDependencyProbeAlertMonitor({
      notifier,
      threshold: 1,
    });
    // The route layer calls observe() per /readyz invocation; if
    // observe() threw, every readyz call would 5xx during a paging
    // outage, taking the replica out of rotation for the WRONG
    // reason. Assert observe stays silent.
    expect(() =>
      monitor.observe("clerk", { ok: false, error: "x" }, 1_000),
    ).not.toThrow();
    expect(() => monitor.observe("clerk", { ok: true }, 2_000)).not.toThrow();
  });
});

describe("DependencyProbeAlertMonitor — runbookUrl wiring through subsystemAlertNotifier", () => {
  it("the runbookUrl from the monitor surfaces in the Slack and PagerDuty payloads", async () => {
    // Integration-style assertion: prove the runbookUrl flows from
    // the monitor through the WebhookSubsystemAlertNotifier into the
    // actual webhook bodies. Without this, a regression in the
    // notifier (dropping the field from the payload builders) would
    // be invisible to the per-monitor unit tests above.
    const {
      WebhookSubsystemAlertNotifier,
    } = await import("./subsystemAlertNotifier");
    const calls: Array<{ url: string; body: unknown }> = [];
    const notifier = new WebhookSubsystemAlertNotifier({
      env: {
        SUBSYSTEM_ALERT_SLACK_WEBHOOK_URL: "https://slack.example/hook",
        SUBSYSTEM_ALERT_PAGERDUTY_ROUTING_KEY: "pd-test-key",
        SUBSYSTEM_ALERT_SOURCE: "test-source",
      },
      fetchImpl: async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body) as unknown });
        return { ok: true, status: 200, statusText: "OK" };
      },
    });
    const monitor = createDependencyProbeAlertMonitor({
      notifier,
      threshold: 1,
      runbookUrl: "https://wiki.example/runbook#disable-clerk-probe",
    });
    monitor.observe(
      "clerk",
      { ok: false, error: "http_probe_timeout_after_2000ms" },
      1_000,
    );
    // Flush the fire-and-forget POSTs.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(calls).toHaveLength(2);
    const slack = calls.find((c) => c.url === "https://slack.example/hook")!;
    const pd = calls.find((c) => c.url !== "https://slack.example/hook")!;
    // Slack body: runbook URL appears as a field value. The
    // workspace renderer auto-linkifies bare URLs.
    const slackFields = (slack.body as {
      attachments: Array<{ fields: Array<{ title: string; value: string }> }>;
    }).attachments[0]!.fields;
    expect(
      slackFields.find((f) => f.title === "Runbook")?.value,
    ).toBe("https://wiki.example/runbook#disable-clerk-probe");
    // PagerDuty body: runbook URL appears in `links` (PD UI button)
    // AND mirrored under `custom_details.runbookUrl` (plain-text
    // fallback for integrations that strip `links`).
    const pdBody = pd.body as {
      links?: Array<{ href: string; text: string }>;
      payload: { custom_details: Record<string, unknown> };
    };
    expect(pdBody.links).toEqual([
      {
        href: "https://wiki.example/runbook#disable-clerk-probe",
        text: "Runbook",
      },
    ]);
    expect(pdBody.payload.custom_details.runbookUrl).toBe(
      "https://wiki.example/runbook#disable-clerk-probe",
    );
    // The probe + marker also surface in custom_details so on-call
    // sees the freshest cause.
    expect(pdBody.payload.custom_details.probe).toBe("clerk");
    expect(pdBody.payload.custom_details.failureMarker).toBe(
      "http_probe_timeout_after_2000ms",
    );
  });
});

describe("DependencyProbeAlertMonitor — __reset", () => {
  it("clears all per-probe state for use between test cases", () => {
    const { monitor, calls } = makeMonitor({ threshold: 1 });
    monitor.observe("clerk", { ok: false, error: "x" }, 1_000);
    expect(calls).toHaveLength(1);
    monitor.__reset();
    // After reset, the monitor has no memory of the prior incident —
    // the next failure starts a fresh streak with a fresh page.
    monitor.observe("clerk", { ok: false, error: "y" }, 2_000);
    expect(calls).toHaveLength(2);
  });
});

