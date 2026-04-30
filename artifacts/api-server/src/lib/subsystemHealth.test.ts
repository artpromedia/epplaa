import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  DbHealthWatcher,
  __setDbHealthWatcherNotifierForTests,
  dbHealthWatcher,
} from "./subsystemHealth";
import type {
  DegradedTransitionEvent,
  RateLimitIncidentNotifier,
  RecoveredTransitionEvent,
} from "./rate-limit/incidentNotifier";

vi.mock("./logger", () => ({
  logger: {
    warn: () => {},
    error: () => {},
    info: () => {},
  },
}));

interface RecordedEvent {
  kind: "degraded" | "recovered";
  payload: DegradedTransitionEvent | RecoveredTransitionEvent;
}

function makeRecordingNotifier(): {
  notifier: RateLimitIncidentNotifier;
  events: RecordedEvent[];
} {
  const events: RecordedEvent[] = [];
  const notifier: RateLimitIncidentNotifier = {
    notifyDegraded(payload) {
      events.push({ kind: "degraded", payload });
    },
    notifyRecovered(payload) {
      events.push({ kind: "recovered", payload });
    },
    notifyDegradedDuration() {},
    notifyDegradedDurationRecovered() {},
  };
  return { notifier, events };
}

describe("DbHealthWatcher — out-of-band paging on transitions", () => {
  it("invokes notifyDegraded exactly once on the first failure of a streak (healthy→degraded edge)", () => {
    const { notifier, events } = makeRecordingNotifier();
    const watcher = new DbHealthWatcher({ incidentNotifier: notifier });
    const t0 = 1_700_000_000_000;

    watcher.record(t0);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("degraded");
    expect(events[0]!.payload).toMatchObject({
      subsystem: "db",
      label: "Database",
      failureCount: 1,
      firstFailureAt: t0,
      breachedAt: t0,
    });

    // Subsequent failures inside the same streak must NOT re-page —
    // the in-app banner only fires on `prevState !== "degraded"` and
    // the out-of-band page must follow the same edge so on-call and
    // the operator agree on whether an incident occurred.
    for (let i = 1; i < 6; i++) {
      watcher.record(t0 + i * 1_000);
    }
    expect(events.filter((e) => e.kind === "degraded")).toHaveLength(1);
  });

  it("invokes notifyRecovered exactly once on the degraded→healthy edge", () => {
    const { notifier, events } = makeRecordingNotifier();
    const watcher = new DbHealthWatcher({ incidentNotifier: notifier });
    const t0 = 1_700_000_000_000;
    watcher.record(t0);
    watcher.record(t0 + 1_000);
    watcher.record(t0 + 2_000);

    watcher.recordSuccess(t0 + 5_000);
    // Multiple consecutive successes only fire ONE recovery page.
    watcher.recordSuccess(t0 + 5_500);
    watcher.recordSuccess(t0 + 6_000);

    const recoveries = events.filter((e) => e.kind === "recovered");
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]!.payload).toMatchObject({
      subsystem: "db",
      label: "Database",
      durationMs: 5_000,
      failureCount: 3,
      recoveredAt: t0 + 5_000,
    });
  });

  it("re-pages on the next healthy→degraded transition after a recovery", () => {
    // Dedupe is per-incident, not for-all-time. After a streak closes,
    // the next streak's first failure must page again — otherwise a
    // genuine new outage would silently bypass on-call.
    const { notifier, events } = makeRecordingNotifier();
    const watcher = new DbHealthWatcher({ incidentNotifier: notifier });
    const t0 = 1_700_000_000_000;
    watcher.record(t0);
    watcher.recordSuccess(t0 + 1_000);
    watcher.record(t0 + 2_000);

    expect(events.map((e) => e.kind)).toEqual([
      "degraded",
      "recovered",
      "degraded",
    ]);
  });

  it("does NOT fire any notification when only successes are recorded (process startup)", () => {
    // Healthy→healthy transitions (the very first /readyz tick after
    // process boot, before any failure has ever occurred) must not
    // page on-call. Only true edges fire.
    const { notifier, events } = makeRecordingNotifier();
    const watcher = new DbHealthWatcher({ incidentNotifier: notifier });
    watcher.recordSuccess(1_700_000_000_000);
    watcher.recordSuccess(1_700_000_001_000);
    watcher.recordSuccess(1_700_000_002_000);
    expect(events).toEqual([]);
  });

  it("does NOT fire any notification on __injectStreak / __reset (rehearsal-only paths)", () => {
    // The staging-only rehearsal injector seeds synthetic streaks via
    // __injectStreak / __reset to exercise the duration-based probe.
    // Those paths must NOT fire a real Slack / PagerDuty page —
    // otherwise the weekly cron would page on-call every week with
    // a fake outage.
    const { notifier, events } = makeRecordingNotifier();
    const watcher = new DbHealthWatcher({ incidentNotifier: notifier });
    watcher.__injectStreak(1_700_000_000_000, 5);
    expect(events).toEqual([]);
    watcher.__reset();
    expect(events).toEqual([]);
  });

  it("swallows notifier errors so a webhook outage cannot break the /readyz path", () => {
    // Webhook outages must never cascade into the readiness-decision
    // path. The watcher swallows notifier errors and keeps tracking
    // the streak so the duration probe (and Sentry) still see the
    // right state regardless of whether the page lands.
    const watcher = new DbHealthWatcher({
      incidentNotifier: {
        notifyDegraded: () => {
          throw new Error("transport down");
        },
        notifyRecovered: () => {
          throw new Error("transport down");
        },
        notifyDegradedDuration: () => {
          throw new Error("transport down");
        },
        notifyDegradedDurationRecovered: () => {
          throw new Error("transport down");
        },
      },
    });
    const t0 = 1_700_000_000_000;
    expect(() => {
      watcher.record(t0);
      watcher.record(t0 + 1_000);
      watcher.recordSuccess(t0 + 5_000);
    }).not.toThrow();
    // Internal state is consistent: the streak closed normally even
    // though both notifier calls threw.
    expect(watcher.getSnapshot().state).toBe("healthy");
    expect(watcher.getSnapshot().lastRecoveredAt).toBe(t0 + 5_000);
  });
});

describe("dbHealthWatcher singleton — notifier injection helper", () => {
  beforeEach(() => {
    dbHealthWatcher.__reset();
  });

  it("__setDbHealthWatcherNotifierForTests routes singleton transitions to the injected notifier", () => {
    // Sanity check the production singleton's notifier-injection seam
    // so wider integration tests (and the routes/health.ts fan-out)
    // can swap the notifier without recreating the watcher.
    const { notifier, events } = makeRecordingNotifier();
    __setDbHealthWatcherNotifierForTests(notifier);
    const t0 = 1_700_000_500_000;
    dbHealthWatcher.record(t0);
    dbHealthWatcher.recordSuccess(t0 + 2_000);
    expect(events.map((e) => e.kind)).toEqual(["degraded", "recovered"]);
    // Restore a no-op notifier so other test files that import the
    // singleton don't observe whatever stub the previous test left
    // installed.
    __setDbHealthWatcherNotifierForTests({
      notifyDegraded() {},
      notifyRecovered() {},
      notifyDegradedDuration() {},
      notifyDegradedDurationRecovered() {},
    });
  });
});
