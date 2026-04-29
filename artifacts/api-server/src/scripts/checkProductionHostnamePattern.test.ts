import { describe, it, expect, vi } from "vitest";
import {
  evaluateReadyz,
  exitCodeFor,
  main,
  parseTimeoutMs,
  type ReadyzBody,
} from "./checkProductionHostnamePattern";

describe("parseTimeoutMs", () => {
  // Same sanitisation contract as the readyz route's
  // READYZ_DB_TIMEOUT_MS: a typo'd env var must NOT silently turn the
  // probe into either a fire-immediately timer (NaN / 0) or a
  // permanently-blocking probe (negative).
  it("returns the parsed integer when the env var is a positive number", () => {
    expect(parseTimeoutMs("12345", 999)).toBe(12345);
    expect(parseTimeoutMs("123.9", 999)).toBe(123);
  });

  it("falls back when the env var is missing, NaN, zero, or negative", () => {
    for (const bogus of [undefined, "", "abc", "0", "-1", "-1000"]) {
      expect(parseTimeoutMs(bogus, 5000), `bogus=${String(bogus)}`).toBe(
        5000,
      );
    }
  });
});

describe("exitCodeFor", () => {
  // Centralised mapping — keep the script and any external alerting
  // wrappers in sync. `not_required` and `configured` both exit 0
  // intentionally (a single workflow can fan out across many
  // environments without flapping).
  it("maps each outcome to the documented exit code", () => {
    expect(exitCodeFor("configured")).toBe(0);
    expect(exitCodeFor("not_required")).toBe(0);
    expect(exitCodeFor("missing")).toBe(2);
    expect(exitCodeFor("probe_error")).toBe(1);
  });
});

describe("evaluateReadyz — pure decision matrix", () => {
  function bodyWith(value: unknown): ReadyzBody {
    return { config: { productionHostnamePattern: value } };
  }

  it("returns 'configured' for a healthy production deploy", () => {
    const r = evaluateReadyz(bodyWith("configured"));
    expect(r.outcome).toBe("configured");
    expect(r.observed).toBe("configured");
  });

  it("returns 'not_required' for a non-production deploy (staging / dev / preview)", () => {
    const r = evaluateReadyz(bodyWith("not_required"));
    expect(r.outcome).toBe("not_required");
  });

  it("returns 'missing' for a production deploy whose env var is unset — this is the page condition", () => {
    const r = evaluateReadyz(bodyWith("missing"));
    expect(r.outcome).toBe("missing");
    // Reason must mention the env var by name AND point at the
    // runbook so the on-call page body is self-contained.
    expect(r.reason).toContain("PRODUCTION_HOSTNAME_PATTERN");
    expect(r.reason).toContain("staging-only-endpoints.md");
  });

  it("returns 'probe_error' when the config block is missing entirely", () => {
    // A response missing `config` is a version-skew or response-shape
    // regression — escalate to a human rather than silently treating
    // it as healthy.
    const r = evaluateReadyz({});
    expect(r.outcome).toBe("probe_error");
    expect(r.reason).toContain("missing the `config` block");
  });

  it("returns 'probe_error' when config is null / array / non-object (defensive against bad responses)", () => {
    expect(evaluateReadyz({ config: null }).outcome).toBe("probe_error");
    expect(evaluateReadyz({ config: [] as unknown }).outcome).toBe(
      "probe_error",
    );
    expect(evaluateReadyz({ config: "oops" }).outcome).toBe("probe_error");
  });

  it("returns 'probe_error' for an unrecognised value rather than silently passing", () => {
    // If a future change adds a fourth status (e.g. "deferred")
    // without updating the probe, we want the page to fire so the
    // operator notices — not silently classify it as healthy.
    const r = evaluateReadyz(bodyWith("deferred"));
    expect(r.outcome).toBe("probe_error");
    expect(r.reason).toContain("unrecognised value");
    expect(r.observed).toBe("deferred");
  });
});

describe("main — CLI entrypoint", () => {
  // These tests drive `main` with a mock fetch + capture stdout/stderr
  // so we can assert on the structured log line the cron wrapper
  // consumes. We deliberately do NOT spin up a real HTTP server: the
  // route-level tests in `routes/health.test.ts` already cover the
  // wire shape, and this layer's job is the decision logic.

  function runWith(args: {
    env: NodeJS.ProcessEnv;
    fetchResult:
      | { ok: true; body: ReadyzBody; httpStatus: number }
      | { ok: false; error: string };
  }) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const fetchImpl = vi.fn().mockResolvedValue(args.fetchResult);
    return {
      stdout,
      stderr,
      fetchImpl,
      run: () =>
        main({
          env: args.env,
          fetchImpl,
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
        }),
    };
  }

  it("exits 1 with a stderr message when READYZ_URL is unset", async () => {
    const { run, stderr, fetchImpl } = runWith({
      env: {},
      fetchResult: { ok: false, error: "unused" },
    });
    const code = await run();
    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("READYZ_URL is required");
    // Must NOT have called fetch — fail fast on misconfiguration.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("exits 1 with a structured stderr line when fetch fails (network / timeout)", async () => {
    const { run, stderr } = runWith({
      env: { READYZ_URL: "https://api.example.com/api/readyz" },
      fetchResult: { ok: false, error: "probe timeout after 5000ms" },
    });
    const code = await run();
    expect(code).toBe(1);
    const line = JSON.parse(stderr[0]!);
    expect(line.outcome).toBe("probe_error");
    expect(line.url).toBe("https://api.example.com/api/readyz");
    expect(line.error).toContain("probe timeout");
  });

  it("exits 0 and emits a structured stdout line when the deploy is configured", async () => {
    const { run, stdout, stderr } = runWith({
      env: { READYZ_URL: "https://api.example.com/api/readyz" },
      fetchResult: {
        ok: true,
        body: { config: { productionHostnamePattern: "configured" } },
        httpStatus: 200,
      },
    });
    const code = await run();
    expect(code).toBe(0);
    expect(stderr).toHaveLength(0);
    const line = JSON.parse(stdout[0]!);
    expect(line.outcome).toBe("configured");
    expect(line.httpStatus).toBe(200);
  });

  it("exits 0 (silent) when the deploy is non-production (not_required) — same workflow can fan out across envs without flapping", async () => {
    const { run, stdout } = runWith({
      env: { READYZ_URL: "https://staging.example.com/api/readyz" },
      fetchResult: {
        ok: true,
        body: { config: { productionHostnamePattern: "not_required" } },
        httpStatus: 200,
      },
    });
    expect(await run()).toBe(0);
    expect(JSON.parse(stdout[0]!).outcome).toBe("not_required");
  });

  it("exits 2 (page on-call) when the production deploy reports the pattern is missing", async () => {
    const { run, stdout } = runWith({
      env: { READYZ_URL: "https://api.example.com/api/readyz" },
      fetchResult: {
        ok: true,
        body: { config: { productionHostnamePattern: "missing" } },
        httpStatus: 200,
      },
    });
    expect(await run()).toBe(2);
    const line = JSON.parse(stdout[0]!);
    expect(line.outcome).toBe("missing");
    expect(line.reason).toContain("PRODUCTION_HOSTNAME_PATTERN");
  });

  it("still exits 2 when /readyz returns 503 not_ready but the config block reports missing — never lose the page during a downstream outage", async () => {
    // The worst-case combination is a misconfigured production deploy
    // AND a degraded dependency. Gating on HTTP 200 here would
    // silently paper over the misconfiguration during exactly the
    // window when on-call most needs to see it.
    const { run } = runWith({
      env: { READYZ_URL: "https://api.example.com/api/readyz" },
      fetchResult: {
        ok: true,
        body: {
          status: "not_ready",
          checks: { db: "failed", redis: "ok" },
          failures: { db: "ECONNREFUSED" },
          config: { productionHostnamePattern: "missing" },
        },
        httpStatus: 503,
      },
    });
    expect(await run()).toBe(2);
  });

  it("exits 1 (probe_error) when the config block is missing — surfaces a response-shape regression instead of silently passing", async () => {
    const { run } = runWith({
      env: { READYZ_URL: "https://api.example.com/api/readyz" },
      fetchResult: {
        ok: true,
        body: { status: "ready", checks: { db: "ok" } },
        httpStatus: 200,
      },
    });
    expect(await run()).toBe(1);
  });

  it("uses READYZ_PROBE_TIMEOUT_MS when set and falls back to the default when bogus", async () => {
    const calls: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockImplementation(async (_url: string, timeoutMs: number) => {
        calls.push(timeoutMs);
        return {
          ok: true,
          body: { config: { productionHostnamePattern: "configured" } },
          httpStatus: 200,
        };
      });
    await main({
      env: {
        READYZ_URL: "https://api.example.com/api/readyz",
        READYZ_PROBE_TIMEOUT_MS: "1234",
      },
      fetchImpl,
      stdout: () => {},
      stderr: () => {},
    });
    await main({
      env: {
        READYZ_URL: "https://api.example.com/api/readyz",
        READYZ_PROBE_TIMEOUT_MS: "garbage",
      },
      fetchImpl,
      stdout: () => {},
      stderr: () => {},
    });
    expect(calls).toEqual([1234, 5000]);
  });
});
