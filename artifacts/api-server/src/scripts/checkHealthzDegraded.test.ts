import { describe, it, expect, vi } from "vitest";
import {
  evaluateHealthz,
  exitCodeFor,
  main,
  parseDurationMs,
  type HealthzBody,
  type SubsystemEntry,
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

describe("evaluateHealthz (multi-subsystem)", () => {
  const NOW = 1_700_000_300_000;
  const THRESHOLD = 60_000;

  function bodyWithSubsystems(
    subsystems: Record<string, SubsystemEntry>,
  ): HealthzBody {
    return { status: "ok", subsystems };
  }

  function healthy(): SubsystemEntry {
    return {
      state: "healthy",
      failureCount: 0,
      firstFailureAt: null,
      lastRecoveredAt: null,
    };
  }

  function degraded(firstFailureAt: number, failureCount = 1): SubsystemEntry {
    return {
      state: "degraded",
      failureCount,
      firstFailureAt,
      lastRecoveredAt: null,
    };
  }

  it("returns healthy when every subsystem is healthy", () => {
    const r = evaluateHealthz(
      bodyWithSubsystems({
        rateLimitStore: healthy(),
        db: healthy(),
        auditChain: healthy(),
      }),
      NOW,
      THRESHOLD,
    );
    expect(r.outcome).toBe("healthy");
    // First by name when all healthy. Sorted alphabetically:
    // auditChain < db < rateLimitStore.
    expect(r.subsystem).toBe("auditChain");
    expect(r.durationMs).toBeNull();
    expect(r.subsystems).toHaveLength(3);
    expect(r.subsystems.every((s) => s.outcome === "healthy")).toBe(true);
    expect(exitCodeFor(r.outcome)).toBe(0);
  });

  it("pages and names auditChain when the audit pipeline is stuck degraded and the rest are healthy", () => {
    // The audit pipeline has been stuck for 4 minutes — the
    // recordAudit() failure-streak watcher has been reporting
    // degraded since then with no recovery, which means the
    // compliance-required hash chain is silently dead-lettering or
    // worse, dropping rows entirely. The duration alert must page
    // and name `auditChain` so on-call doesn't have to re-curl
    // /healthz to know which subsystem to triage. This is the
    // end-to-end "audit pipeline stuck degraded -> /healthz reports
    // degraded -> probe pages" coverage required by task #65.
    const r = evaluateHealthz(
      bodyWithSubsystems({
        rateLimitStore: healthy(),
        db: healthy(),
        auditChain: degraded(NOW - 240_000, 42),
      }),
      NOW,
      THRESHOLD,
    );
    expect(r.outcome).toBe("page");
    expect(r.subsystem).toBe("auditChain");
    expect(r.durationMs).toBe(240_000);
    expect(r.reason).toContain("auditChain degraded for 240000ms");
    expect(r.reason).toContain("threshold 60000ms");
    expect(exitCodeFor(r.outcome)).toBe(2);
    // Per-subsystem detail is preserved so the page body shows the
    // healthy siblings too — important when triaging whether the
    // audit pipeline failure is correlated with DB pressure.
    const auditEval = r.subsystems.find((s) => s.name === "auditChain")!;
    const dbEval = r.subsystems.find((s) => s.name === "db")!;
    expect(auditEval.outcome).toBe("page");
    expect(dbEval.outcome).toBe("healthy");
  });

  it("pages with auditChain named first when audit and rate-limit are both page-worthy and audit's streak is longer", () => {
    // A correlated outage: the DB is fine but both the audit
    // pipeline AND the rate-limit Redis store are stuck. The audit
    // streak is longer so it wins primary-name placement; the
    // reason still lists every offender so on-call sees both
    // failures at once and doesn't accidentally close the incident
    // after fixing only one.
    const r = evaluateHealthz(
      bodyWithSubsystems({
        rateLimitStore: degraded(NOW - 90_000),
        db: healthy(),
        auditChain: degraded(NOW - 300_000, 27),
      }),
      NOW,
      THRESHOLD,
    );
    expect(r.outcome).toBe("page");
    expect(r.subsystem).toBe("auditChain");
    expect(r.durationMs).toBe(300_000);
    expect(r.reason).toContain("multiple subsystems page-worthy");
    expect(r.reason).toContain("auditChain degraded for 300000ms");
    expect(r.reason).toContain("rateLimitStore degraded for 90000ms");
  });

  it("does not page when auditChain has been degraded only briefly (under threshold)", () => {
    // A short-lived audit-pipeline blip — the kind a single failed
    // insert produces — must NOT page. The duration alert is
    // designed to ignore one-off transients that recordAudit's DLQ
    // is built to absorb; only a *sustained* outage should escalate.
    const r = evaluateHealthz(
      bodyWithSubsystems({
        rateLimitStore: healthy(),
        db: healthy(),
        auditChain: degraded(NOW - 15_000),
      }),
      NOW,
      THRESHOLD,
    );
    expect(r.outcome).toBe("below_threshold");
    expect(r.subsystem).toBe("auditChain");
    expect(r.durationMs).toBe(15_000);
    expect(exitCodeFor(r.outcome)).toBe(0);
  });

  it("pages and names the offending subsystem when one is stuck degraded and the rest are healthy", () => {
    // db has been degraded for 90s; rate limit store is fine. The
    // page reason must point at db so on-call knows where to look
    // without re-curling /healthz.
    const r = evaluateHealthz(
      bodyWithSubsystems({
        rateLimitStore: healthy(),
        db: degraded(NOW - 90_000, 9),
      }),
      NOW,
      THRESHOLD,
    );
    expect(r.outcome).toBe("page");
    expect(r.subsystem).toBe("db");
    expect(r.durationMs).toBe(90_000);
    expect(r.reason).toContain("db degraded for 90000ms");
    expect(r.reason).toContain("threshold 60000ms");
    expect(exitCodeFor(r.outcome)).toBe(2);
    // Per-subsystem detail is preserved so the page body shows the
    // healthy siblings too.
    const dbEval = r.subsystems.find((s) => s.name === "db")!;
    const rlEval = r.subsystems.find((s) => s.name === "rateLimitStore")!;
    expect(dbEval.outcome).toBe("page");
    expect(rlEval.outcome).toBe("healthy");
  });

  it("pages with the longer-streak subsystem named when multiple subsystems exceed threshold", () => {
    // Both subsystems are page-worthy; db has been broken longer so
    // it should be named as the primary, but the reason must list
    // both offenders so the correlated outage is visible.
    const r = evaluateHealthz(
      bodyWithSubsystems({
        rateLimitStore: degraded(NOW - 70_000),
        db: degraded(NOW - 200_000),
      }),
      NOW,
      THRESHOLD,
    );
    expect(r.outcome).toBe("page");
    expect(r.subsystem).toBe("db");
    expect(r.durationMs).toBe(200_000);
    expect(r.reason).toContain("multiple subsystems page-worthy");
    expect(r.reason).toContain("db degraded for 200000ms");
    expect(r.reason).toContain("rateLimitStore degraded for 70000ms");
  });

  it("returns below_threshold when a subsystem is degraded but inside threshold", () => {
    // 30s streak vs 60s threshold; nothing else is degraded.
    const r = evaluateHealthz(
      bodyWithSubsystems({
        rateLimitStore: healthy(),
        db: degraded(NOW - 30_000),
      }),
      NOW,
      THRESHOLD,
    );
    expect(r.outcome).toBe("below_threshold");
    expect(r.subsystem).toBe("db");
    expect(r.durationMs).toBe(30_000);
    expect(exitCodeFor(r.outcome)).toBe(0);
  });

  it("does NOT page at exactly the threshold boundary", () => {
    // Strict-greater-than so a single-tick race at the boundary does
    // not flap. Documented behaviour the test pins.
    const r = evaluateHealthz(
      bodyWithSubsystems({
        rateLimitStore: degraded(NOW - THRESHOLD),
        db: healthy(),
      }),
      NOW,
      THRESHOLD,
    );
    expect(r.outcome).toBe("below_threshold");
    expect(r.subsystem).toBe("rateLimitStore");
    expect(r.durationMs).toBe(THRESHOLD);
  });

  it("clamps negative durations from clock skew to 0 instead of paging", () => {
    // Probe host's clock is behind the api host's. Treat as "just
    // started" rather than wrapping into a huge positive number or
    // producing a confusing reason line.
    const r = evaluateHealthz(
      bodyWithSubsystems({
        rateLimitStore: healthy(),
        db: degraded(NOW + 5_000),
      }),
      NOW,
      THRESHOLD,
    );
    expect(r.outcome).toBe("below_threshold");
    expect(r.durationMs).toBe(0);
  });

  it("pages when a subsystem state=degraded but firstFailureAt is missing/invalid", () => {
    // The watcher should always set firstFailureAt while degraded.
    // Missing it means a regression or a shape change that on-call
    // should investigate immediately.
    for (const bad of [null, undefined, "not-a-number", NaN]) {
      const r = evaluateHealthz(
        bodyWithSubsystems({
          rateLimitStore: healthy(),
          db: {
            state: "degraded",
            failureCount: 1,
            firstFailureAt: bad as unknown as number,
            lastRecoveredAt: null,
          },
        }),
        NOW,
        THRESHOLD,
      );
      expect(r.outcome, `bad=${String(bad)}`).toBe("page");
      expect(r.subsystem).toBe("db");
      expect(r.reason).toContain("db.state=degraded but firstFailureAt missing/invalid");
    }
  });

  it("pages when a subsystem state is missing or unrecognised", () => {
    const r = evaluateHealthz(
      bodyWithSubsystems({
        rateLimitStore: healthy(),
        db: { state: "weird-new-value" } as never,
      }),
      NOW,
      THRESHOLD,
    );
    expect(r.outcome).toBe("page");
    expect(r.subsystem).toBe("db");
    expect(r.reason).toMatch(/db\.state missing or unrecognised/);
  });

  it("pages when the body has no recognisable subsystems block at all (response shape regression)", () => {
    for (const body of [
      {} as HealthzBody,
      { status: "ok" } as HealthzBody,
      { subsystems: "not-an-object" } as HealthzBody,
      { subsystems: [] as unknown } as HealthzBody,
    ]) {
      const r = evaluateHealthz(body, NOW, THRESHOLD);
      expect(r.outcome).toBe("page");
      expect(r.subsystem).toBeNull();
      expect(r.subsystems).toHaveLength(0);
      expect(r.reason).toMatch(/no recognisable subsystems/);
    }
  });

  it("falls back to the legacy top-level rateLimitStore field when subsystems map is absent", () => {
    // Back-compat: during a rolling deploy the probe might run against
    // an api-server replica that still serves the pre-subsystems-map
    // /healthz shape. The duration alert must keep working.
    const r = evaluateHealthz(
      {
        status: "ok",
        rateLimitStore: {
          kind: "redis",
          state: "degraded",
          failureCount: 5,
          firstFailureAt: NOW - 90_000,
          lastRecoveredAt: null,
        },
      },
      NOW,
      THRESHOLD,
    );
    expect(r.outcome).toBe("page");
    expect(r.subsystem).toBe("rateLimitStore");
    expect(r.durationMs).toBe(90_000);
    expect(r.reason).toContain("rateLimitStore degraded for 90000ms");
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

  it("exits 0 and logs healthy when every subsystem reports healthy", async () => {
    const io = makeIo();
    const code = await main({
      env: { HEALTHZ_URL: "http://x/healthz" },
      now: () => 1_700_000_000_000,
      fetchImpl: async () => ({
        ok: true,
        httpStatus: 200,
        body: {
          status: "ok",
          subsystems: {
            rateLimitStore: {
              state: "healthy",
              failureCount: 0,
              firstFailureAt: null,
              lastRecoveredAt: null,
            },
            db: {
              state: "healthy",
              failureCount: 0,
              firstFailureAt: null,
              lastRecoveredAt: null,
            },
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
    expect(parsed.subsystems).toHaveLength(2);
  });

  it("exits 2 when one subsystem's streak exceeds the threshold while others are healthy", async () => {
    const io = makeIo();
    const NOW = 1_700_000_500_000;
    const code = await main({
      env: {
        HEALTHZ_URL: "http://x/healthz",
        HEALTHZ_DEGRADED_ALERT_THRESHOLD_MS: "100000",
      },
      now: () => NOW,
      fetchImpl: async () => ({
        ok: true,
        httpStatus: 200,
        body: {
          subsystems: {
            rateLimitStore: {
              state: "healthy",
              failureCount: 0,
              firstFailureAt: null,
              lastRecoveredAt: null,
            },
            db: {
              state: "degraded",
              failureCount: 12,
              firstFailureAt: NOW - 200_000,
              lastRecoveredAt: null,
            },
          },
        },
      }),
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(2);
    const parsed = JSON.parse(io.stdoutLines[0]!);
    expect(parsed.outcome).toBe("page");
    expect(parsed.subsystem).toBe("db");
    expect(parsed.durationMs).toBe(200_000);
    expect(parsed.thresholdMs).toBe(100_000);
    expect(parsed.reason).toContain("db degraded for 200000ms");
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
          subsystems: {
            rateLimitStore: {
              state: "healthy",
              failureCount: 0,
              firstFailureAt: null,
              lastRecoveredAt: null,
            },
            db: {
              state: "degraded",
              failureCount: 2,
              firstFailureAt: NOW - 4 * 60 * 1000,
              lastRecoveredAt: null,
            },
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
