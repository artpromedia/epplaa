import { describe, it, expect, vi } from "vitest";
import {
  evaluateInventory,
  exitCodeFor,
  main,
  parseInventoryTable,
  resolveToday,
  splitMarkdownRow,
  type InventoryRow,
} from "./checkRateLimitOptOutSunsets";

/** Minimal fixture matching the headers in
 *  `docs/runbooks/rate-limit-store-opt-outs.md`. */
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

describe("splitMarkdownRow", () => {
  it("splits a normal row into trimmed cells", () => {
    expect(
      splitMarkdownRow(
        "| api-canary | ^api-canary-[a-z0-9]+$ | rate-limit-oncall | canary | 2026-01-01 | 2026-06-01 | replica=1 |",
      ),
    ).toEqual([
      "api-canary",
      "^api-canary-[a-z0-9]+$",
      "rate-limit-oncall",
      "canary",
      "2026-01-01",
      "2026-06-01",
      "replica=1",
    ]);
  });

  it("preserves backslash-escaped pipes inside cells (regex alternation)", () => {
    // The inventory's HOSTNAME column documents using `|` to union
    // multiple hostname patterns; in markdown that has to be escaped
    // as `\|` so the pipe doesn't end the cell.
    const cells = splitMarkdownRow(
      "| both | ^api-a-[a-z0-9]+$\\|^api-b-[a-z0-9]+$ | team | canary | 2026-01-01 | 2026-06-01 | n |",
    );
    expect(cells[1]).toBe("^api-a-[a-z0-9]+$|^api-b-[a-z0-9]+$");
  });
});

describe("parseInventoryTable", () => {
  it("returns no rows for the placeholder/empty inventory", () => {
    // The default state of the file is one placeholder row whose first
    // cell is `_(none)_`; that's the healthy "no opt-outs" state and
    // must not be treated as a real opt-out (which would have an
    // unparseable Expected sunset and trip probe_error).
    const md = inventoryFixture([
      "| _(none)_ | — | — | — | — | — | No production deploys are currently opted out. |",
    ]);
    expect(parseInventoryTable(md)).toEqual([]);
  });

  it("parses a single real opt-out row", () => {
    const md = inventoryFixture([
      "| api-canary | ^api-canary-[a-z0-9]+$ | rate-limit-oncall | canary | 2026-01-01 | 2026-06-01 | replica=1 |",
    ]);
    expect(parseInventoryTable(md)).toEqual<InventoryRow[]>([
      {
        deployName: "api-canary",
        hostnamePattern: "^api-canary-[a-z0-9]+$",
        owner: "rate-limit-oncall",
        reason: "canary",
        optedOutSince: "2026-01-01",
        expectedSunset: "2026-06-01",
        notes: "replica=1",
      },
    ]);
  });

  it("stops at the first non-table line so following sections are not scanned", () => {
    const md = [
      "## Active opt-outs",
      "",
      "| Deploy name | `HOSTNAME` (regex match) | Owner | Reason | Opted-out since | Expected sunset | Notes |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| api-canary | ^api-canary-[a-z0-9]+$ | team | canary | 2026-01-01 | 2026-06-01 | n |",
      "",
      "### Column definitions",
      "| should | not | be | parsed | as | another | row |",
    ].join("\n");
    expect(parseInventoryTable(md)).toHaveLength(1);
  });

  it("throws when the heading is missing — schema drift must fail loudly", () => {
    expect(() => parseInventoryTable("# something else\n")).toThrowError(
      /missing the '## Active opt-outs' heading/,
    );
  });

  it("throws when a column header was renamed — keep the parser locked to the documented schema", () => {
    const md = [
      "## Active opt-outs",
      "",
      // 'Sunset date' instead of the documented 'Expected sunset'.
      "| Deploy name | `HOSTNAME` (regex match) | Owner | Reason | Opted-out since | Sunset date | Notes |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    ].join("\n");
    expect(() => parseInventoryTable(md)).toThrowError(/Expected sunset/);
  });

  it("throws when a row has the wrong number of cells", () => {
    const md = inventoryFixture([
      // Six cells instead of seven.
      "| api-canary | ^api-canary-[a-z0-9]+$ | team | canary | 2026-01-01 | 2026-06-01 |",
    ]);
    expect(() => parseInventoryTable(md)).toThrowError(/has \d+ cells/);
  });
});

describe("resolveToday", () => {
  it("returns the env value when it is a valid YYYY-MM-DD", () => {
    expect(resolveToday("2026-04-29", new Date("2030-01-01T00:00:00Z"))).toBe(
      "2026-04-29",
    );
  });

  it("falls back to the current UTC date when the env value is missing or malformed", () => {
    const fixedNow = new Date("2026-04-29T13:00:00Z");
    for (const bogus of [undefined, "", "not-a-date", "2026/04/29", "20260429"]) {
      expect(resolveToday(bogus, fixedNow), `bogus=${String(bogus)}`).toBe(
        "2026-04-29",
      );
    }
  });

  it("rejects calendar-impossible dates and falls back rather than silently rolling them over", () => {
    const fixedNow = new Date("2026-04-29T00:00:00Z");
    expect(resolveToday("2026-02-30", fixedNow)).toBe("2026-04-29");
  });
});

describe("evaluateInventory — pure decision matrix", () => {
  function row(overrides: Partial<InventoryRow> = {}): InventoryRow {
    return {
      deployName: "api-canary",
      hostnamePattern: "^api-canary-[a-z0-9]+$",
      owner: "rate-limit-oncall",
      reason: "canary",
      optedOutSince: "2026-01-01",
      expectedSunset: "2026-06-01",
      notes: "",
      ...overrides,
    };
  }

  it("returns 'ok' for the empty inventory (no active opt-outs)", () => {
    const r = evaluateInventory([], "2026-04-29");
    expect(r.outcome).toBe("ok");
    expect(r.activeRowCount).toBe(0);
    expect(r.overdue).toEqual([]);
  });

  it("returns 'ok' when every active row's Expected sunset is on or after today", () => {
    const r = evaluateInventory(
      [
        row({ deployName: "a", expectedSunset: "2026-04-29" }), // exactly today is OK
        row({ deployName: "b", expectedSunset: "2030-01-01" }),
      ],
      "2026-04-29",
    );
    expect(r.outcome).toBe("ok");
    expect(r.activeRowCount).toBe(2);
  });

  it("returns 'overdue' when at least one row's Expected sunset is strictly in the past", () => {
    const r = evaluateInventory(
      [
        row({ deployName: "fresh", expectedSunset: "2030-01-01" }),
        row({
          deployName: "stale",
          owner: "internal-tools-oncall",
          expectedSunset: "2026-04-01",
        }),
      ],
      "2026-04-29",
    );
    expect(r.outcome).toBe("overdue");
    expect(r.overdue).toHaveLength(1);
    expect(r.overdue[0]!.deployName).toBe("stale");
    // The page body must name the deploy AND the owner so on-call can
    // route the nudge to the team that owns it without re-grepping
    // the file.
    expect(r.reason).toContain("stale");
    expect(r.reason).toContain("internal-tools-oncall");
    expect(r.reason).toContain("rate-limit-store-opt-outs.md");
    expect(r.overdue[0]!.daysOverdue).toBe(28);
  });

  it("sorts overdue rows oldest-sunset-first so the longest-overdue deploy leads the page", () => {
    const r = evaluateInventory(
      [
        row({ deployName: "younger", expectedSunset: "2026-04-20" }),
        row({ deployName: "older", expectedSunset: "2025-12-01" }),
        row({ deployName: "tied-a", expectedSunset: "2026-01-15" }),
        row({ deployName: "tied-b", expectedSunset: "2026-01-15" }),
      ],
      "2026-04-29",
    );
    expect(r.outcome).toBe("overdue");
    expect(r.overdue.map((o) => o.deployName)).toEqual([
      "older",
      "tied-a",
      "tied-b",
      "younger",
    ]);
  });

  it("returns 'probe_error' when a row has an unparseable Expected sunset", () => {
    const r = evaluateInventory(
      [row({ expectedSunset: "TBD" })],
      "2026-04-29",
    );
    expect(r.outcome).toBe("probe_error");
    expect(r.reason).toContain("Expected sunset");
  });

  it("returns 'probe_error' when a row has a calendar-impossible Expected sunset", () => {
    const r = evaluateInventory(
      [row({ expectedSunset: "2026-02-30" })],
      "2026-04-29",
    );
    expect(r.outcome).toBe("probe_error");
    expect(r.reason).toContain("calendar date");
  });

  it("returns 'probe_error' when today is not a valid YYYY-MM-DD (defensive)", () => {
    const r = evaluateInventory([], "not-a-date");
    expect(r.outcome).toBe("probe_error");
  });
});

describe("exitCodeFor", () => {
  it("maps each outcome to the documented exit code", () => {
    expect(exitCodeFor("ok")).toBe(0);
    expect(exitCodeFor("overdue")).toBe(2);
    expect(exitCodeFor("probe_error")).toBe(1);
  });
});

describe("main — CLI entrypoint", () => {
  function runWith(args: {
    env?: NodeJS.ProcessEnv;
    fileContents?: string;
    readError?: Error;
    now?: Date;
  }) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const readFileImpl = vi.fn().mockImplementation((_file: string) => {
      if (args.readError) throw args.readError;
      return args.fileContents ?? "";
    });
    return {
      stdout,
      stderr,
      readFileImpl,
      run: () =>
        main({
          env: args.env ?? {},
          readFileImpl,
          now: () => args.now ?? new Date("2026-04-29T00:00:00Z"),
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
        }),
    };
  }

  it("exits 1 with a structured stderr line when the inventory file cannot be read", async () => {
    const { run, stderr } = runWith({
      env: { INVENTORY_PATH: "/does/not/exist.md" },
      readError: new Error("ENOENT: no such file"),
    });
    expect(await run()).toBe(1);
    const line = JSON.parse(stderr[0]!);
    expect(line.outcome).toBe("probe_error");
    expect(line.error).toContain("ENOENT");
    expect(line.inventoryPath).toBe("/does/not/exist.md");
  });

  it("exits 1 with a structured stderr line when the inventory cannot be parsed", async () => {
    const { run, stderr } = runWith({
      env: { INVENTORY_PATH: "/inventory.md" },
      fileContents: "# unrelated document\n",
    });
    expect(await run()).toBe(1);
    const line = JSON.parse(stderr[0]!);
    expect(line.outcome).toBe("probe_error");
    expect(line.error).toContain("Active opt-outs");
  });

  it("exits 0 with a structured stdout line when the inventory is the placeholder/empty state", async () => {
    const { run, stdout, stderr } = runWith({
      env: { INVENTORY_PATH: "/inventory.md" },
      fileContents: inventoryFixture([
        "| _(none)_ | — | — | — | — | — | No production deploys are currently opted out. |",
      ]),
    });
    expect(await run()).toBe(0);
    expect(stderr).toHaveLength(0);
    const line = JSON.parse(stdout[0]!);
    expect(line.outcome).toBe("ok");
    expect(line.activeRowCount).toBe(0);
    expect(line.overdue).toEqual([]);
  });

  it("exits 0 when every active row's Expected sunset is on or after TODAY", async () => {
    const { run, stdout } = runWith({
      env: {
        INVENTORY_PATH: "/inventory.md",
        TODAY: "2026-04-29",
      },
      fileContents: inventoryFixture([
        "| api-canary | ^api-canary-[a-z0-9]+$ | rate-limit-oncall | canary | 2026-01-01 | 2026-06-01 | replica=1 |",
      ]),
    });
    expect(await run()).toBe(0);
    const line = JSON.parse(stdout[0]!);
    expect(line.outcome).toBe("ok");
    expect(line.activeRowCount).toBe(1);
  });

  it("exits 2 (page) and names the offending deploy + owner when a row's Expected sunset is in the past", async () => {
    const { run, stdout } = runWith({
      env: {
        INVENTORY_PATH: "/inventory.md",
        TODAY: "2026-04-29",
      },
      fileContents: inventoryFixture([
        "| internal-admin | ^internal-admin-[a-z0-9]+$ | internal-tools-oncall | internal-tool | 2025-08-01 | 2026-02-01 | retire by Q2 |",
        "| api-canary | ^api-canary-[a-z0-9]+$ | rate-limit-oncall | canary | 2026-01-01 | 2026-06-01 | replica=1 |",
      ]),
    });
    expect(await run()).toBe(2);
    const line = JSON.parse(stdout[0]!);
    expect(line.outcome).toBe("overdue");
    expect(line.activeRowCount).toBe(2);
    expect(line.overdue).toHaveLength(1);
    expect(line.overdue[0].deployName).toBe("internal-admin");
    expect(line.overdue[0].owner).toBe("internal-tools-oncall");
    // The structured payload must carry enough for the on-call page
    // body to be self-contained — the runbook explicitly requires
    // both the deploy name and the owner.
    expect(line.reason).toContain("internal-admin");
    expect(line.reason).toContain("internal-tools-oncall");
  });

  it("falls back to the current UTC date when TODAY is unset", async () => {
    const { run, stdout } = runWith({
      env: { INVENTORY_PATH: "/inventory.md" },
      now: new Date("2026-04-29T23:59:00Z"),
      fileContents: inventoryFixture([
        // Sunset is yesterday — overdue under today=2026-04-29.
        "| stale | ^stale-[a-z0-9]+$ | team | internal-tool | 2026-01-01 | 2026-04-28 | overdue by one day |",
      ]),
    });
    expect(await run()).toBe(2);
    const line = JSON.parse(stdout[0]!);
    expect(line.today).toBe("2026-04-29");
    expect(line.overdue[0].daysOverdue).toBe(1);
  });
});
