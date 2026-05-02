import { describe, it, expect, vi } from "vitest";
import { ShadowOutboxWatcher } from "../lib/ShadowOutboxWatcher.js";
import {
  outboxQueueDepth,
  outboxOldestPendingAgeSeconds,
  outboxPollErrorsTotal,
  metricsRegistry,
} from "../lib/observability.js";

function fakeDb(rows: unknown[]): { execute: ReturnType<typeof vi.fn> } {
  return { execute: vi.fn(async () => ({ rows })) };
}

describe("ShadowOutboxWatcher", () => {
  it("reads counts and oldest age into prometheus gauges", async () => {
    const oldestPending = new Date(Date.now() - 90_000); // 90s ago
    const w = new ShadowOutboxWatcher({
      databaseUrl: "postgres://unused",
      // @ts-expect-error — injecting a duck-typed db handle is the test seam
      db: fakeDb([
        {
          pending_count: "12",
          processing_count: "3",
          failed_count: "1",
          oldest_pending_at: oldestPending,
        },
      ]),
    });

    const snapshot = await w.tick();
    expect(snapshot.pendingCount).toBe(12);
    expect(snapshot.processingCount).toBe(3);
    expect(snapshot.failedCount).toBe(1);
    expect(snapshot.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(85);

    const metrics = await metricsRegistry.metrics();
    expect(metrics).toContain('epplaa_notification_outbox_queue_depth{status="pending"} 12');
    expect(metrics).toContain('epplaa_notification_outbox_queue_depth{status="processing"} 3');
    expect(metrics).toContain('epplaa_notification_outbox_queue_depth{status="failed"} 1');
  });

  it("reports negative counts and increments error counter on db failures", async () => {
    // Snapshot the value (not the live reference) before tick().
    const beforeVal = (await outboxPollErrorsTotal.get()).values[0]?.value ?? 0;
    const w = new ShadowOutboxWatcher({
      databaseUrl: "postgres://unused",
      // @ts-expect-error — duck-typed test db that throws
      db: { execute: async () => { throw new Error("connection refused"); } },
    });
    const snap = await w.tick();
    expect(snap.pendingCount).toBe(-1);
    const afterVal = (await outboxPollErrorsTotal.get()).values[0]?.value ?? 0;
    expect(afterVal).toBeGreaterThan(beforeVal);
  });

  it("reports zero ages when no pending rows are due", async () => {
    const w = new ShadowOutboxWatcher({
      databaseUrl: "postgres://unused",
      // @ts-expect-error — duck-typed test db
      db: fakeDb([
        {
          pending_count: 0,
          processing_count: 0,
          failed_count: 0,
          oldest_pending_at: null,
        },
      ]),
    });
    const snap = await w.tick();
    expect(snap).toEqual({
      pendingCount: 0,
      processingCount: 0,
      failedCount: 0,
      oldestPendingAgeSeconds: 0,
    });
    const ageGauge = await outboxOldestPendingAgeSeconds.get();
    expect(ageGauge.values[0]?.value).toBe(0);
  });
});
