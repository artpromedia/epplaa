import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Unit tests for the retention sweep heartbeat surface.
 *
 * The integration test (`retention.int.test.ts`) covers the actual SQL
 * arms against a real Postgres. This file targets the pure helpers that
 * back the /healthz `subsystems.retention` snapshot + the OTel
 * gauges — they need to handle the "fresh deploy", "fresh sweep", and
 * "stuck scheduler" cases without a database, which is the path the
 * route-level test in `routes/health.test.ts` consumes via the seed
 * helpers.
 */

// We don't exercise any DB-touching paths here, but importing
// `lib/retention` pulls in `lib/db` transitively. Stub the db module so
// the gauge-callback closures don't open a real connection on a dev box
// without DATABASE_URL.
vi.mock("./db", () => ({
  db: {
    execute: vi.fn().mockResolvedValue({ rows: [] }),
    delete: vi.fn(),
    select: vi.fn(),
  },
  schema: {
    notificationsOutboxTable: {},
    recentlyViewedTable: {},
    recentSearchesTable: {},
    usersTable: {},
  },
}));

vi.mock("./logger", () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

vi.mock("./ndpr", () => ({
  applyErase: vi.fn(),
}));

const {
  RETENTION_HEARTBEAT_STALE_MS,
  __resetRetentionStateForTests,
  __seedHeartbeatForTests,
  getRetentionSubsystemSnapshot,
  getRetentionHeartbeats,
} = await import("./retention");

describe("getRetentionSubsystemSnapshot", () => {
  const NOW = 1_730_000_000_000;

  beforeEach(() => {
    __resetRetentionStateForTests(NOW);
  });

  it("reports healthy with no recovered timestamp during the post-boot grace window", () => {
    // Fresh process, no heartbeats persisted yet — must NOT page
    // because the first scheduled tick is 150s after boot. The grace
    // window matches the staleness threshold so a redeploy can never
    // page on-call inside the same window the alert is configured to
    // tolerate elsewhere.
    const snap = getRetentionSubsystemSnapshot(NOW + 60_000);
    expect(snap).toEqual({
      state: "healthy",
      failureCount: 0,
      firstFailureAt: null,
      lastRecoveredAt: null,
    });
  });

  it("flips to degraded after the post-boot grace window expires with no heartbeat ever recorded", () => {
    // A scheduler that never fires once after boot is the worst case
    // — the cache stays empty forever and the alert must page once
    // wall clock exceeds (boot + threshold). `firstFailureAt` is
    // anchored to that boundary so the duration probe's threshold
    // acts as a small grace tail on top of it.
    const observedAt = NOW + RETENTION_HEARTBEAT_STALE_MS + 1_000;
    const snap = getRetentionSubsystemSnapshot(observedAt);
    expect(snap.state).toBe("degraded");
    expect(snap.failureCount).toBe(1);
    expect(snap.firstFailureAt).toBe(NOW + RETENTION_HEARTBEAT_STALE_MS);
    expect(snap.lastRecoveredAt).toBeNull();
  });

  it("reports healthy with lastRecoveredAt = lastRunAt for a fresh sweep heartbeat", () => {
    const lastRunAtMs = NOW - 60_000; // sweep just completed a minute ago
    __seedHeartbeatForTests("sweep", new Date(lastRunAtMs));
    const snap = getRetentionSubsystemSnapshot(NOW);
    expect(snap).toEqual({
      state: "healthy",
      failureCount: 0,
      firstFailureAt: null,
      lastRecoveredAt: lastRunAtMs,
    });
  });

  it("reports degraded once the most recent sweep is older than the staleness threshold", () => {
    const lastRunAtMs = NOW - (RETENTION_HEARTBEAT_STALE_MS + 5_000);
    __seedHeartbeatForTests("sweep", new Date(lastRunAtMs));
    const snap = getRetentionSubsystemSnapshot(NOW);
    expect(snap.state).toBe("degraded");
    // `firstFailureAt` is the moment the sweep aged out — exactly
    // `lastRunAt + RETENTION_HEARTBEAT_STALE_MS` — so a duration
    // probe with a 0ms threshold pages immediately at that boundary
    // and the default 5min threshold pages a small grace tail later.
    expect(snap.firstFailureAt).toBe(
      lastRunAtMs + RETENTION_HEARTBEAT_STALE_MS,
    );
    // `lastRecoveredAt` retains the most recent successful run so
    // dashboards can still surface "last good sweep at X" alongside
    // the degraded state.
    expect(snap.lastRecoveredAt).toBe(lastRunAtMs);
    expect(snap.failureCount).toBe(1);
  });

  it("treats a sweep heartbeat exactly at the threshold as still healthy", () => {
    // Boundary case: `now - lastRunAt === STALE_MS` is the last
    // healthy moment. One ms later flips to degraded. The strict
    // `>` comparison in the helper means the threshold is inclusive
    // of "still healthy" — we lock that contract so a future refactor
    // doesn't silently page on the very edge of the window.
    const lastRunAtMs = NOW - RETENTION_HEARTBEAT_STALE_MS;
    __seedHeartbeatForTests("sweep", new Date(lastRunAtMs));
    expect(getRetentionSubsystemSnapshot(NOW).state).toBe("healthy");
    expect(getRetentionSubsystemSnapshot(NOW + 1).state).toBe("degraded");
  });

  it("ignores per-arm heartbeats when computing the overall sweep snapshot", () => {
    // Per-arm heartbeats (notifications, view_history, ...) feed the
    // OTel gauges and dashboards but MUST NOT prop up the overall
    // staleness signal — otherwise a single still-running arm could
    // mask a stuck `sweep` arm and silence the alert. We seed a
    // perfectly-fresh notifications heartbeat alongside an absent
    // sweep heartbeat to prove the snapshot decision only consults
    // the `sweep` arm.
    __seedHeartbeatForTests("notifications", new Date(NOW - 1_000));
    const snap = getRetentionSubsystemSnapshot(
      NOW + RETENTION_HEARTBEAT_STALE_MS + 1_000,
    );
    // Still inside the post-boot grace window for the missing
    // sweep arm at NOW + STALE_MS + 1s? No — process started at NOW,
    // so this observation is `STALE_MS + 1s` past boot, just past
    // the grace window. It must page.
    expect(snap.state).toBe("degraded");
  });
});

describe("getRetentionHeartbeats", () => {
  const NOW = 1_730_000_000_000;

  beforeEach(() => {
    __resetRetentionStateForTests(NOW);
  });

  it("returns a per-arm copy that callers cannot mutate", () => {
    const at = new Date(NOW - 1_000);
    __seedHeartbeatForTests("notifications", at, 42, null);
    __seedHeartbeatForTests("sweep", at, 42, null);
    const list = getRetentionHeartbeats();
    expect(list).toHaveLength(2);
    const notifications = list.find((hb) => hb.arm === "notifications");
    expect(notifications).toBeDefined();
    expect(notifications?.lastCount).toBe(42);
    expect(notifications?.lastError).toBeNull();
    // Mutating the returned objects MUST NOT bleed back into the
    // module-level cache — a future health-page handler that mutates
    // the snapshot for serialisation would otherwise silently corrupt
    // the OTel gauge readings.
    if (notifications) notifications.lastCount = -1;
    const refetched = getRetentionHeartbeats().find(
      (hb) => hb.arm === "notifications",
    );
    expect(refetched?.lastCount).toBe(42);
  });
});
