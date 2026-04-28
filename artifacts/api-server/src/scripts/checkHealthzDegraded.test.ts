import { describe, it, expect, vi } from "vitest";
import {
  evaluateHealthz,
  exitCodeFor,
  main,
  parseDurationMs,
  type HealthzBody,
} from "./checkHealthzDegraded";

describe("parseDurationMs", () => {
  it("returns the parsed integer when the env var is a positive number", () => {
    expect(parseDurationMs("12345", 999)).toBe(12345);
    // Decimals truncate so the resulting timer is always integer ms.
    expect(parseDurationMs("123.9", 999)).toBe(123);
  });

  it("falls back when the env var is missing, NaN, zero, or negative", () => {
    // These would all turn into either a NaN setTimeout (fires
    // immediately) or a permanently-silent alert if not sanitised.
    for (const bogus of [undefined, "", "abc", "0", "-1", "-10000"]) {
      expect(parseDurationMs(bogus, 5000), `bogus=${String(bogus)}`).toBe(5000);
    }
  });
});

describe("evaluateHealthz", () => {
  const NOW = 1_700_000_300_000;
  const THRESHOLD = 60_000;

  function bodyWith(rateLimitStore: HealthzBody["rateLimitStore"]): HealthzBody {
    return { status: "ok", rateLimitStore };
  }

  it("returns healthy when state=healthy regardless of other fields", () => {
    const r = evaluateHealthz(
      bodyWith({
        kind: "redis",
        state: "healthy",
        failureCount: 0,
        firstFailureAt: null,
        lastRecoveredAt: 1_700_000_000_000,
      }),
      NOW,
      THRESHOLD,
    );
    expect(r.outcome).toBe("healthy");
    expect(r.durationMs).toBeNull();
    expect(r.firstFailureAt).toBeNull();
    expect(r.thresholdMs).toBe(THRESHOLD);
  });

  it("does not page when degraded streak is shorter than threshold", () => {
    // Streak began 30s ago; threshold is 60s -> still under.
    const r = evaluateHealthz(
      bodyWith({
        kind: "redis",
        state: "degraded",
        failureCount: 2,
        firstFailureAt: NOW - 30_000,
        lastRecoveredAt: null,
      }),
      NOW,
      THRESHOLD,
    );
    expect(r.outcome).toBe("below_threshold");
    expect(r.durationMs).toBe(30_000);
    expect(exitCodeFor(r.outcome)).toBe(0);
  });

  it("pages when the degraded streak exceeds the threshold", () => {
    // 90s degraded streak vs 60s threshold -> page.
    const firstFailureAt = NOW - 90_000;
    const r = evaluateHealthz(
      bodyWith({
        kind: "redis",
        state: "degraded",
        failureCount: 7,
        firstFailureAt,
        lastRecoveredAt: null,
      }),
      NOW,
      THRESHOLD,
    );
    expect(r.outcome).toBe("page");
    expect(r.durationMs).toBe(90_000);
    expect(r.firstFailureAt).toBe(firstFailureAt);
    expect(r.reason).toContain("degraded for 90000ms");
    expect(r.reason).toContain("threshold 60000ms");
    expect(exitCodeFor(r.outcome)).toBe(2);
  });

  it("does NOT page when streak duration is exactly equal to threshold (boundary)", () => {
    // Use strict-greater-than so a single-tick race at the threshold
    // boundary doesn't flap. Documented behaviour the test pins.
    const r = evaluateHealthz(
      bodyWith({
        kind: "redis",
        state: "degraded",
        failureCount: 3,
        firstFailureAt: NOW - THRESHOLD,
        lastRecoveredAt: null,
      }),
      NOW,
      THRESHOLD,
    );
    expect(r.outcome).toBe("below_threshold");
    expect(r.durationMs).toBe(THRESHOLD);
  });

  it("clamps negative durations from clock skew to 0 instead of paging", () => {
    // If the probe host's clock is behind the api host's, now-firstFailureAt
    // could be negative. Treat as "just started" rather than wrapping
    // into a huge positive number or producing a confusing reason line.
    const r = evaluateHealthz(
      bodyWith({
        kind: "redis",
        state: "degraded",
        failureCount: 1,
        firstFailureAt: NOW + 5_000,
        lastRecoveredAt: null,
      }),
      NOW,
      THRESHOLD,
    );
    expect(r.outcome).toBe("below_threshold");
    expect(r.durationMs).toBe(0);
  });

  it("pages when state=degraded but firstFailureAt is missing/invalid", () => {
    // The watcher should always set firstFailureAt while degraded.
    // Missing it means a regression or a shape change that on-call
    // should investigate immediately.
    for (const bad of [null, undefined, "not-a-number", NaN]) {
      const r = evaluateHealthz(
        bodyWith({
          kind: "redis",
          state: "degraded",
          failureCount: 1,
          firstFailureAt: bad as unknown as number,
          lastRecoveredAt: null,
        }),
        NOW,
        THRESHOLD,
      );
      expect(r.outcome, `bad=${String(bad)}`).toBe("page");
      expect(r.reason).toContain("firstFailureAt missing/invalid");
    }
  });

  it("pages when rateLimitStore.state is missing or unrecognised", () => {
    for (const body of [
      {} as HealthzBody,
      { rateLimitStore: {} } as HealthzBody,
      bodyWith({ kind: "redis", state: "weird-new-value" } as never),
      bodyWith({ kind: "redis", state: 42 as never }),
    ]) {
      const r = evaluateHealthz(body, NOW, THRESHOLD);
      expect(r.outcome).toBe("page");
      expect(r.reason).toMatch(/state missing or unrecognised/);
    }
  });
});

describe("main (runner)", () => {
  function makeIo() {
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    return {
      stdout: (s: string) => stdoutLines.push(s),
      stderr: (s: string) => stderrLines.push(s),
      stdoutLines,
      stderrLines,
    };
  }

  it("exits 1 with a clear stderr when HEALTHZ_URL is unset", async () => {
    const io = makeIo();
    const code = await main({
      env: {},
      now: () => 0,
      fetchImpl: vi.fn(),
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(1);
    expect(io.stderrLines.join("\n")).toMatch(/HEALTHZ_URL is required/);
  });

  it("exits 1 with a structured stderr line on probe error (network/non-2xx)", async () => {
    const io = makeIo();
    const code = await main({
      env: { HEALTHZ_URL: "http://x/healthz" },
      now: () => 0,
      fetchImpl: async () => ({ ok: false, error: "non-2xx response: HTTP 502" }),
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(1);
    const parsed = JSON.parse(io.stderrLines[0]!);
    expect(parsed).toMatchObject({
      check: "healthz_degraded",
      outcome: "probe_error",
      url: "http://x/healthz",
      error: "non-2xx response: HTTP 502",
    });
  });

  it("exits 0 and logs healthy when /healthz reports healthy", async () => {
    const io = makeIo();
    const code = await main({
      env: { HEALTHZ_URL: "http://x/healthz" },
      now: () => 1_700_000_000_000,
      fetchImpl: async () => ({
        ok: true,
        httpStatus: 200,
        body: {
          status: "ok",
          rateLimitStore: {
            kind: "redis",
            state: "healthy",
            failureCount: 0,
            firstFailureAt: null,
            lastRecoveredAt: null,
          },
        },
      }),
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(io.stdoutLines[0]!);
    expect(parsed.outcome).toBe("healthy");
    expect(parsed.httpStatus).toBe(200);
  });

  it("exits 2 when degraded streak exceeds the configured threshold", async () => {
    const io = makeIo();
    const NOW = 1_700_000_500_000;
    const code = await main({
      // 100s threshold, streak of 200s -> page.
      env: {
        HEALTHZ_URL: "http://x/healthz",
        HEALTHZ_DEGRADED_ALERT_THRESHOLD_MS: "100000",
      },
      now: () => NOW,
      fetchImpl: async () => ({
        ok: true,
        httpStatus: 200,
        body: {
          rateLimitStore: {
            kind: "redis",
            state: "degraded",
            failureCount: 9,
            firstFailureAt: NOW - 200_000,
            lastRecoveredAt: null,
          },
        },
      }),
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(2);
    const parsed = JSON.parse(io.stdoutLines[0]!);
    expect(parsed.outcome).toBe("page");
    expect(parsed.durationMs).toBe(200_000);
    expect(parsed.thresholdMs).toBe(100_000);
  });

  it("uses the default 5-minute threshold when env var is not provided", async () => {
    const io = makeIo();
    const NOW = 1_700_000_600_000;
    // 4-minute streak < default 5-minute threshold -> no page.
    const code = await main({
      env: { HEALTHZ_URL: "http://x/healthz" },
      now: () => NOW,
      fetchImpl: async () => ({
        ok: true,
        httpStatus: 200,
        body: {
          rateLimitStore: {
            kind: "redis",
            state: "degraded",
            failureCount: 2,
            firstFailureAt: NOW - 4 * 60 * 1000,
            lastRecoveredAt: null,
          },
        },
      }),
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(io.stdoutLines[0]!);
    expect(parsed.outcome).toBe("below_threshold");
    expect(parsed.thresholdMs).toBe(5 * 60 * 1000);
  });
});
