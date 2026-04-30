import { describe, it, expect, vi, beforeEach } from "vitest";

const captureMessageMock = vi.fn<
  (message: string, options?: unknown) => void
>();

vi.mock("./sentry", () => ({
  captureMessage: (message: string, options?: unknown) =>
    captureMessageMock(message, options),
}));

vi.mock("./logger", () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

const {
  reportDegraded,
  reportRecovered,
  getOpenReplicaAlerts,
  getReplicaDegradedAlertConfig,
  __resetReplicaDegradedAlertsForTests,
} = await import("./replicaDegradedAlerts");

beforeEach(() => {
  captureMessageMock.mockReset();
  __resetReplicaDegradedAlertsForTests();
  delete process.env.REPLICA_DEGRADED_ALERT_COOLDOWN_MS;
  delete process.env.REPLICA_DEGRADED_ALERT_STALE_AFTER_MS;
});

describe("getReplicaDegradedAlertConfig", () => {
  it("falls back to defaults for missing or invalid env values", () => {
    const TEN_MIN = 10 * 60 * 1000;
    const THIRTY_MIN = 30 * 60 * 1000;
    for (const bad of [undefined, "", "not-a-number", "0", "-5"]) {
      expect(
        getReplicaDegradedAlertConfig({
          REPLICA_DEGRADED_ALERT_COOLDOWN_MS: bad as string,
          REPLICA_DEGRADED_ALERT_STALE_AFTER_MS: bad as string,
        }),
      ).toEqual({ cooldownMs: TEN_MIN, staleAfterMs: THIRTY_MIN });
    }
  });

  it("respects finite positive overrides and floors floats", () => {
    expect(
      getReplicaDegradedAlertConfig({
        REPLICA_DEGRADED_ALERT_COOLDOWN_MS: "60000",
        REPLICA_DEGRADED_ALERT_STALE_AFTER_MS: "120000",
      }),
    ).toEqual({ cooldownMs: 60_000, staleAfterMs: 120_000 });
    expect(
      getReplicaDegradedAlertConfig({
        REPLICA_DEGRADED_ALERT_COOLDOWN_MS: "60000.9",
        REPLICA_DEGRADED_ALERT_STALE_AFTER_MS: "120000.9",
      }),
    ).toEqual({ cooldownMs: 60_000, staleAfterMs: 120_000 });
  });
});

describe("reportDegraded", () => {
  const baseReport = {
    replicaId: "api-server-7c4f9d-x9k2p",
    httpStatus: 503,
    failingChecks: ["redis"],
    failures: { redis: "redis_ping_timeout_after_2000ms" },
    consecutivePolls: 2,
  };

  it("emits Sentry on the first report and includes the full payload", () => {
    const out = reportDegraded(baseReport, 1_000);
    expect(out).toEqual({ emitted: true, replicaId: baseReport.replicaId });
    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    const [message, opts] = captureMessageMock.mock.calls[0]!;
    expect(message).toBe("admin_status_panel_replica_degraded");
    const options = opts as {
      level: string;
      tags: Record<string, string>;
      fingerprint: string[];
      extra: Record<string, unknown>;
    };
    expect(options.level).toBe("error");
    expect(options.tags).toMatchObject({
      subsystem: "replica_health",
      source: "admin_status_panel",
      replicaId: baseReport.replicaId,
    });
    expect(options.fingerprint).toEqual([
      "admin_status_panel_replica_degraded",
      baseReport.replicaId,
    ]);
    expect(options.extra).toMatchObject({
      replicaId: baseReport.replicaId,
      httpStatus: 503,
      failingChecks: ["redis"],
      failures: { redis: "redis_ping_timeout_after_2000ms" },
      consecutivePolls: 2,
      reportCount: 1,
    });
  });

  it("dedups subsequent reports inside the cooldown window across operators", () => {
    // First report from operator A -> emits
    reportDegraded(baseReport, 1_000);
    // Five more reports inside the 10-minute cooldown — three from
    // operator A's tab, two from operator B's tab. All should be
    // silenced so on-call only sees one Sentry event for this outage.
    for (const t of [1_500, 2_000, 60_000, 120_000, 599_000]) {
      const out = reportDegraded(baseReport, t);
      expect(out).toEqual({
        emitted: false,
        dedupReason: "within_cooldown",
        replicaId: baseReport.replicaId,
      });
    }
    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    // Open-alert table reflects the live report stream so the inspection
    // endpoint can show how many tabs are reporting.
    expect(getOpenReplicaAlerts()).toEqual([
      {
        replicaId: baseReport.replicaId,
        firstReportedAt: 1_000,
        lastReportedAt: 599_000,
        lastEmittedAt: 1_000,
        reportCount: 6,
      },
    ]);
  });

  it("re-emits after the cooldown elapses so a long outage doesn't go silent", () => {
    reportDegraded(baseReport, 1_000); // emit #1
    // Just before cooldown elapses — still silent.
    reportDegraded(baseReport, 1_000 + 10 * 60 * 1000 - 1);
    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    // Exactly at cooldown — re-emit.
    reportDegraded(baseReport, 1_000 + 10 * 60 * 1000);
    expect(captureMessageMock).toHaveBeenCalledTimes(2);
    // Inside the new cooldown window — silent again.
    reportDegraded(baseReport, 1_000 + 10 * 60 * 1000 + 60_000);
    expect(captureMessageMock).toHaveBeenCalledTimes(2);
  });

  it("dedups per replicaId — independent replicas page independently", () => {
    reportDegraded({ ...baseReport, replicaId: "replica-a" }, 1_000);
    reportDegraded({ ...baseReport, replicaId: "replica-b" }, 2_000);
    reportDegraded({ ...baseReport, replicaId: "replica-a" }, 3_000);
    expect(captureMessageMock).toHaveBeenCalledTimes(2);
    const replicaIdsEmitted = captureMessageMock.mock.calls.map(
      (call) => (call[1] as { tags: Record<string, string> }).tags.replicaId,
    );
    expect(new Set(replicaIdsEmitted)).toEqual(
      new Set(["replica-a", "replica-b"]),
    );
  });

  it("drops stale entries past staleAfterMs so the in-memory table is bounded", () => {
    reportDegraded({ ...baseReport, replicaId: "replica-a" }, 1_000);
    // 31 minutes later the original entry is past the 30-minute stale
    // window; a fresh report for the same replica is treated as a new
    // outage and emits Sentry.
    reportDegraded(
      { ...baseReport, replicaId: "replica-a" },
      1_000 + 31 * 60 * 1000,
    );
    expect(captureMessageMock).toHaveBeenCalledTimes(2);
    expect(getOpenReplicaAlerts()).toHaveLength(1);
  });
});

describe("reportRecovered", () => {
  const baseReport = {
    replicaId: "api-server-7c4f9d-x9k2p",
    httpStatus: 503,
    failingChecks: ["redis"],
    failures: { redis: "redis_ping_timeout_after_2000ms" },
  };

  it("closes the open alert and emits a Sentry recovery event", () => {
    reportDegraded(baseReport, 1_000);
    captureMessageMock.mockReset();
    const out = reportRecovered(
      { replicaId: baseReport.replicaId },
      5_000,
    );
    expect(out).toEqual({ emitted: true, replicaId: baseReport.replicaId });
    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    const [message, opts] = captureMessageMock.mock.calls[0]!;
    expect(message).toBe("admin_status_panel_replica_recovered");
    const options = opts as {
      level: string;
      fingerprint: string[];
      extra: Record<string, unknown>;
    };
    expect(options.level).toBe("info");
    // Same fingerprint as the degraded event so the recovery lands on
    // the SAME Sentry issue as a comment, not as a new one.
    expect(options.fingerprint).toEqual([
      "admin_status_panel_replica_degraded",
      baseReport.replicaId,
    ]);
    expect(options.extra).toMatchObject({
      replicaId: baseReport.replicaId,
      durationMs: 4_000,
    });
    expect(getOpenReplicaAlerts()).toEqual([]);
  });

  it("is a no-op when there is no open alert (idempotent)", () => {
    const out = reportRecovered(
      { replicaId: "never-reported" },
      1_000,
    );
    expect(out).toEqual({ emitted: false, replicaId: "never-reported" });
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it("re-degrade after recovery emits a fresh Sentry event", () => {
    reportDegraded(baseReport, 1_000); // emit
    reportRecovered({ replicaId: baseReport.replicaId }, 2_000); // recovery emit
    captureMessageMock.mockReset();
    reportDegraded(baseReport, 3_000); // new outage -> emit
    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    expect(captureMessageMock.mock.calls[0]?.[0]).toBe(
      "admin_status_panel_replica_degraded",
    );
  });
});
