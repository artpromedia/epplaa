import { describe, it, expect, vi } from "vitest";
import {
  compareRuleAgainstInventory,
  exitCodeFor,
  extractSentryHostnameFilter,
  main,
  parseInventoryHostnames,
  parseSentryRulesFile,
  splitOnTopLevelPipe,
  summariseComparisons,
  type SentryRuleBody,
  type SentryRuleDescriptor,
} from "./checkRateLimitOptOutInventoryDrift";

describe("exitCodeFor", () => {
  // Centralised mapping — keep the script and any external alerting
  // wrappers in sync.
  it("maps each outcome to the documented exit code", () => {
    expect(exitCodeFor("in_sync")).toBe(0);
    expect(exitCodeFor("drift")).toBe(2);
    expect(exitCodeFor("probe_error")).toBe(1);
  });
});

describe("splitOnTopLevelPipe", () => {
  it("splits on top-level `|` only", () => {
    expect(splitOnTopLevelPipe("^a$|^b$|^c$")).toEqual(["^a$", "^b$", "^c$"]);
  });

  it("does not split on `|` inside character classes", () => {
    // `[a|b]` is a character class containing `a`, `|`, `b` — the
    // `|` inside is not an alternation. Our hostname regexes don't
    // currently use this, but the inventory format docs allow any
    // anchored pattern so the splitter must be safe.
    expect(splitOnTopLevelPipe("^[a|b]$")).toEqual(["^[a|b]$"]);
  });

  it("does not split on `|` inside groups", () => {
    expect(splitOnTopLevelPipe("^foo(a|b)bar$")).toEqual(["^foo(a|b)bar$"]);
  });

  it("does not split on escaped `\\|`", () => {
    expect(splitOnTopLevelPipe("^a\\|b$|^c$")).toEqual(["^a\\|b$", "^c$"]);
  });

  it("returns the input unchanged when there is no top-level `|`", () => {
    expect(splitOnTopLevelPipe("^api-canary-[a-z0-9]+$")).toEqual([
      "^api-canary-[a-z0-9]+$",
    ]);
  });
});

describe("parseInventoryHostnames", () => {
  // Header / separator pattern matches the live file at
  // docs/runbooks/rate-limit-store-opt-outs.md.
  const HEADER =
    "| Deploy name | `HOSTNAME` (regex match) | Owner | Reason | Opted-out since | Expected sunset | Notes |";
  const SEP =
    "| --- | --- | --- | --- | --- | --- | --- |";

  function table(rows: string[]): string {
    return [
      "## Active opt-outs",
      "",
      HEADER,
      SEP,
      ...rows,
      "",
      "### Column definitions",
      "",
      "- **Deploy name** — anything",
    ].join("\n");
  }

  it("returns an empty regex set for the placeholder-only inventory", () => {
    // This is the live state of the inventory at the time this task
    // ships — the placeholder row must NOT contribute a regex (it's
    // just documentation that the inventory is empty).
    const md = table([
      "| _(none)_ | — | — | — | — | — | No production deploys are currently opted out. |",
    ]);
    const { regexes, rowCount } = parseInventoryHostnames(md);
    expect(regexes).toEqual([]);
    expect(rowCount).toBe(0);
  });

  it("extracts each row's hostname regex, splitting on top-level `|`", () => {
    // The second row uses `\|` to escape the pipe inside the cell —
    // that's the markdown convention for a row that unions multiple
    // hostnames-for-one-deploy without breaking the table layout. The
    // parser unescapes the cell, strips backticks, then splits on
    // top-level `|` so each alternative ends up in the regex set.
    const md = table([
      "| api-canary | `^api-canary-[a-z0-9]+$` | rate-limit | canary | 2026-04-01 | 2026-07-01 | |",
      "| internal-admin | `^internal-admin-[a-z0-9]+$\\|^internal-admin-debug-[a-z0-9]+$` | platform | internal-tool | 2026-03-15 | 2026-09-01 | |",
    ]);
    const { regexes, rowCount } = parseInventoryHostnames(md);
    expect(rowCount).toBe(2);
    expect(regexes.sort()).toEqual(
      [
        "^api-canary-[a-z0-9]+$",
        "^internal-admin-[a-z0-9]+$",
        "^internal-admin-debug-[a-z0-9]+$",
      ].sort(),
    );
  });

  it("strips backticks around the regex cell so authors can use either form", () => {
    const md = table([
      "| api-canary | `^api-canary-[a-z0-9]+$` | rate-limit | canary | 2026-04-01 | 2026-07-01 | |",
      "| other | ^other-[a-z0-9]+$ | rate-limit | canary | 2026-04-01 | 2026-07-01 | |",
    ]);
    const { regexes } = parseInventoryHostnames(md);
    expect(regexes.sort()).toEqual([
      "^api-canary-[a-z0-9]+$",
      "^other-[a-z0-9]+$",
    ]);
  });

  it("throws when the `## Active opt-outs` heading is missing", () => {
    expect(() => parseInventoryHostnames("# Some other doc")).toThrow(
      /Active opt-outs/,
    );
  });

  it("throws when the section has no markdown table", () => {
    const md = ["## Active opt-outs", "", "no table here", ""].join("\n");
    expect(() => parseInventoryHostnames(md)).toThrow(/no markdown table/);
  });

  it("throws when the 2nd column header isn't the hostname regex column", () => {
    // Defensive against a future re-ordering of the inventory
    // columns silently changing which column the parser reads.
    const wrongHeader =
      "| Deploy name | Owner | `HOSTNAME` (regex match) | Reason | Opted-out since | Expected sunset | Notes |";
    const md = [
      "## Active opt-outs",
      "",
      wrongHeader,
      SEP,
      "| api-canary | rate-limit | `^api-canary-[a-z0-9]+$` | canary | 2026-04-01 | 2026-07-01 | |",
    ].join("\n");
    expect(() => parseInventoryHostnames(md)).toThrow(/HOSTNAME/);
  });

  it("throws on an active row with an empty hostname cell", () => {
    const md = table([
      "| api-canary | | rate-limit | canary | 2026-04-01 | 2026-07-01 | a real-looking row with no hostname |",
    ]);
    expect(() => parseInventoryHostnames(md)).toThrow(
      /empty \/ placeholder hostname/,
    );
  });
});

describe("extractSentryHostnameFilter", () => {
  it("returns null when no hostname-keyed entry exists", () => {
    const rule: SentryRuleBody = {
      conditions: [{ id: "sentry.rules.conditions.first_seen_event" }],
      filters: [{ id: "sentry.rules.filters.tagged_event", key: "level", match: "eq", value: "warning" }],
    };
    expect(extractSentryHostnameFilter(rule)).toBeNull();
  });

  it("extracts the filter value, match mode, and split alternatives", () => {
    const rule: SentryRuleBody = {
      conditions: [],
      filters: [
        {
          id: "sentry.rules.filters.tagged_event.TaggedEventFilter",
          key: "hostname",
          match: "re",
          value: "^api-canary-[a-z0-9]+$|^internal-admin-[a-z0-9]+$",
        },
      ],
    };
    const filter = extractSentryHostnameFilter(rule);
    expect(filter).not.toBeNull();
    expect(filter?.matchMode).toBe("re");
    expect(filter?.alternatives.sort()).toEqual([
      "^api-canary-[a-z0-9]+$",
      "^internal-admin-[a-z0-9]+$",
    ]);
  });

  it("looks at both `conditions` and `filters` arrays (Sentry shapes vary)", () => {
    const rule: SentryRuleBody = {
      conditions: [
        { id: "x.TaggedEventFilter", key: "hostname", match: "re", value: "^a$" },
      ],
      filters: [],
    };
    const filter = extractSentryHostnameFilter(rule);
    expect(filter?.alternatives).toEqual(["^a$"]);
  });

  it("matches the `hostname` key case-insensitively", () => {
    const rule: SentryRuleBody = {
      filters: [{ key: "Hostname", match: "re", value: "^a$" }],
    };
    expect(extractSentryHostnameFilter(rule)?.alternatives).toEqual(["^a$"]);
  });

  it("throws when multiple hostname entries disagree on match mode", () => {
    // A misconfigured rule with `re` and `nre` on the same key has
    // no sensible expected mode; surface it instead of guessing.
    const rule: SentryRuleBody = {
      filters: [
        { key: "hostname", match: "re", value: "^a$" },
        { key: "hostname", match: "nre", value: "^b$" },
      ],
    };
    expect(() => extractSentryHostnameFilter(rule)).toThrow(/conflicting/);
  });

  it("throws on a non-object rule body", () => {
    expect(() =>
      extractSentryHostnameFilter(null as unknown as SentryRuleBody),
    ).toThrow(/not an object/);
  });
});

describe("compareRuleAgainstInventory", () => {
  function ruleWithHostnameFilter(
    match: string,
    value: string,
  ): SentryRuleBody {
    return {
      filters: [
        {
          id: "sentry.rules.filters.tagged_event.TaggedEventFilter",
          key: "hostname",
          match,
          value,
        },
      ],
    };
  }

  it("reports in-sync when both inventory and the rule are empty", () => {
    const desc: SentryRuleDescriptor = {
      name: "audit-notification",
      expectedMatchMode: "re",
      // No hostname-keyed entry at all — observed empty set.
      rule: { filters: [] },
    };
    const cmp = compareRuleAgainstInventory([], desc);
    expect(cmp.inSync).toBe(true);
    expect(cmp.missingFromRule).toEqual([]);
    expect(cmp.extraInRule).toEqual([]);
    expect(cmp.matchModeMismatch).toBe(false);
  });

  it("reports in-sync when the regex sets match exactly (regardless of `|` ordering)", () => {
    const desc: SentryRuleDescriptor = {
      name: "audit-notification",
      expectedMatchMode: "re",
      rule: ruleWithHostnameFilter(
        "re",
        // Inventory order is canary then admin; Sentry order here is
        // reversed. Set-equality means this is still in-sync.
        "^internal-admin-[a-z0-9]+$|^api-canary-[a-z0-9]+$",
      ),
    };
    const cmp = compareRuleAgainstInventory(
      ["^api-canary-[a-z0-9]+$", "^internal-admin-[a-z0-9]+$"],
      desc,
    );
    expect(cmp.inSync).toBe(true);
  });

  it("reports drift when an inventory regex is missing from the Sentry rule (the page case)", () => {
    // Operator added a new opt-out to the inventory but forgot to
    // re-paste the union into the Sentry rule. Without this drift
    // detector, on-call would page the next time the new deploy
    // boots and emits the warn.
    const desc: SentryRuleDescriptor = {
      name: "audit-notification",
      expectedMatchMode: "re",
      rule: ruleWithHostnameFilter("re", "^api-canary-[a-z0-9]+$"),
    };
    const cmp = compareRuleAgainstInventory(
      ["^api-canary-[a-z0-9]+$", "^internal-admin-[a-z0-9]+$"],
      desc,
    );
    expect(cmp.inSync).toBe(false);
    expect(cmp.missingFromRule).toEqual(["^internal-admin-[a-z0-9]+$"]);
    expect(cmp.extraInRule).toEqual([]);
  });

  it("reports drift when the Sentry rule has a stale regex no longer in the inventory", () => {
    // Operator removed an opt-out from the inventory (deploy moved
    // to Redis or was retired) but the Sentry filter is stale — the
    // audit notification will keep matching the dead hostname's
    // warns and the page-on-unknown-host rule will incorrectly
    // suppress a real future misuse on that hostname pattern.
    const desc: SentryRuleDescriptor = {
      name: "page-on-unknown-host",
      expectedMatchMode: "nre",
      rule: ruleWithHostnameFilter(
        "nre",
        "^api-canary-[a-z0-9]+$|^retired-deploy-[a-z0-9]+$",
      ),
    };
    const cmp = compareRuleAgainstInventory(
      ["^api-canary-[a-z0-9]+$"],
      desc,
    );
    expect(cmp.inSync).toBe(false);
    expect(cmp.extraInRule).toEqual(["^retired-deploy-[a-z0-9]+$"]);
    expect(cmp.missingFromRule).toEqual([]);
  });

  it("reports drift when the rule's match mode flipped (e.g. audit became negated)", () => {
    // A rule that flipped from `re` (audit notification, matches
    // inventoried hosts) to `nre` (would now match every NON-
    // inventoried host instead) is a silent-but-catastrophic
    // misconfiguration — every sanctioned canary boot would now
    // be paged as if it were uninventoried.
    const desc: SentryRuleDescriptor = {
      name: "audit-notification",
      expectedMatchMode: "re",
      rule: ruleWithHostnameFilter("nre", "^api-canary-[a-z0-9]+$"),
    };
    const cmp = compareRuleAgainstInventory(
      ["^api-canary-[a-z0-9]+$"],
      desc,
    );
    expect(cmp.inSync).toBe(false);
    expect(cmp.matchModeMismatch).toBe(true);
    expect(cmp.observedMatchMode).toBe("nre");
  });

  it("reports drift when the inventory is empty but the Sentry rule still lists hostnames (stale rule)", () => {
    const desc: SentryRuleDescriptor = {
      name: "audit-notification",
      expectedMatchMode: "re",
      rule: ruleWithHostnameFilter("re", "^retired-deploy-[a-z0-9]+$"),
    };
    const cmp = compareRuleAgainstInventory([], desc);
    expect(cmp.inSync).toBe(false);
    expect(cmp.extraInRule).toEqual(["^retired-deploy-[a-z0-9]+$"]);
  });
});

describe("summariseComparisons", () => {
  it("returns in_sync when every per-rule comparison is in_sync", () => {
    const report = summariseComparisons("/inv.md", ["^a$"], [
      {
        name: "audit",
        expectedMatchMode: "re",
        observedMatchMode: "re",
        observedRegexes: ["^a$"],
        missingFromRule: [],
        extraInRule: [],
        matchModeMismatch: false,
        inSync: true,
      },
    ]);
    expect(report.outcome).toBe("in_sync");
  });

  it("returns drift listing every offender by name", () => {
    const report = summariseComparisons("/inv.md", ["^a$"], [
      {
        name: "audit",
        expectedMatchMode: "re",
        observedMatchMode: "re",
        observedRegexes: ["^a$"],
        missingFromRule: [],
        extraInRule: [],
        matchModeMismatch: false,
        inSync: true,
      },
      {
        name: "page-on-unknown-host",
        expectedMatchMode: "nre",
        observedMatchMode: "nre",
        observedRegexes: [],
        missingFromRule: ["^a$"],
        extraInRule: [],
        matchModeMismatch: false,
        inSync: false,
      },
    ]);
    expect(report.outcome).toBe("drift");
    expect(report.reason).toContain("page-on-unknown-host");
    expect(report.reason).toContain("/inv.md");
  });
});

describe("parseSentryRulesFile", () => {
  it("returns the descriptors when the file is well-shaped", () => {
    const parsed = {
      rules: [
        {
          name: "audit-notification",
          expectedMatchMode: "re",
          rule: { filters: [] },
        },
      ],
    };
    const out = parseSentryRulesFile(parsed);
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe("audit-notification");
    expect(out[0]?.expectedMatchMode).toBe("re");
  });

  it("throws on a non-object root", () => {
    expect(() => parseSentryRulesFile([])).toThrow(/no top-level `rules`/);
    expect(() => parseSentryRulesFile(null)).toThrow(/not a JSON object/);
  });

  it("throws when expectedMatchMode is not 're' or 'nre'", () => {
    expect(() =>
      parseSentryRulesFile({
        rules: [{ name: "x", expectedMatchMode: "eq", rule: {} }],
      }),
    ).toThrow(/expectedMatchMode/);
  });

  it("throws when name is missing", () => {
    expect(() =>
      parseSentryRulesFile({
        rules: [{ expectedMatchMode: "re", rule: {} }],
      }),
    ).toThrow(/name/);
  });
});

describe("main — CLI integration", () => {
  const HEADER =
    "| Deploy name | `HOSTNAME` (regex match) | Owner | Reason | Opted-out since | Expected sunset | Notes |";
  const SEP =
    "| --- | --- | --- | --- | --- | --- | --- |";

  function inventoryWith(rows: string[]): string {
    return [
      "## Active opt-outs",
      "",
      HEADER,
      SEP,
      ...rows,
      "",
      "### Column definitions",
      "",
    ].join("\n");
  }

  it("exits 1 with a structured stderr line when SENTRY_RULES_PATH is missing", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const code = await main({
      env: { INVENTORY_PATH: "ignored" },
      readFile: () => "",
      stdout,
      stderr,
    });
    expect(code).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    const errLine = stderr.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(errLine);
    expect(parsed.outcome).toBe("probe_error");
    expect(parsed.error).toMatch(/SENTRY_RULES_PATH/);
  });

  it("exits 0 with an in_sync report when the inventory and rule match", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const inventory = inventoryWith([
      "| api-canary | `^api-canary-[a-z0-9]+$` | rate-limit | canary | 2026-04-01 | 2026-07-01 | |",
    ]);
    const rules = JSON.stringify({
      rules: [
        {
          name: "audit-notification",
          expectedMatchMode: "re",
          rule: {
            filters: [
              {
                id: "sentry.rules.filters.tagged_event.TaggedEventFilter",
                key: "hostname",
                match: "re",
                value: "^api-canary-[a-z0-9]+$",
              },
            ],
          },
        },
      ],
    });
    const reads: Record<string, string> = {
      "/inv.md": inventory,
      "/rules.json": rules,
    };
    const code = await main({
      env: {
        INVENTORY_PATH: "/inv.md",
        SENTRY_RULES_PATH: "/rules.json",
      },
      readFile: (p) => reads[p] ?? "",
      stdout,
      stderr,
    });
    expect(code).toBe(0);
    const out = JSON.parse(stdout.mock.calls[0]?.[0] as string);
    expect(out.outcome).toBe("in_sync");
    expect(out.inventoryRegexes).toEqual(["^api-canary-[a-z0-9]+$"]);
    expect(stderr).not.toHaveBeenCalled();
  });

  it("exits 2 with a drift report when an inventory entry is missing from the rule", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const inventory = inventoryWith([
      "| api-canary | `^api-canary-[a-z0-9]+$` | rate-limit | canary | 2026-04-01 | 2026-07-01 | |",
      "| internal-admin | `^internal-admin-[a-z0-9]+$` | platform | internal-tool | 2026-04-01 | 2026-09-01 | |",
    ]);
    const rules = JSON.stringify({
      rules: [
        {
          name: "audit-notification",
          expectedMatchMode: "re",
          rule: {
            filters: [
              {
                id: "sentry.rules.filters.tagged_event.TaggedEventFilter",
                key: "hostname",
                match: "re",
                // Stale: missing the new internal-admin row.
                value: "^api-canary-[a-z0-9]+$",
              },
            ],
          },
        },
        {
          name: "page-on-unknown-host",
          expectedMatchMode: "nre",
          rule: {
            filters: [
              {
                id: "sentry.rules.filters.tagged_event.TaggedEventFilter",
                key: "hostname",
                match: "nre",
                value: "^api-canary-[a-z0-9]+$",
              },
            ],
          },
        },
      ],
    });
    const reads: Record<string, string> = {
      "/inv.md": inventory,
      "/rules.json": rules,
    };
    const code = await main({
      env: {
        INVENTORY_PATH: "/inv.md",
        SENTRY_RULES_PATH: "/rules.json",
      },
      readFile: (p) => reads[p] ?? "",
      stdout,
      stderr,
    });
    expect(code).toBe(2);
    const out = JSON.parse(stdout.mock.calls[0]?.[0] as string);
    expect(out.outcome).toBe("drift");
    // Both rules are out-of-sync (missing the same entry); both
    // should appear in the offenders list so the page body names
    // every rule that needs re-pasting.
    expect(out.reason).toContain("audit-notification");
    expect(out.reason).toContain("page-on-unknown-host");
    expect(out.rules[0].missingFromRule).toEqual([
      "^internal-admin-[a-z0-9]+$",
    ]);
  });

  it("exits 1 with probe_error when the inventory file can't be read", async () => {
    const stderr = vi.fn();
    const code = await main({
      env: {
        INVENTORY_PATH: "/missing.md",
        SENTRY_RULES_PATH: "/rules.json",
      },
      readFile: (p) => {
        if (p === "/missing.md") throw new Error("ENOENT");
        return "{}";
      },
      stdout: () => undefined,
      stderr,
    });
    expect(code).toBe(1);
    const err = JSON.parse(stderr.mock.calls[0]?.[0] as string);
    expect(err.outcome).toBe("probe_error");
    expect(err.error).toMatch(/inventory/);
  });

  it("exits 1 with probe_error when the Sentry rules JSON is malformed", async () => {
    const stderr = vi.fn();
    const code = await main({
      env: {
        INVENTORY_PATH: "/inv.md",
        SENTRY_RULES_PATH: "/rules.json",
      },
      readFile: (p) => {
        if (p === "/inv.md") {
          return [
            "## Active opt-outs",
            "",
            "| Deploy name | `HOSTNAME` (regex match) | Owner | Reason | Opted-out since | Expected sunset | Notes |",
            "| --- | --- | --- | --- | --- | --- | --- |",
            "| _(none)_ | — | — | — | — | — | none |",
          ].join("\n");
        }
        return "not json at all";
      },
      stdout: () => undefined,
      stderr,
    });
    expect(code).toBe(1);
    const err = JSON.parse(stderr.mock.calls[0]?.[0] as string);
    expect(err.outcome).toBe("probe_error");
  });
});
