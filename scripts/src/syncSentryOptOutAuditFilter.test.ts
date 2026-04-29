import { describe, it, expect, vi } from "vitest";
import {
  EMPTY_INVENTORY_DEFAULT_VALUE,
  EXPECTED_MATCH_MODES,
  computeInventoryHostnameUnion,
  decideRuleAction,
  exitCodeFor,
  findHostnameFilter,
  getRule,
  main,
  putRule,
  splitOnTopLevelPipe,
  withUpdatedHostnameValue,
  type SentryRuleBody,
} from "./syncSentryOptOutAuditFilter.js";
import type { InventoryRow } from "./checkRateLimitOptOutSunsets.js";

/** Minimal fixture matching the real inventory file shape so the
 *  parser pulled in by main() finds the table. */
function inventoryFixture(rows: string[]): string {
  return [
    "# Inventory header prose",
    "",
    "## Active opt-outs",
    "",
    "| Deploy name | `HOSTNAME` (regex match) | Owner | Reason | Opted-out since | Expected sunset | Notes |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "### Column definitions",
    "",
    "- **Deploy name** — …",
  ].join("\n");
}

function row(overrides: Partial<InventoryRow> = {}): InventoryRow {
  return {
    deployName: "api-canary",
    hostnamePattern: "^api-canary-[a-z0-9]+$",
    owner: "rate-limit-oncall",
    reason: "canary",
    optedOutSince: "2026-01-01",
    expectedSunset: "2026-12-31",
    notes: "replica=1",
    ...overrides,
  };
}

describe("splitOnTopLevelPipe", () => {
  it("splits on a top-level pipe", () => {
    expect(splitOnTopLevelPipe("^a$|^b$")).toEqual(["^a$", "^b$"]);
  });

  it("does not split on pipes inside character classes", () => {
    expect(splitOnTopLevelPipe("^[a|b]$")).toEqual(["^[a|b]$"]);
  });

  it("does not split on pipes inside groups", () => {
    expect(splitOnTopLevelPipe("^(a|b)$")).toEqual(["^(a|b)$"]);
  });

  it("does not split on escaped pipes", () => {
    expect(splitOnTopLevelPipe("^a\\|b$")).toEqual(["^a\\|b$"]);
  });
});

describe("computeInventoryHostnameUnion", () => {
  it("returns empty alternatives + empty union for an empty inventory", () => {
    expect(computeInventoryHostnameUnion([])).toEqual({
      alternatives: [],
      union: "",
    });
  });

  it("returns one alternative per row joined with |", () => {
    expect(
      computeInventoryHostnameUnion([
        row({ deployName: "a", hostnamePattern: "^a-[a-z]+$" }),
        row({ deployName: "b", hostnamePattern: "^b-[a-z]+$" }),
      ]),
    ).toEqual({
      alternatives: ["^a-[a-z]+$", "^b-[a-z]+$"],
      union: "^a-[a-z]+$|^b-[a-z]+$",
    });
  });

  it("strips backticks from a row's hostname cell", () => {
    expect(
      computeInventoryHostnameUnion([
        row({ deployName: "a", hostnamePattern: "`^a-[a-z]+$`" }),
      ]).alternatives,
    ).toEqual(["^a-[a-z]+$"]);
  });

  it("splits a row that unions multiple hostnames-for-one-deploy on top-level |", () => {
    expect(
      computeInventoryHostnameUnion([
        row({
          deployName: "both",
          hostnamePattern: "^api-a-[a-z0-9]+$|^api-b-[a-z0-9]+$",
        }),
      ]),
    ).toEqual({
      alternatives: ["^api-a-[a-z0-9]+$", "^api-b-[a-z0-9]+$"],
      union: "^api-a-[a-z0-9]+$|^api-b-[a-z0-9]+$",
    });
  });

  it("dedupes alternatives so two rows with the same pattern only contribute one", () => {
    expect(
      computeInventoryHostnameUnion([
        row({ deployName: "a", hostnamePattern: "^api-x-[a-z0-9]+$" }),
        row({ deployName: "b", hostnamePattern: "^api-x-[a-z0-9]+$" }),
      ]).alternatives,
    ).toEqual(["^api-x-[a-z0-9]+$"]);
  });

  it("throws on a placeholder/empty hostname cell — every active opt-out must declare a regex", () => {
    expect(() =>
      computeInventoryHostnameUnion([
        row({ deployName: "broken", hostnamePattern: "—" }),
      ]),
    ).toThrow(/empty \/ placeholder hostname cell/);
    expect(() =>
      computeInventoryHostnameUnion([
        row({ deployName: "empty", hostnamePattern: "" }),
      ]),
    ).toThrow(/empty \/ placeholder hostname cell/);
  });
});

describe("findHostnameFilter", () => {
  it("returns null when no hostname filter exists", () => {
    expect(
      findHostnameFilter({
        filters: [{ key: "level", match: "eq", value: "error" }],
      }),
    ).toBeNull();
    expect(findHostnameFilter({})).toBeNull();
  });

  it("locates a hostname filter inside `filters[]`", () => {
    const loc = findHostnameFilter({
      filters: [
        { key: "level", match: "eq", value: "warning" },
        { key: "hostname", match: "re", value: "^api-[a-z]+$" },
      ],
    });
    expect(loc).toEqual({
      arrayName: "filters",
      index: 1,
      matchMode: "re",
      value: "^api-[a-z]+$",
    });
  });

  it("locates a hostname filter inside `conditions[]` (case-insensitive key)", () => {
    const loc = findHostnameFilter({
      conditions: [
        { id: "sentry.rules.conditions.first_seen.X" },
        { key: "Hostname", match: "nre", value: "^api-[a-z]+$" },
      ],
    });
    expect(loc).toEqual({
      arrayName: "conditions",
      index: 1,
      matchMode: "nre",
      value: "^api-[a-z]+$",
    });
  });

  it("throws when more than one hostname filter is present (refuses to guess)", () => {
    expect(() =>
      findHostnameFilter({
        filters: [
          { key: "hostname", match: "re", value: "^a$" },
          { key: "hostname", match: "re", value: "^b$" },
        ],
      }),
    ).toThrow(/2 hostname-keyed filter entries/);
  });

  it("throws when the rule body isn't an object", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => findHostnameFilter(null as any)).toThrow(/not an object/);
  });
});

describe("withUpdatedHostnameValue", () => {
  it("only changes the located filter's value, preserving everything else", () => {
    const original: SentryRuleBody = {
      name: "audit",
      environment: "production",
      actions: [{ id: "pagerduty", account: "x" }],
      filters: [
        { key: "level", match: "eq", value: "warning" },
        {
          key: "hostname",
          match: "re",
          value: "^old$",
          extraSentryField: "preserve-me",
        },
      ],
      conditions: [{ id: "first-seen" }],
    };
    const loc = findHostnameFilter(original);
    const updated = withUpdatedHostnameValue(original, loc!, "^new$");
    expect(updated).not.toBe(original);
    // Original is untouched.
    expect((original.filters as Array<Record<string, unknown>>)[1]!.value).toBe(
      "^old$",
    );
    // Updated rule has the new value AND preserves siblings + the
    // filter's own non-value fields (including the unknown
    // operator-set field).
    const newFilters = updated.filters as Array<Record<string, unknown>>;
    expect(newFilters[0]).toEqual({
      key: "level",
      match: "eq",
      value: "warning",
    });
    expect(newFilters[1]).toEqual({
      key: "hostname",
      match: "re",
      value: "^new$",
      extraSentryField: "preserve-me",
    });
    expect(updated.actions).toEqual(original.actions);
    expect(updated.environment).toBe("production");
    expect(updated.conditions).toEqual(original.conditions);
  });
});

describe("decideRuleAction", () => {
  it("returns probe_error when there is no hostname filter at all", () => {
    expect(decideRuleAction(null, "re", "^a$")).toEqual({
      outcome: "probe_error",
      reason: expect.stringContaining("no hostname-keyed filter entry"),
    });
  });

  it("returns probe_error when the match mode is flipped (refuses to auto-flip)", () => {
    expect(
      decideRuleAction(
        { arrayName: "filters", index: 0, matchMode: "nre", value: "^a$" },
        "re",
        "^a$",
      ),
    ).toEqual({
      outcome: "probe_error",
      reason: expect.stringContaining("flipped mode would invert"),
    });
  });

  it("returns in_sync when the observed value matches the desired", () => {
    expect(
      decideRuleAction(
        { arrayName: "filters", index: 0, matchMode: "re", value: "^a$|^b$" },
        "re",
        "^a$|^b$",
      ),
    ).toEqual({
      outcome: "in_sync",
      observedValue: "^a$|^b$",
      desiredValue: "^a$|^b$",
    });
  });

  it("returns would_update when the values differ", () => {
    expect(
      decideRuleAction(
        { arrayName: "filters", index: 0, matchMode: "re", value: "^old$" },
        "re",
        "^new$",
      ),
    ).toEqual({
      outcome: "would_update",
      observedValue: "^old$",
      desiredValue: "^new$",
    });
  });
});

describe("exitCodeFor", () => {
  it("maps every outcome to the documented exit code", () => {
    expect(exitCodeFor("in_sync")).toBe(0);
    expect(exitCodeFor("synced")).toBe(0);
    expect(exitCodeFor("would_sync")).toBe(0);
    expect(exitCodeFor("drift")).toBe(2);
    expect(exitCodeFor("sync_failed")).toBe(2);
    expect(exitCodeFor("probe_error")).toBe(1);
  });
});

describe("getRule / putRule", () => {
  it("getRule GETs the project rule URL with bearer auth", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{"id":1,"name":"audit"}'),
    });
    const body = await getRule(
      "https://sentry.io",
      "epplaa",
      "api-server",
      "42",
      "tok",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl as any,
    );
    expect(body).toEqual({ id: 1, name: "audit" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://sentry.io/api/0/projects/epplaa/api-server/rules/42/");
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer tok");
  });

  it("getRule throws on non-2xx", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve("forbidden"),
    });
    await expect(
      getRule(
        "https://sentry.io",
        "o",
        "p",
        "1",
        "t",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetchImpl as any,
      ),
    ).rejects.toThrow(/HTTP 403.*forbidden/);
  });

  it("putRule PUTs the rule body and returns ok=true on 2xx", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve("{}"),
    });
    const result = await putRule(
      "https://sentry.io",
      "o",
      "p",
      "1",
      "t",
      { name: "x" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl as any,
    );
    expect(result).toEqual({ ok: true, status: 200 });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://sentry.io/api/0/projects/o/p/rules/1/");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ name: "x" });
  });

  it("putRule returns ok=false with the body on non-2xx", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: () => Promise.resolve("bad payload"),
    });
    const result = await putRule(
      "https://sentry.io",
      "o",
      "p",
      "1",
      "t",
      { name: "x" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl as any,
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(422);
    expect(result.error).toContain("bad payload");
  });

  it("putRule captures fetch-level errors", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const result = await putRule(
      "https://sentry.io",
      "o",
      "p",
      "1",
      "t",
      { name: "x" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl as any,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("network down");
  });
});

describe("EXPECTED_MATCH_MODES", () => {
  it("documents the audit + page rules' expected match modes", () => {
    expect(EXPECTED_MATCH_MODES["audit-notification"]).toBe("re");
    expect(EXPECTED_MATCH_MODES["page-on-unknown-host"]).toBe("nre");
  });
});

describe("main", () => {
  /** Build a Sentry rule body whose hostname filter has a given
   *  match mode + value. Used by the main() integration tests below
   *  to seed the GET responses. */
  function ruleBody(matchMode: "re" | "nre", value: string): SentryRuleBody {
    return {
      name: `rule-${matchMode}`,
      environment: "production",
      filterMatch: "all",
      actionMatch: "any",
      filters: [
        { key: "level", match: "eq", value: "warning" },
        { key: "hostname", match: matchMode, value },
      ],
      actions: [{ id: "pagerduty", account: "x", service: "y" }],
      conditions: [{ id: "first-seen" }],
    };
  }

  /** Stub a fetchImpl that returns canned audit + page rule bodies
   *  on GET (keyed by URL) and records every PUT for assertion. */
  function fakeFetch(
    rules: { auditId: string; auditBody: SentryRuleBody; pageId: string; pageBody: SentryRuleBody },
  ) {
    const puts: Array<{ url: string; body: SentryRuleBody }> = [];
    const gets: string[] = [];
    const impl = vi.fn().mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        gets.push(url);
        let body: SentryRuleBody;
        if (url.endsWith(`/rules/${rules.auditId}/`)) body = rules.auditBody;
        else if (url.endsWith(`/rules/${rules.pageId}/`)) body = rules.pageBody;
        else
          return {
            ok: false,
            status: 404,
            text: () => Promise.resolve("not found"),
          };
        return {
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify(body)),
        };
      }
      if (method === "PUT") {
        const parsedBody = init?.body ? JSON.parse(init.body) : {};
        puts.push({ url, body: parsedBody });
        return {
          ok: true,
          status: 200,
          text: () => Promise.resolve("{}"),
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    return { impl, puts, gets };
  }

  const baseEnv = {
    SENTRY_ORG: "epplaa",
    SENTRY_PROJECT: "api-server",
    RATE_LIMIT_OPT_OUT_AUDIT_RULE_ID: "111",
    RATE_LIMIT_OPT_OUT_PAGE_RULE_ID: "222",
    SENTRY_AUTH_TOKEN: "tok",
  };

  it("returns 1 with a list of every missing required env var", async () => {
    const stderr: string[] = [];
    const code = await main({
      env: {},
      stdout: () => {},
      stderr: (l) => stderr.push(l),
    });
    expect(code).toBe(1);
    const joined = stderr.join("\n");
    expect(joined).toMatch(/SENTRY_ORG/);
    expect(joined).toMatch(/SENTRY_PROJECT/);
    expect(joined).toMatch(/RATE_LIMIT_OPT_OUT_AUDIT_RULE_ID/);
    expect(joined).toMatch(/RATE_LIMIT_OPT_OUT_PAGE_RULE_ID/);
    expect(joined).toMatch(/SENTRY_AUTH_TOKEN/);
  });

  it("returns 1 when CHECK_ONLY and DRY_RUN are both set (mutually exclusive)", async () => {
    const stderr: string[] = [];
    const code = await main({
      env: { ...baseEnv, CHECK_ONLY: "1", DRY_RUN: "1" },
      readFileImpl: () => inventoryFixture(["| _(none)_ | — | — | — | — | — | n |"]),
      stdout: () => {},
      stderr: (l) => stderr.push(l),
    });
    expect(code).toBe(1);
    expect(stderr.join("\n")).toMatch(/mutually exclusive/);
  });

  it("returns 1 when the inventory file cannot be read", async () => {
    const stderr: string[] = [];
    const code = await main({
      env: baseEnv,
      readFileImpl: () => {
        throw new Error("ENOENT");
      },
      stdout: () => {},
      stderr: (l) => stderr.push(l),
    });
    expect(code).toBe(1);
    expect(stderr.join("\n")).toMatch(/failed to read inventory/);
  });

  it("returns 1 when the inventory parser rejects the table shape", async () => {
    const stderr: string[] = [];
    const code = await main({
      env: baseEnv,
      readFileImpl: () => "## Active opt-outs\n\nno table here\n",
      stdout: () => {},
      stderr: (l) => stderr.push(l),
    });
    expect(code).toBe(1);
    expect(stderr.join("\n")).toMatch(/failed to parse inventory/);
  });

  it("auto-syncs both rules when their hostname value diverges from the inventory", async () => {
    const inv = inventoryFixture([
      "| api-canary | ^api-canary-[a-z0-9]+$ | rate-limit-oncall | canary | 2026-01-01 | 2026-12-31 | n |",
      "| internal-admin | ^internal-admin-[a-z0-9]+$ | platform | internal-tool | 2026-01-01 | 2026-12-31 | n |",
    ]);
    const { impl, puts, gets } = fakeFetch({
      auditId: "111",
      auditBody: ruleBody("re", "^stale$"),
      pageId: "222",
      pageBody: ruleBody("nre", "^stale$"),
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main({
      env: baseEnv,
      readFileImpl: () => inv,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl: impl as any,
      stdout: (l) => stdout.push(l),
      stderr: (l) => stderr.push(l),
    });
    expect(code).toBe(0);
    expect(gets).toHaveLength(2);
    expect(puts).toHaveLength(2);
    // Both PUTs carry the union; the audit rule's filter keeps `re`,
    // the page rule's keeps `nre`.
    const expectedUnion =
      "^api-canary-[a-z0-9]+$|^internal-admin-[a-z0-9]+$";
    for (const put of puts) {
      const filters = (put.body.filters as Array<Record<string, unknown>>) ?? [];
      const hostname = filters.find((f) => f.key === "hostname")!;
      expect(hostname.value).toBe(expectedUnion);
    }
    const auditPut = puts.find((p) => p.url.includes("/rules/111/"))!;
    const pagePut = puts.find((p) => p.url.includes("/rules/222/"))!;
    expect(
      ((auditPut.body.filters as Array<Record<string, unknown>>).find(
        (f) => f.key === "hostname",
      ))!.match,
    ).toBe("re");
    expect(
      ((pagePut.body.filters as Array<Record<string, unknown>>).find(
        (f) => f.key === "hostname",
      ))!.match,
    ).toBe("nre");
    // Top-level summary line is the last stdout entry.
    const summary = JSON.parse(stdout[stdout.length - 1]!);
    expect(summary.outcome).toBe("synced");
    expect(summary.mode).toBe("auto-sync");
    expect(summary.inventoryAlternatives).toEqual([
      "^api-canary-[a-z0-9]+$",
      "^internal-admin-[a-z0-9]+$",
    ]);
  });

  it("returns 0 with outcome=in_sync when the rules already match the inventory", async () => {
    const inv = inventoryFixture([
      "| api-canary | ^api-canary-[a-z0-9]+$ | rate-limit-oncall | canary | 2026-01-01 | 2026-12-31 | n |",
    ]);
    const expectedUnion = "^api-canary-[a-z0-9]+$";
    const { impl, puts } = fakeFetch({
      auditId: "111",
      auditBody: ruleBody("re", expectedUnion),
      pageId: "222",
      pageBody: ruleBody("nre", expectedUnion),
    });
    const stdout: string[] = [];
    const code = await main({
      env: baseEnv,
      readFileImpl: () => inv,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl: impl as any,
      stdout: (l) => stdout.push(l),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(puts).toEqual([]);
    const summary = JSON.parse(stdout[stdout.length - 1]!);
    expect(summary.outcome).toBe("in_sync");
  });

  it("CHECK_ONLY=1 returns exit 2 on drift and never PUTs", async () => {
    const inv = inventoryFixture([
      "| api-canary | ^api-canary-[a-z0-9]+$ | rate-limit-oncall | canary | 2026-01-01 | 2026-12-31 | n |",
    ]);
    const { impl, puts } = fakeFetch({
      auditId: "111",
      auditBody: ruleBody("re", "^stale$"),
      pageId: "222",
      pageBody: ruleBody("nre", "^api-canary-[a-z0-9]+$"),
    });
    const stdout: string[] = [];
    const code = await main({
      env: { ...baseEnv, CHECK_ONLY: "1" },
      readFileImpl: () => inv,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl: impl as any,
      stdout: (l) => stdout.push(l),
      stderr: () => {},
    });
    expect(code).toBe(2);
    expect(puts).toEqual([]);
    const summary = JSON.parse(stdout[stdout.length - 1]!);
    expect(summary.outcome).toBe("drift");
    expect(summary.mode).toBe("check-only");
    // Only the audit rule drifted in this fixture; the page rule
    // already matched the inventory.
    const drifted = summary.rules.filter(
      (r: { decision: { outcome: string } }) => r.decision.outcome === "drift",
    );
    expect(drifted).toHaveLength(1);
    expect(drifted[0].name).toBe("audit-notification");
  });

  it("DRY_RUN=1 logs the intended PUT body and exits 0 without writing", async () => {
    const inv = inventoryFixture([
      "| api-canary | ^api-canary-[a-z0-9]+$ | rate-limit-oncall | canary | 2026-01-01 | 2026-12-31 | n |",
    ]);
    const { impl, puts } = fakeFetch({
      auditId: "111",
      auditBody: ruleBody("re", "^stale$"),
      pageId: "222",
      pageBody: ruleBody("nre", "^api-canary-[a-z0-9]+$"),
    });
    const stdout: string[] = [];
    const code = await main({
      env: { ...baseEnv, DRY_RUN: "1" },
      readFileImpl: () => inv,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl: impl as any,
      stdout: (l) => stdout.push(l),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(puts).toEqual([]);
    expect(stdout.some((l) => l.includes("would PUT audit-notification"))).toBe(
      true,
    );
    const summary = JSON.parse(stdout[stdout.length - 1]!);
    expect(summary.outcome).toBe("would_sync");
    expect(summary.mode).toBe("dry-run");
  });

  it("auto-sync returns exit 2 (sync_failed) when a PUT fails — drift is still on the rule", async () => {
    const inv = inventoryFixture([
      "| api-canary | ^api-canary-[a-z0-9]+$ | rate-limit-oncall | canary | 2026-01-01 | 2026-12-31 | n |",
    ]);
    // Both rules are correctly shaped (audit=re, page=nre) but
    // every PUT fails — that's the scenario where on-call MUST be
    // paged because the rules are still drifting.
    const impl = vi.fn().mockImplementation(async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        const matchMode: "re" | "nre" = url.endsWith("/rules/111/")
          ? "re"
          : "nre";
        return {
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(JSON.stringify(ruleBody(matchMode, "^stale$"))),
        };
      }
      // PUT fails.
      return {
        ok: false,
        status: 500,
        text: () => Promise.resolve("server error"),
      };
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main({
      env: baseEnv,
      readFileImpl: () => inv,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl: impl as any,
      stdout: (l) => stdout.push(l),
      stderr: (l) => stderr.push(l),
    });
    expect(code).toBe(2);
    const summary = JSON.parse(stdout[stdout.length - 1]!);
    expect(summary.outcome).toBe("sync_failed");
    expect(stderr.join("\n")).toMatch(/FAILED audit-notification/);
  });

  it("returns exit 1 (probe_error) when a rule has no hostname filter at all", async () => {
    const inv = inventoryFixture([
      "| api-canary | ^api-canary-[a-z0-9]+$ | rate-limit-oncall | canary | 2026-01-01 | 2026-12-31 | n |",
    ]);
    const noHostname: SentryRuleBody = {
      name: "audit",
      filters: [{ key: "level", match: "eq", value: "warning" }],
    };
    const impl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(noHostname)),
    });
    const stdout: string[] = [];
    const code = await main({
      env: baseEnv,
      readFileImpl: () => inv,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl: impl as any,
      stdout: (l) => stdout.push(l),
      stderr: () => {},
    });
    expect(code).toBe(1);
    const summary = JSON.parse(stdout[stdout.length - 1]!);
    expect(summary.outcome).toBe("probe_error");
    // Both managed rules surface the same probe_error.
    expect(summary.rules).toHaveLength(2);
    for (const r of summary.rules) {
      expect(r.decision.outcome).toBe("probe_error");
      expect(r.decision.reason).toMatch(/no hostname-keyed filter entry/);
    }
  });

  it("returns exit 1 (probe_error) when a rule's match mode is flipped — refuses to auto-flip", async () => {
    const inv = inventoryFixture([
      "| api-canary | ^api-canary-[a-z0-9]+$ | rate-limit-oncall | canary | 2026-01-01 | 2026-12-31 | n |",
    ]);
    // The audit rule is incorrectly using `nre`. The script should
    // refuse to silently flip it to `re`.
    const { impl, puts } = fakeFetch({
      auditId: "111",
      auditBody: ruleBody("nre", "^api-canary-[a-z0-9]+$"),
      pageId: "222",
      pageBody: ruleBody("nre", "^api-canary-[a-z0-9]+$"),
    });
    const stdout: string[] = [];
    const code = await main({
      env: baseEnv,
      readFileImpl: () => inv,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl: impl as any,
      stdout: (l) => stdout.push(l),
      stderr: () => {},
    });
    expect(code).toBe(1);
    expect(puts).toEqual([]);
    const summary = JSON.parse(stdout[stdout.length - 1]!);
    expect(summary.outcome).toBe("probe_error");
    const audit = summary.rules.find(
      (r: { name: string }) => r.name === "audit-notification",
    );
    expect(audit.decision.reason).toMatch(/flipped mode/);
  });

  it("writes the empty-inventory placeholder when there are no active opt-outs", async () => {
    const inv = inventoryFixture([
      "| _(none)_ | — | — | — | — | — | placeholder |",
    ]);
    const { impl, puts } = fakeFetch({
      auditId: "111",
      auditBody: ruleBody("re", "^old$"),
      pageId: "222",
      pageBody: ruleBody("nre", "^old$"),
    });
    const stdout: string[] = [];
    const code = await main({
      env: baseEnv,
      readFileImpl: () => inv,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl: impl as any,
      stdout: (l) => stdout.push(l),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(puts).toHaveLength(2);
    for (const put of puts) {
      const filters = put.body.filters as Array<Record<string, unknown>>;
      const hostname = filters.find((f) => f.key === "hostname")!;
      expect(hostname.value).toBe(EMPTY_INVENTORY_DEFAULT_VALUE);
    }
    const summary = JSON.parse(stdout[stdout.length - 1]!);
    expect(summary.outcome).toBe("synced");
    expect(summary.desiredValue).toBe(EMPTY_INVENTORY_DEFAULT_VALUE);
  });

  it("honours EMPTY_INVENTORY_PLACEHOLDER override for empty inventory", async () => {
    const inv = inventoryFixture([
      "| _(none)_ | — | — | — | — | — | placeholder |",
    ]);
    const { impl, puts } = fakeFetch({
      auditId: "111",
      auditBody: ruleBody("re", "^old$"),
      pageId: "222",
      pageBody: ruleBody("nre", "^old$"),
    });
    const code = await main({
      env: { ...baseEnv, EMPTY_INVENTORY_PLACEHOLDER: "^__custom__$" },
      readFileImpl: () => inv,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl: impl as any,
      stdout: () => {},
      stderr: () => {},
    });
    expect(code).toBe(0);
    for (const put of puts) {
      const filters = put.body.filters as Array<Record<string, unknown>>;
      const hostname = filters.find((f) => f.key === "hostname")!;
      expect(hostname.value).toBe("^__custom__$");
    }
  });

  it("returns 1 with a probe_error report when the GET fails for one rule", async () => {
    const inv = inventoryFixture([
      "| api-canary | ^api-canary-[a-z0-9]+$ | rate-limit-oncall | canary | 2026-01-01 | 2026-12-31 | n |",
    ]);
    const impl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/rules/222/")) {
        return {
          ok: false,
          status: 404,
          text: () => Promise.resolve("not found"),
        };
      }
      return {
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              filters: [
                {
                  key: "hostname",
                  match: "re",
                  value: "^api-canary-[a-z0-9]+$",
                },
              ],
            }),
          ),
      };
    });
    const stdout: string[] = [];
    const code = await main({
      env: baseEnv,
      readFileImpl: () => inv,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl: impl as any,
      stdout: (l) => stdout.push(l),
      stderr: () => {},
    });
    expect(code).toBe(1);
    const summary = JSON.parse(stdout[stdout.length - 1]!);
    expect(summary.outcome).toBe("probe_error");
    const page = summary.rules.find(
      (r: { name: string }) => r.name === "page-on-unknown-host",
    );
    expect(page.decision.reason).toMatch(/HTTP 404/);
  });
});
