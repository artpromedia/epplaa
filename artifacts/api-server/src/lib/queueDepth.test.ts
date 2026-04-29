import { describe, it, expect } from "vitest";
import { getQueueHealthSnapshot, __QUEUE_DEPTH_DEFAULTS } from "./queueDepth";

/**
 * The aggregate query is exercised through a stub `db.execute` that
 * returns a fixed row. The test focuses on the row→snapshot mapping
 * (state thresholds, count coercion from `pg`'s string BIGINT, ISO
 * formatting), which is the part that's easy to break with a typo.
 */
function fakeDb(row: {
  pending_count: string | number;
  processing_count: string | number;
  failed_count: string | number;
  oldest_pending_at: Date | string | null;
  oldest_processing_at: Date | string | null;
}) {
  return {
    execute: async (_sql: unknown): Promise<unknown> => {
      // Mirror node-pg's `{ rows: [...] }` envelope to exercise the
      // normalisation branch.
      return { rows: [row] };
    },
  } as unknown as Parameters<typeof getQueueHealthSnapshot>[0];
}

const FIXED_NOW = Date.parse("2026-04-29T12:00:00.000Z");
const fixedNow = () => FIXED_NOW;

describe("getQueueHealthSnapshot", () => {
  it("coerces BIGINT-as-string counts and reports healthy when nothing is overdue", async () => {
    const db = fakeDb({
      pending_count: "3",
      processing_count: "1",
      failed_count: "0",
      oldest_pending_at: null,
      oldest_processing_at: null,
    });

    const snap = await getQueueHealthSnapshot(db, fixedNow);
    expect(snap.pendingCount).toBe(3);
    expect(snap.processingCount).toBe(1);
    expect(snap.failedCount).toBe(0);
    expect(snap.oldestPendingAtIso).toBeNull();
    expect(snap.oldestProcessingAtIso).toBeNull();
    expect(snap.sampledAtIso).toBe(new Date(FIXED_NOW).toISOString());
    expect(snap.state).toBe("healthy");
  });

  it("flips to degraded when there is at least one failed row", async () => {
    const db = fakeDb({
      pending_count: 0,
      processing_count: 0,
      failed_count: 4,
      oldest_pending_at: null,
      oldest_processing_at: null,
    });
    const snap = await getQueueHealthSnapshot(db, fixedNow);
    expect(snap.failedCount).toBe(4);
    expect(snap.state).toBe("degraded");
  });

  it("flips to degraded when oldest pending is older than the staleness threshold", async () => {
    const stale = new Date(FIXED_NOW - __QUEUE_DEPTH_DEFAULTS.STALE_PENDING_THRESHOLD_MS - 1_000);
    const db = fakeDb({
      pending_count: 1,
      processing_count: 0,
      failed_count: 0,
      oldest_pending_at: stale,
      oldest_processing_at: null,
    });
    const snap = await getQueueHealthSnapshot(db, fixedNow);
    expect(snap.oldestPendingAtIso).toBe(stale.toISOString());
    expect(snap.state).toBe("degraded");
  });

  it("stays healthy when oldest pending is within the staleness threshold", async () => {
    const fresh = new Date(FIXED_NOW - 30_000);
    const db = fakeDb({
      pending_count: 1,
      processing_count: 0,
      failed_count: 0,
      oldest_pending_at: fresh,
      oldest_processing_at: null,
    });
    const snap = await getQueueHealthSnapshot(db, fixedNow);
    expect(snap.oldestPendingAtIso).toBe(fresh.toISOString());
    expect(snap.state).toBe("healthy");
  });

  it("normalises raw timestamp strings (when drizzle bypasses the parser)", async () => {
    const raw = "2026-04-29 11:00:00.000+00";
    const db = fakeDb({
      pending_count: 1,
      processing_count: 1,
      failed_count: 0,
      oldest_pending_at: raw,
      oldest_processing_at: raw,
    });
    const snap = await getQueueHealthSnapshot(db, fixedNow);
    // Should parse the raw string into a real ISO timestamp.
    expect(snap.oldestPendingAtIso).toBe(new Date(raw).toISOString());
    expect(snap.oldestProcessingAtIso).toBe(new Date(raw).toISOString());
  });
});
