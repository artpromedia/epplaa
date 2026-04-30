import { describe, it, expect, vi, beforeEach } from "vitest";

const dbExecuteMock = vi.fn();

vi.mock("./db", () => ({
  db: {
    execute: (...args: unknown[]) => dbExecuteMock(...args),
  },
}));

vi.mock("./logger", () => ({
  logger: {
    warn: () => {},
    error: () => {},
    info: () => {},
  },
}));

const {
  pollAuditDlqDepth,
  getAuditDlqSnapshot,
  getAuditDlqThreshold,
  getAuditDlqPollIntervalMs,
  auditDlqHealthWatcher,
  __resetAuditDlqMonitorForTests,
} = await import("./auditDlqMonitor");

beforeEach(() => {
  dbExecuteMock.mockReset();
  __resetAuditDlqMonitorForTests();
  delete process.env.AUDIT_DLQ_BACKLOG_THRESHOLD;
  delete process.env.AUDIT_DLQ_POLL_INTERVAL_MS;
});

describe("getAuditDlqThreshold", () => {
  it("falls back to 100 when the env var is unset, non-numeric, zero, or negative", () => {
    // Mirrors the env-var sanitisation contract used by every other
    // alert threshold in this codebase: a typo must not silently turn
    // the alert into a flapping page (zero threshold = always over)
    // or a permanently-silent one. The default is the runbook's
    // documented value.
    for (const bad of [undefined, "", "not-a-number", "0", "-5", "  "]) {
      expect(
        getAuditDlqThreshold({ AUDIT_DLQ_BACKLOG_THRESHOLD: bad as string }),
        `bad=${String(bad)}`,
      ).toBe(100);
    }
  });

  it("respects a finite positive override", () => {
    expect(
      getAuditDlqThreshold({ AUDIT_DLQ_BACKLOG_THRESHOLD: "500" }),
    ).toBe(500);
    expect(
      getAuditDlqThreshold({ AUDIT_DLQ_BACKLOG_THRESHOLD: "1" }),
    ).toBe(1);
    // Floats are floored so a `100.9` env value can't sneak the
    // threshold above 100.
    expect(
      getAuditDlqThreshold({ AUDIT_DLQ_BACKLOG_THRESHOLD: "100.9" }),
    ).toBe(100);
  });
});

describe("getAuditDlqPollIntervalMs", () => {
  it("falls back to the 60s default for missing or invalid values", () => {
    for (const bad of [undefined, "", "not-a-number", "0", "-5", "999"]) {
      // 999 < 1000 minimum so it should also fall back — sub-second
      // polling would slam the DB and isn't a realistic operator
      // intent, so we treat it as a typo.
      expect(
        getAuditDlqPollIntervalMs({
          AUDIT_DLQ_POLL_INTERVAL_MS: bad as string,
        }),
        `bad=${String(bad)}`,
      ).toBe(60_000);
    }
  });

  it("respects a finite positive override at or above the 1000ms minimum", () => {
    expect(
      getAuditDlqPollIntervalMs({ AUDIT_DLQ_POLL_INTERVAL_MS: "30000" }),
    ).toBe(30_000);
    expect(
      getAuditDlqPollIntervalMs({ AUDIT_DLQ_POLL_INTERVAL_MS: "1000" }),
    ).toBe(1_000);
  });
});

describe("pollAuditDlqDepth", () => {
  const NOW = 1_700_000_000_000;

  it("records success when the unreplayed count is at or below threshold", async () => {
    process.env.AUDIT_DLQ_BACKLOG_THRESHOLD = "100";
    dbExecuteMock.mockResolvedValueOnce({ rows: [{ count: "50" }] });

    await pollAuditDlqDepth(NOW);

    const snap = getAuditDlqSnapshot();
    expect(snap.state).toBe("healthy");
    expect(snap.unreplayedCount).toBe(50);
    expect(snap.lastPollAt).toBe(NOW);
    expect(snap.lastPollError).toBeNull();
    expect(snap.thresholdCount).toBe(100);
  });

  it("treats count exactly equal to threshold as healthy (strict greater-than gate)", async () => {
    // The threshold is a "more than N" alarm — using >=, a low
    // operator-set threshold like 1 would page on the first DLQ row,
    // which is normal partial-outage noise. Documenting via test
    // that the gate is strict.
    process.env.AUDIT_DLQ_BACKLOG_THRESHOLD = "100";
    dbExecuteMock.mockResolvedValueOnce({ rows: [{ count: "100" }] });

    await pollAuditDlqDepth(NOW);
    expect(getAuditDlqSnapshot().state).toBe("healthy");
  });

  it("opens a degraded streak when the unreplayed count exceeds threshold", async () => {
    process.env.AUDIT_DLQ_BACKLOG_THRESHOLD = "100";
    dbExecuteMock.mockResolvedValueOnce({ rows: [{ count: "250" }] });

    await pollAuditDlqDepth(NOW);

    const snap = getAuditDlqSnapshot();
    expect(snap.state).toBe("degraded");
    expect(snap.firstFailureAt).toBe(NOW);
    expect(snap.unreplayedCount).toBe(250);
    expect(snap.lastPollError).toBeNull();
  });

  it("keeps `firstFailureAt` sticky across consecutive over-threshold polls", async () => {
    // The duration alert pages on `now - firstFailureAt > thresholdMs`.
    // If firstFailureAt advanced on every poll, the streak would
    // never accumulate and the alert would never fire — exactly the
    // failure mode this test exists to prevent.
    process.env.AUDIT_DLQ_BACKLOG_THRESHOLD = "100";
    dbExecuteMock.mockResolvedValue({ rows: [{ count: "200" }] });

    await pollAuditDlqDepth(NOW);
    await pollAuditDlqDepth(NOW + 60_000);
    await pollAuditDlqDepth(NOW + 120_000);

    const snap = getAuditDlqSnapshot();
    expect(snap.state).toBe("degraded");
    expect(snap.firstFailureAt).toBe(NOW);
    expect(snap.failureCount).toBe(3);
    expect(snap.unreplayedCount).toBe(200);
    expect(snap.lastPollAt).toBe(NOW + 120_000);
  });

  it("closes the streak when the count drops back to or below threshold", async () => {
    // Recovery path: once the backlog is replayed back under the
    // threshold the watcher must auto-resolve so the duration alert
    // stops firing without manual intervention.
    process.env.AUDIT_DLQ_BACKLOG_THRESHOLD = "100";
    dbExecuteMock
      .mockResolvedValueOnce({ rows: [{ count: "200" }] })
      .mockResolvedValueOnce({ rows: [{ count: "10" }] });

    await pollAuditDlqDepth(NOW);
    expect(getAuditDlqSnapshot().state).toBe("degraded");

    await pollAuditDlqDepth(NOW + 60_000);
    const snap = getAuditDlqSnapshot();
    expect(snap.state).toBe("healthy");
    expect(snap.firstFailureAt).toBeNull();
    expect(snap.lastRecoveredAt).toBe(NOW + 60_000);
    expect(snap.unreplayedCount).toBe(10);
  });

  it("does NOT trip the watcher on a poll error — depth is unknown, not over threshold", async () => {
    // A DB outage is surfaced by the dbHealthWatcher via /readyz on
    // a separate channel; conflating "we can't measure the DLQ" with
    // "the DLQ is over threshold" would erode the alert's signal and
    // cross-page on-call for a different incident than the runbook
    // entry point would suggest.
    dbExecuteMock.mockRejectedValueOnce(new Error("connection terminated"));

    await pollAuditDlqDepth(NOW);

    const snap = getAuditDlqSnapshot();
    expect(snap.state).toBe("healthy");
    expect(snap.firstFailureAt).toBeNull();
    expect(snap.lastPollError).toBe("connection terminated");
    expect(snap.lastPollAt).toBe(NOW);
    expect(snap.unreplayedCount).toBeNull();
  });

  it("clears `lastPollError` once a subsequent poll succeeds", async () => {
    // An operator looking at /healthz mid-incident should see the
    // current error state, not a stale one from a previous transient
    // failure that has since recovered.
    dbExecuteMock
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce({ rows: [{ count: "5" }] });

    await pollAuditDlqDepth(NOW);
    expect(getAuditDlqSnapshot().lastPollError).toBe("transient");

    await pollAuditDlqDepth(NOW + 60_000);
    expect(getAuditDlqSnapshot().lastPollError).toBeNull();
    expect(getAuditDlqSnapshot().unreplayedCount).toBe(5);
  });

  it("treats an unparseable count as a poll error rather than NaN-ing the threshold check", async () => {
    // Defensive: a row shape change (column rename, JSON
    // serialisation drift) would otherwise parse to NaN and NaN > N
    // is always false, so the alert would silently never fire. Treat
    // malformed counts as poll errors so an operator notices via
    // lastPollError instead.
    dbExecuteMock.mockResolvedValueOnce({ rows: [{ count: "not-a-number" }] });

    await pollAuditDlqDepth(NOW);

    const snap = getAuditDlqSnapshot();
    expect(snap.state).toBe("healthy");
    expect(snap.lastPollError).toMatch(/audit_dlq_count_unparseable/);
    expect(snap.unreplayedCount).toBeNull();
  });

  it("treats a missing row (empty result) as a count of 0", async () => {
    // count(*) on a table that exists but is empty returns one row
    // with count 0, but if a future driver change ever returned an
    // empty rows array we want to fall back to 0 (healthy) rather
    // than NaN/poll-error — both agree the DLQ is empty.
    dbExecuteMock.mockResolvedValueOnce({ rows: [] });

    await pollAuditDlqDepth(NOW);

    const snap = getAuditDlqSnapshot();
    expect(snap.state).toBe("healthy");
    expect(snap.unreplayedCount).toBe(0);
    expect(snap.lastPollError).toBeNull();
  });
});

describe("getAuditDlqSnapshot defaults", () => {
  it("returns the no-poll-yet shape before any pollAuditDlqDepth call", () => {
    // /healthz must always be servable, even on the very first
    // request after boot before the first poll has run. The snapshot
    // shape distinguishes "no measurement yet" (null) from "measured
    // 0" (number) so an operator can tell apart "the monitor is
    // brand new" from "the DLQ is empty".
    const snap = getAuditDlqSnapshot();
    expect(snap).toEqual({
      state: "healthy",
      failureCount: 0,
      firstFailureAt: null,
      lastRecoveredAt: null,
      unreplayedCount: null,
      thresholdCount: 100,
      lastPollAt: null,
      lastPollError: null,
    });
  });

  it("reflects a streak injected via the rehearsal hook even before any poll has run", () => {
    // The rehearsal injector seeds the watcher directly without
    // running a poll. The /healthz response must still surface the
    // injected streak so the duration probe can pick it up.
    auditDlqHealthWatcher.__injectStreak(1_700_000_000_000, 3);
    const snap = getAuditDlqSnapshot();
    expect(snap.state).toBe("degraded");
    expect(snap.firstFailureAt).toBe(1_700_000_000_000);
    expect(snap.failureCount).toBe(3);
    // Depth fields stay null because no real poll has run.
    expect(snap.unreplayedCount).toBeNull();
    expect(snap.lastPollAt).toBeNull();
  });
});
