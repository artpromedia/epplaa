import { describe, expect, it, vi } from "vitest";
import {
  evaluateProbe,
  evaluateReadyzDependencyProbes,
  exitCodeFor,
  main,
  parseTimeoutMs,
  PROBES,
  type ProbeName,
  type ReadyzBody,
} from "./checkReadyzDependencyProbeWireShape.ts";

/**
 * Build a minimal /readyz body with the dependency-probe blocks for
 * every (probe, state) combination the scenario asks for. Anything
 * not specified per probe defaults to a documented "skipped" /
 * disabled-config state so individual tests only need to express
 * the cell they care about.
 */
function buildBody(
  cells: Partial<
    Record<
      ProbeName,
      {
        check?: unknown;
        failure?: unknown;
        config?: unknown;
        omitFromConfig?: boolean;
      }
    >
  >,
  overrides: Partial<ReadyzBody> = {},
): ReadyzBody {
  const checks: Record<string, unknown> = {};
  const failures: Record<string, unknown> = {};
  const dependencyProbes: Record<string, unknown> = {};
  for (const probe of PROBES) {
    const cell = cells[probe] ?? {};
    if (cell.check !== undefined || "check" in cell) {
      checks[probe] = cell.check;
    } else {
      checks[probe] = "skipped";
    }
    if ("failure" in cell) {
      failures[probe] = cell.failure;
    }
    if (cell.omitFromConfig) continue;
    if (cell.config !== undefined) {
      dependencyProbes[probe] = cell.config;
    } else {
      dependencyProbes[probe] = {
        enabled: false,
        url: `https://api.${probe}.test`,
        timeoutMs: 2000,
      };
    }
  }
  return {
    checks,
    failures,
    config: { dependencyProbes },
    ...overrides,
  };
}

describe("parseTimeoutMs", () => {
  it("returns the parsed positive integer", () => {
    expect(parseTimeoutMs("1234", 5000)).toBe(1234);
    expect(parseTimeoutMs("1234.7", 5000)).toBe(1234);
  });
  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["NaN", "abc"],
    ["zero", "0"],
    ["negative", "-1"],
    ["Infinity", "Infinity"],
  ] as const)("falls back when raw is %s", (_label, raw) => {
    expect(parseTimeoutMs(raw, 5000)).toBe(5000);
  });
});

describe("PROBES — closed set", () => {
  it("is exactly the documented set in the runbook", () => {
    // Pinning the closed set so a future fourth probe MUST be added
    // here in lockstep with the runbook section, surfacing the
    // change in code review.
    expect([...PROBES]).toEqual(["clerk", "paystack", "flutterwave"]);
  });
});

describe("evaluateProbe — config block shape (always-run)", () => {
  it("escalates to probe_error when config.dependencyProbes is missing", () => {
    const body: ReadyzBody = { checks: { clerk: "skipped" }, config: {} };
    const r = evaluateProbe("clerk", body);
    expect(r.outcome).toBe("probe_error");
    expect(r.reason).toMatch(/dependencyProbes is missing/);
  });
  it("escalates to probe_error when config.dependencyProbes.<probe> is missing", () => {
    const r = evaluateProbe(
      "clerk",
      buildBody({ clerk: { omitFromConfig: true } }),
    );
    expect(r.outcome).toBe("probe_error");
    expect(r.reason).toMatch(/clerk is missing/);
  });
  it.each([
    ["enabled not boolean", { enabled: "true", url: "x", timeoutMs: 1 }, /enabled is not a boolean/],
    ["url not string", { enabled: false, url: 1, timeoutMs: 1 }, /url is not a non-empty string/],
    ["url empty", { enabled: false, url: "", timeoutMs: 1 }, /url is not a non-empty string/],
    ["timeoutMs not finite", { enabled: false, url: "x", timeoutMs: NaN }, /timeoutMs is not a positive finite number/],
    ["timeoutMs negative", { enabled: false, url: "x", timeoutMs: -1 }, /timeoutMs is not a positive finite number/],
    ["timeoutMs zero", { enabled: false, url: "x", timeoutMs: 0 }, /timeoutMs is not a positive finite number/],
    ["timeoutMs string", { enabled: false, url: "x", timeoutMs: "100" }, /timeoutMs is not a positive finite number/],
  ] as const)(
    "escalates to probe_error when %s",
    (_label, config, expectedReason) => {
      const r = evaluateProbe("clerk", buildBody({ clerk: { config } }));
      expect(r.outcome).toBe("probe_error");
      expect(r.reason).toMatch(expectedReason);
    },
  );
});

describe("evaluateProbe — checks.<name> enum", () => {
  it.each(["unknown", "OK", "FAIL", null, 1, undefined] as const)(
    "escalates to probe_error when checks value is %s",
    (val) => {
      const r = evaluateProbe(
        "clerk",
        buildBody({
          clerk: {
            check: val,
            config: {
              enabled: true,
              url: "https://api.clerk.test",
              timeoutMs: 2000,
            },
          },
        }),
      );
      expect(r.outcome).toBe("probe_error");
      expect(r.reason).toMatch(/checks\.clerk is not one of/);
    },
  );
});

describe("evaluateProbe — skipped state", () => {
  it("ok when skipped + no failure + enabled=false", () => {
    const r = evaluateProbe(
      "clerk",
      buildBody({
        clerk: {
          check: "skipped",
          config: {
            enabled: false,
            url: "https://api.clerk.test",
            timeoutMs: 2000,
          },
        },
      }),
    );
    expect(r.outcome).toBe("ok");
  });
  it("pages when failures.<name> leaks on a skipped probe", () => {
    const r = evaluateProbe(
      "clerk",
      buildBody({
        clerk: {
          check: "skipped",
          failure: "leaked",
          config: {
            enabled: false,
            url: "https://api.clerk.test",
            timeoutMs: 2000,
          },
        },
      }),
    );
    expect(r.outcome).toBe("page");
    expect(r.reason).toMatch(/leaking a failure/);
  });
  it("pages when config.enabled=true on a skipped probe", () => {
    const r = evaluateProbe(
      "clerk",
      buildBody({
        clerk: {
          check: "skipped",
          config: {
            enabled: true,
            url: "https://api.clerk.test",
            timeoutMs: 2000,
          },
        },
      }),
    );
    expect(r.outcome).toBe("page");
    expect(r.reason).toMatch(/escape hatch/);
  });
});

describe("evaluateProbe — ok state", () => {
  it("ok when ok + no failure + enabled=true", () => {
    const r = evaluateProbe(
      "clerk",
      buildBody({
        clerk: {
          check: "ok",
          config: {
            enabled: true,
            url: "https://api.clerk.test",
            timeoutMs: 2000,
          },
        },
      }),
    );
    expect(r.outcome).toBe("ok");
  });
  it("pages when failures.<name> leaks on an ok probe", () => {
    const r = evaluateProbe(
      "clerk",
      buildBody({
        clerk: {
          check: "ok",
          failure: "leaked",
          config: {
            enabled: true,
            url: "https://api.clerk.test",
            timeoutMs: 2000,
          },
        },
      }),
    );
    expect(r.outcome).toBe("page");
    expect(r.reason).toMatch(/leaking failure state/);
  });
  it("pages when config.enabled=false on an ok probe", () => {
    const r = evaluateProbe(
      "clerk",
      buildBody({
        clerk: {
          check: "ok",
          config: {
            enabled: false,
            url: "https://api.clerk.test",
            timeoutMs: 2000,
          },
        },
      }),
    );
    expect(r.outcome).toBe("page");
    expect(r.reason).toMatch(/defeating the opt-in contract/);
  });
});

describe("evaluateProbe — failed state", () => {
  it("ok when failed + non-empty failure + enabled=true (network-style failure)", () => {
    const r = evaluateProbe(
      "clerk",
      buildBody({
        clerk: {
          check: "failed",
          failure: "fetch failed",
          config: {
            enabled: true,
            url: "https://api.clerk.test",
            timeoutMs: 2000,
          },
        },
      }),
    );
    expect(r.outcome).toBe("ok");
  });
  it("ok when failed + valid timeout marker + enabled=true", () => {
    const r = evaluateProbe(
      "clerk",
      buildBody({
        clerk: {
          check: "failed",
          failure: "http_probe_timeout_after_2000ms",
          config: {
            enabled: true,
            url: "https://api.clerk.test",
            timeoutMs: 2000,
          },
        },
      }),
    );
    expect(r.outcome).toBe("ok");
  });
  it("escalates to probe_error when failure is missing", () => {
    const r = evaluateProbe(
      "clerk",
      buildBody({
        clerk: {
          check: "failed",
          config: {
            enabled: true,
            url: "https://api.clerk.test",
            timeoutMs: 2000,
          },
        },
      }),
    );
    expect(r.outcome).toBe("probe_error");
    expect(r.reason).toMatch(/lost on its way to failures/);
  });
  it("escalates to probe_error when failure is empty string", () => {
    const r = evaluateProbe(
      "clerk",
      buildBody({
        clerk: {
          check: "failed",
          failure: "",
          config: {
            enabled: true,
            url: "https://api.clerk.test",
            timeoutMs: 2000,
          },
        },
      }),
    );
    expect(r.outcome).toBe("probe_error");
  });
  it("pages when config.enabled=false on a failed probe", () => {
    const r = evaluateProbe(
      "clerk",
      buildBody({
        clerk: {
          check: "failed",
          failure: "fetch failed",
          config: {
            enabled: false,
            url: "https://api.clerk.test",
            timeoutMs: 2000,
          },
        },
      }),
    );
    expect(r.outcome).toBe("page");
    expect(r.reason).toMatch(/defeating the opt-in contract/);
  });
  it.each([
    "http_probe_timeout_after_",
    "http_probe_timeout_after_abc",
    "http_probe_timeout_after_200",
    "http_probe_timeout_after_200ms_extra",
  ] as const)(
    "escalates to probe_error on malformed timeout marker %s",
    (failure) => {
      const r = evaluateProbe(
        "clerk",
        buildBody({
          clerk: {
            check: "failed",
            failure,
            config: {
              enabled: true,
              url: "https://api.clerk.test",
              timeoutMs: 2000,
            },
          },
        }),
      );
      expect(r.outcome).toBe("probe_error");
      expect(r.reason).toMatch(/log-aggregator queries/);
    },
  );
  it("does NOT validate the marker shape on non-timeout failures", () => {
    // A failure starting with anything other than the timeout
    // prefix is opaque to this gate — only the timeout prefix
    // triggers the marker-shape check.
    const r = evaluateProbe(
      "clerk",
      buildBody({
        clerk: {
          check: "failed",
          failure: "ENOTFOUND api.clerk.test",
          config: {
            enabled: true,
            url: "https://api.clerk.test",
            timeoutMs: 2000,
          },
        },
      }),
    );
    expect(r.outcome).toBe("ok");
  });
});

describe("evaluateReadyzDependencyProbes — aggregator", () => {
  it("ok when every probe passes", () => {
    const result = evaluateReadyzDependencyProbes(
      buildBody({
        clerk: {
          check: "ok",
          config: { enabled: true, url: "x", timeoutMs: 1 },
        },
        paystack: {
          check: "skipped",
          config: { enabled: false, url: "x", timeoutMs: 1 },
        },
        flutterwave: {
          check: "failed",
          failure: "http_probe_timeout_after_5000ms",
          config: { enabled: true, url: "x", timeoutMs: 5000 },
        },
      }),
    );
    expect(result.worstOutcome).toBe("ok");
    expect(result.probes.map((p) => p.probe)).toEqual([...PROBES]);
  });
  it("page outranks ok across probes", () => {
    const result = evaluateReadyzDependencyProbes(
      buildBody({
        clerk: {
          check: "ok",
          config: { enabled: true, url: "x", timeoutMs: 1 },
        },
        paystack: {
          check: "ok",
          failure: "leaked",
          config: { enabled: true, url: "x", timeoutMs: 1 },
        },
      }),
    );
    expect(result.worstOutcome).toBe("page");
  });
  it("probe_error outranks page across probes", () => {
    const result = evaluateReadyzDependencyProbes(
      buildBody({
        clerk: {
          check: "ok",
          failure: "leaked",
          config: { enabled: true, url: "x", timeoutMs: 1 },
        },
        paystack: {
          check: "failed",
          failure: "http_probe_timeout_after_bogus",
          config: { enabled: true, url: "x", timeoutMs: 1 },
        },
      }),
    );
    expect(result.worstOutcome).toBe("probe_error");
  });
  it("returns probes in the documented order", () => {
    const result = evaluateReadyzDependencyProbes(buildBody({}));
    expect(result.probes.map((p) => p.probe)).toEqual([
      "clerk",
      "paystack",
      "flutterwave",
    ]);
  });
});

describe("exitCodeFor", () => {
  it("maps outcomes to documented codes", () => {
    expect(exitCodeFor("ok")).toBe(0);
    expect(exitCodeFor("probe_error")).toBe(1);
    expect(exitCodeFor("page")).toBe(2);
  });
});

describe("main — CLI entrypoint", () => {
  function makeIo() {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      stdout: (line: string) => {
        out.push(line);
      },
      stderr: (line: string) => {
        err.push(line);
      },
    };
  }

  it("returns 1 and writes to stderr when READYZ_URL is unset", async () => {
    const io = makeIo();
    const code = await main({ env: {}, ...io });
    expect(code).toBe(1);
    expect(io.err.join("\n")).toMatch(/READYZ_URL is required/);
    expect(io.out).toEqual([]);
  });

  it("returns 1 and emits a structured stderr line on fetch error", async () => {
    const io = makeIo();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: false, error: "boom" });
    const code = await main({
      env: { READYZ_URL: "https://api.test/api/readyz" },
      fetchImpl,
      ...io,
    });
    expect(code).toBe(1);
    expect(io.out).toEqual([]);
    const parsed = JSON.parse(io.err[0]!);
    expect(parsed).toMatchObject({
      check: "readyz_dependency_probe_wire_shape",
      outcome: "probe_error",
      url: "https://api.test/api/readyz",
      error: "boom",
    });
  });

  it("returns 0 and emits an ok stdout line on a healthy /readyz body (every cell)", async () => {
    const io = makeIo();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      httpStatus: 200,
      body: buildBody({
        clerk: {
          check: "ok",
          config: { enabled: true, url: "https://api.clerk.com", timeoutMs: 2000 },
        },
        paystack: {
          check: "skipped",
          config: { enabled: false, url: "https://api.paystack.co", timeoutMs: 2000 },
        },
        flutterwave: {
          check: "failed",
          failure: "http_probe_timeout_after_2000ms",
          config: {
            enabled: true,
            url: "https://api.flutterwave.com",
            timeoutMs: 2000,
          },
        },
      }),
    });
    const code = await main({
      env: { READYZ_URL: "https://api.test/api/readyz" },
      fetchImpl,
      ...io,
    });
    expect(code).toBe(0);
    expect(io.err).toEqual([]);
    const parsed = JSON.parse(io.out[0]!);
    expect(parsed.outcome).toBe("ok");
    expect(parsed.httpStatus).toBe(200);
    expect(parsed.probes.map((p: { probe: string }) => p.probe)).toEqual([
      ...PROBES,
    ]);
  });

  it("returns 2 on any wire-shape regression that is a page", async () => {
    const io = makeIo();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      httpStatus: 200,
      body: buildBody({
        clerk: {
          check: "ok",
          failure: "leaked",
          config: { enabled: true, url: "https://api.clerk.com", timeoutMs: 2000 },
        },
      }),
    });
    const code = await main({
      env: { READYZ_URL: "https://api.test/api/readyz" },
      fetchImpl,
      ...io,
    });
    expect(code).toBe(2);
    const parsed = JSON.parse(io.out[0]!);
    expect(parsed.outcome).toBe("page");
  });

  it("returns 1 on any wire-shape regression that is a probe_error", async () => {
    const io = makeIo();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      httpStatus: 200,
      body: buildBody({
        clerk: {
          check: "failed",
          failure: "http_probe_timeout_after_garbage",
          config: { enabled: true, url: "https://api.clerk.com", timeoutMs: 2000 },
        },
      }),
    });
    const code = await main({
      env: { READYZ_URL: "https://api.test/api/readyz" },
      fetchImpl,
      ...io,
    });
    expect(code).toBe(1);
    const parsed = JSON.parse(io.out[0]!);
    expect(parsed.outcome).toBe("probe_error");
  });

  it("accepts a 503 not_ready body and still validates the wire shape", async () => {
    // Per the runbook, /readyz emits the per-probe blocks on 503
    // too — the gate must continue to assert wire shape during a
    // downstream outage, otherwise on-call loses the page at the
    // worst possible moment.
    const io = makeIo();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      httpStatus: 503,
      body: buildBody({
        clerk: {
          check: "failed",
          failure: "http_probe_timeout_after_2000ms",
          config: { enabled: true, url: "https://api.clerk.com", timeoutMs: 2000 },
        },
      }),
    });
    const code = await main({
      env: { READYZ_URL: "https://api.test/api/readyz" },
      fetchImpl,
      ...io,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(io.out[0]!);
    expect(parsed.httpStatus).toBe(503);
  });

  it("respects READYZ_PROBE_TIMEOUT_MS", async () => {
    const io = makeIo();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      httpStatus: 200,
      body: buildBody({}),
    });
    await main({
      env: {
        READYZ_URL: "https://api.test/api/readyz",
        READYZ_PROBE_TIMEOUT_MS: "12345",
      },
      fetchImpl,
      ...io,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.test/api/readyz",
      12345,
    );
  });

  it("falls back to the default timeout on garbage READYZ_PROBE_TIMEOUT_MS", async () => {
    const io = makeIo();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      httpStatus: 200,
      body: buildBody({}),
    });
    await main({
      env: {
        READYZ_URL: "https://api.test/api/readyz",
        READYZ_PROBE_TIMEOUT_MS: "abc",
      },
      fetchImpl,
      ...io,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.test/api/readyz",
      5000,
    );
  });
});
