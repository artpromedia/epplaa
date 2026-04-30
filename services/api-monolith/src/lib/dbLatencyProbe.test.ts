import { describe, it, expect } from "vitest";
import { probeDbLatency, __DB_LATENCY_DEFAULTS } from "./dbLatencyProbe";

/**
 * The probe is exercised through a tiny fake `db.execute` so we can
 * shape latency and failures deterministically without running real
 * Postgres queries. The fake honours the call signature `db.execute(sql)`
 * and lets each call return a custom delay (or throw).
 */
function fakeDb(plan: { delayMs: number; throws?: string }[]) {
  let i = 0;
  // The probe only calls `db.execute(sql\`SELECT 1\`)` — narrow the
  // shape to that to keep the test free of drizzle internals.
  return {
    execute: async (_sql: unknown): Promise<unknown> => {
      const step = plan[i++] ?? { delayMs: 0 };
      if (step.throws) throw new Error(step.throws);
      return [];
    },
  };
}

/**
 * Deterministic clock that advances by `step.delayMs` between
 * `now()` calls inside `probeDbLatency`. The probe calls `now()`
 * twice per sample (start and elapsed) plus once more for the
 * final `lastSuccessAtMs`, then once for `startedAtMs`. We script
 * the increments rather than tying to wall time so the asserted
 * latencies are exact.
 */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

describe("probeDbLatency", () => {
  it("returns p50/p95 over the successful samples and marks healthy under threshold", async () => {
    // Drive the clock from inside the fake so each `execute` advances
    // wall time by the per-sample delay between the start and end
    // measurements.
    const c = clock();
    const plan = [{ delayMs: 5 }, { delayMs: 10 }, { delayMs: 15 }, { delayMs: 20 }, { delayMs: 25 }];
    let i = 0;
    const db = {
      execute: async (_sql: unknown): Promise<unknown> => {
        const step = plan[i++]!;
        c.advance(step.delayMs);
        return [];
      },
    } as unknown as Parameters<typeof probeDbLatency>[0]["db"];

    const snap = await probeDbLatency({
      db,
      replicaId: "test-replica",
      samples: 5,
      now: c.now,
    });

    expect(snap.replicaId).toBe("test-replica");
    expect(snap.sampleCount).toBe(5);
    expect(snap.lastError).toBeNull();
    expect(snap.lastSuccessAtIso).not.toBeNull();
    // p50 nearest-rank for n=5 = sample at index ceil(.5*5)-1 = 2 → 15ms
    expect(snap.p50LatencyMs).toBe(15);
    // p95 nearest-rank for n=5 = sample at index ceil(.95*5)-1 = 4 → 25ms
    expect(snap.p95LatencyMs).toBe(25);
    expect(snap.state).toBe("healthy");
  });

  it("marks degraded when any sample fails (intermittent pool)", async () => {
    const c = clock();
    let i = 0;
    const plan = [{ delayMs: 5 }, { throws: "ECONNRESET" }, { delayMs: 10 }];
    const db = {
      execute: async (_sql: unknown): Promise<unknown> => {
        const step = plan[i++]!;
        if (step.throws) throw new Error(step.throws);
        c.advance(step.delayMs ?? 0);
        return [];
      },
    } as unknown as Parameters<typeof probeDbLatency>[0]["db"];

    const snap = await probeDbLatency({
      db,
      replicaId: "r1",
      samples: 3,
      now: c.now,
    });

    expect(snap.sampleCount).toBe(2);
    expect(snap.lastError).toBe("ECONNRESET");
    expect(snap.state).toBe("degraded");
  });

  it("marks degraded when p95 crosses the slow-probe threshold", async () => {
    const c = clock();
    const plan = [
      { delayMs: 1 },
      { delayMs: 1 },
      { delayMs: 1 },
      { delayMs: 1 },
      { delayMs: __DB_LATENCY_DEFAULTS.SLOW_PROBE_THRESHOLD_MS + 50 },
    ];
    let i = 0;
    const db = {
      execute: async (_sql: unknown): Promise<unknown> => {
        const step = plan[i++]!;
        c.advance(step.delayMs);
        return [];
      },
    } as unknown as Parameters<typeof probeDbLatency>[0]["db"];

    const snap = await probeDbLatency({
      db,
      replicaId: "r1",
      samples: 5,
      now: c.now,
    });

    expect(snap.lastError).toBeNull();
    // p95 (index 4) is the slow sample → degraded
    expect(snap.p95LatencyMs).toBeGreaterThan(__DB_LATENCY_DEFAULTS.SLOW_PROBE_THRESHOLD_MS);
    expect(snap.state).toBe("degraded");
  });

  it("returns sampleCount=0 / null percentiles / degraded when every probe fails", async () => {
    const db = fakeDb([
      { delayMs: 0, throws: "fail" },
      { delayMs: 0, throws: "fail" },
      { delayMs: 0, throws: "fail" },
    ]) as unknown as Parameters<typeof probeDbLatency>[0]["db"];

    const snap = await probeDbLatency({
      db,
      replicaId: "r1",
      samples: 3,
    });

    expect(snap.sampleCount).toBe(0);
    expect(snap.p50LatencyMs).toBeNull();
    expect(snap.p95LatencyMs).toBeNull();
    expect(snap.lastSuccessAtIso).toBeNull();
    expect(snap.lastError).toBe("fail");
    expect(snap.state).toBe("degraded");
  });
});
