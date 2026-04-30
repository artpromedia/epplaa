import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  extractCronEntriesFromWorkflowYaml,
  extractMonitorSlugsFromWorkflowYaml,
  diffMonitorAgainstWorkflow,
  SENTRY_MONITORS,
  SENTRY_MONITORS_KNOWN_UI_MANAGED,
  type SentryMonitorConfig,
  type SentryMonitorUiManagedEntry,
} from "./sentryMonitors.config.js";
import {
  runChecks,
  runReverseScan,
  buildKnownSlugSet,
  main,
} from "./checkSentryMonitorsInSync.js";

const baseMonitor: SentryMonitorConfig = {
  slug: "example",
  name: "Example",
  workflowFile: ".github/workflows/example.yml",
  schedule: "*/5 * * * *",
  scheduleType: "crontab",
  timezone: "UTC",
  checkinMarginMinutes: 5,
  maxRuntimeMinutes: 10,
  failureIssueThreshold: 1,
  recoveryThreshold: 1,
  environment: "production",
  runbookSection: "docs/runbooks/example.md",
};

describe("extractCronEntriesFromWorkflowYaml", () => {
  it("extracts a double-quoted cron from the canonical workflow shape", () => {
    const yaml = [
      "name: Example",
      "",
      "on:",
      "  schedule:",
      '    - cron: "*/5 * * * *"',
      "  workflow_dispatch: {}",
    ].join("\n");
    expect(extractCronEntriesFromWorkflowYaml(yaml)).toEqual(["*/5 * * * *"]);
  });

  it("extracts a single-quoted cron", () => {
    const yaml = [
      "on:",
      "  schedule:",
      "    - cron: '0 3 * * 0'",
    ].join("\n");
    expect(extractCronEntriesFromWorkflowYaml(yaml)).toEqual(["0 3 * * 0"]);
  });

  it("extracts an unquoted cron (with a trailing inline comment)", () => {
    const yaml = [
      "on:",
      "  schedule:",
      "    - cron: 0 3 * * 0   # weekly Sunday 03:00 UTC",
    ].join("\n");
    expect(extractCronEntriesFromWorkflowYaml(yaml)).toEqual(["0 3 * * 0"]);
  });

  it("returns multiple crons when the workflow declares more than one", () => {
    const yaml = [
      "on:",
      "  schedule:",
      '    - cron: "*/5 * * * *"',
      '    - cron: "0 3 * * 0"',
    ].join("\n");
    expect(extractCronEntriesFromWorkflowYaml(yaml)).toEqual([
      "*/5 * * * *",
      "0 3 * * 0",
    ]);
  });

  it("returns [] when the workflow has no schedule block", () => {
    const yaml = [
      "name: Manual",
      "on:",
      "  workflow_dispatch: {}",
    ].join("\n");
    expect(extractCronEntriesFromWorkflowYaml(yaml)).toEqual([]);
  });
});

describe("diffMonitorAgainstWorkflow", () => {
  it("returns null when the cron matches", () => {
    const yaml = [
      "on:",
      "  schedule:",
      '    - cron: "*/5 * * * *"',
    ].join("\n");
    expect(diffMonitorAgainstWorkflow(baseMonitor, yaml)).toBeNull();
  });

  it("flags drift when the cron differs", () => {
    const yaml = [
      "on:",
      "  schedule:",
      '    - cron: "*/10 * * * *"',
    ].join("\n");
    const reason = diffMonitorAgainstWorkflow(baseMonitor, yaml);
    expect(reason).toContain('"example"');
    expect(reason).toContain('"*/5 * * * *"');
    expect(reason).toContain('"*/10 * * * *"');
    expect(reason).toContain("schedule drift");
  });

  it("flags an empty schedule block (cron deleted but monitor still declared)", () => {
    const yaml = ["on:", "  workflow_dispatch: {}"].join("\n");
    const reason = diffMonitorAgainstWorkflow(baseMonitor, yaml);
    expect(reason).toContain("no `schedule:` cron");
  });

  it("flags multiple cron entries (single-monitor heartbeats can't model that)", () => {
    const yaml = [
      "on:",
      "  schedule:",
      '    - cron: "*/5 * * * *"',
      '    - cron: "0 3 * * 0"',
    ].join("\n");
    const reason = diffMonitorAgainstWorkflow(baseMonitor, yaml);
    expect(reason).toContain("can only heartbeat a single cron schedule");
  });
});

describe("runChecks (file-missing path)", () => {
  it("flags monitors whose workflow file is gone from disk", () => {
    const results = runChecks([baseMonitor], () => ({
      exists: false,
      source: "",
    }));
    expect(results).toHaveLength(1);
    expect(results[0]!.fileMissing).toBe(true);
    expect(results[0]!.driftReason).toContain("does not exist");
  });
});

describe("extractMonitorSlugsFromWorkflowYaml", () => {
  it("extracts the slug from the canonical multi-line shell invocation", () => {
    const yaml = [
      "      - name: Run probe",
      "        run: |",
      "          sentry-cli monitors run \\",
      "            --environment production \\",
      "            check-healthz-degraded \\",
      '            -- "$PROBE_LOOP_SCRIPT"',
    ].join("\n");
    expect(extractMonitorSlugsFromWorkflowYaml(yaml)).toEqual([
      "check-healthz-degraded",
    ]);
  });

  it("extracts the slug from a single-line invocation", () => {
    const yaml =
      "          sentry-cli monitors run --environment production my-slug -- ./run.sh";
    expect(extractMonitorSlugsFromWorkflowYaml(yaml)).toEqual(["my-slug"]);
  });

  it("handles `--flag=value` syntax (one token per flag)", () => {
    const yaml =
      "          sentry-cli monitors run --environment=production my-slug -- ./run.sh";
    expect(extractMonitorSlugsFromWorkflowYaml(yaml)).toEqual(["my-slug"]);
  });

  it("returns multiple slugs when a workflow has multiple invocations", () => {
    const yaml = [
      "          sentry-cli monitors run --environment production slug-a -- ./a.sh",
      "          sentry-cli monitors run --environment production slug-b -- ./b.sh",
    ].join("\n");
    expect(extractMonitorSlugsFromWorkflowYaml(yaml)).toEqual([
      "slug-a",
      "slug-b",
    ]);
  });

  it("ignores YAML comment lines mentioning the command in prose", () => {
    const yaml = [
      "# The verify step is wrapped with `sentry-cli monitors run not-a-real-slug`",
      "#   sentry-cli monitors run also-not-real -- ...",
      "      - name: Run",
      "        run: |",
      "          sentry-cli monitors run --environment production real-slug -- ./run.sh",
    ].join("\n");
    expect(extractMonitorSlugsFromWorkflowYaml(yaml)).toEqual(["real-slug"]);
  });

  it("filters out dynamic slug references like `${slug}` inside echo strings", () => {
    // Mirrors the rehearse-healthz-degraded.yml pattern, where the
    // `sentry-cli monitors run ${slug}` text appears inside an echo
    // body that explains the heartbeat to on-call but doesn't
    // actually invoke it for a fixed slug.
    const yaml = [
      "      - name: Verify monitors",
      "        run: |",
      "          for entry in \"${SLUGS[@]}\"; do",
      "            slug=\"${entry%%|*}\"",
      "            echo \"::error::will silently break: 'sentry-cli monitors run ${slug}' lost\"",
      "          done",
    ].join("\n");
    expect(extractMonitorSlugsFromWorkflowYaml(yaml)).toEqual([]);
  });

  it("returns [] when no `sentry-cli monitors run` invocation is present", () => {
    const yaml = [
      "name: Manual",
      "on:",
      "  workflow_dispatch: {}",
      "jobs:",
      "  noop:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo hi",
    ].join("\n");
    expect(extractMonitorSlugsFromWorkflowYaml(yaml)).toEqual([]);
  });

  it("handles invocations with no `--` separator (slug at end of line)", () => {
    const yaml =
      "          sentry-cli monitors run --environment production trailing-slug";
    expect(extractMonitorSlugsFromWorkflowYaml(yaml)).toEqual([
      "trailing-slug",
    ]);
  });
});

describe("buildKnownSlugSet", () => {
  it("unions SENTRY_MONITORS slugs with SENTRY_MONITORS_KNOWN_UI_MANAGED slugs", () => {
    const monitors: SentryMonitorConfig[] = [
      { ...baseMonitor, slug: "fully-managed" },
    ];
    const uiManaged: SentryMonitorUiManagedEntry[] = [
      {
        slug: "ui-managed",
        workflowFile: ".github/workflows/x.yml",
        note: "test",
      },
    ];
    const set = buildKnownSlugSet(monitors, uiManaged);
    expect([...set].sort()).toEqual(["fully-managed", "ui-managed"]);
  });
});

describe("runReverseScan", () => {
  const yamlWithSlug = (slug: string): string =>
    [
      "      - name: Run",
      "        run: |",
      "          sentry-cli monitors run \\",
      "            --environment production \\",
      `            ${slug} \\`,
      '            -- "$RUNNER_TEMP/probe.sh"',
    ].join("\n");

  it("returns no findings when every used slug is in the known set", () => {
    const findings = runReverseScan(
      [".github/workflows/a.yml"],
      new Set(["known-slug"]),
      () => ({ exists: true, source: yamlWithSlug("known-slug") }),
    );
    expect(findings).toEqual([]);
  });

  it("flags a slug that's used in a workflow but not declared anywhere", () => {
    const findings = runReverseScan(
      [".github/workflows/new-thing.yml"],
      new Set(["known-slug"]),
      () => ({ exists: true, source: yamlWithSlug("brand-new-slug") }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.slug).toBe("brand-new-slug");
    expect(findings[0]!.workflowFile).toBe(".github/workflows/new-thing.yml");
    expect(findings[0]!.reason).toContain("brand-new-slug");
    expect(findings[0]!.reason).toContain(".github/workflows/new-thing.yml");
    expect(findings[0]!.reason).toContain("SENTRY_MONITORS");
    expect(findings[0]!.reason).toContain("SENTRY_MONITORS_KNOWN_UI_MANAGED");
  });

  it("dedupes the same slug appearing multiple times in one workflow file", () => {
    const yaml = [yamlWithSlug("dup-slug"), yamlWithSlug("dup-slug")].join(
      "\n",
    );
    const findings = runReverseScan(
      [".github/workflows/dupes.yml"],
      new Set<string>(),
      () => ({ exists: true, source: yaml }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.slug).toBe("dup-slug");
  });

  it("reports the same slug separately when it appears in two workflows", () => {
    const sources: Record<string, string> = {
      ".github/workflows/a.yml": yamlWithSlug("shared-unknown"),
      ".github/workflows/b.yml": yamlWithSlug("shared-unknown"),
    };
    const findings = runReverseScan(
      [".github/workflows/a.yml", ".github/workflows/b.yml"],
      new Set<string>(),
      (wf) => ({ exists: true, source: sources[wf] ?? "" }),
    );
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.workflowFile).sort()).toEqual([
      ".github/workflows/a.yml",
      ".github/workflows/b.yml",
    ]);
  });

  it("recognises slugs from SENTRY_MONITORS_KNOWN_UI_MANAGED as known", () => {
    const monitors: SentryMonitorConfig[] = [];
    const uiManaged: SentryMonitorUiManagedEntry[] = [
      {
        slug: "ui-only",
        workflowFile: ".github/workflows/ui-only.yml",
        note: "test",
      },
    ];
    const findings = runReverseScan(
      [".github/workflows/ui-only.yml"],
      buildKnownSlugSet(monitors, uiManaged),
      () => ({ exists: true, source: yamlWithSlug("ui-only") }),
    );
    expect(findings).toEqual([]);
  });

  it("silently skips workflow files that don't exist on disk", () => {
    const findings = runReverseScan(
      [".github/workflows/missing.yml"],
      new Set<string>(),
      () => ({ exists: false, source: "" }),
    );
    expect(findings).toEqual([]);
  });
});

describe("main", () => {
  it("returns 0 and logs success when all monitors are in sync and no undeclared slugs", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = main({
      monitors: [baseMonitor],
      uiManaged: [],
      readWorkflow: () => ({
        exists: true,
        source: 'on:\n  schedule:\n    - cron: "*/5 * * * *"\n',
      }),
      discoverWorkflows: () => [],
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });
    expect(code).toBe(0);
    expect(stdout.some((l) => l.includes("in sync"))).toBe(true);
    expect(stderr).toEqual([]);
  });

  it("returns 1 and writes per-offender lines to stderr on cron drift", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = main({
      monitors: [baseMonitor],
      uiManaged: [],
      readWorkflow: () => ({
        exists: true,
        source: 'on:\n  schedule:\n    - cron: "*/10 * * * *"\n',
      }),
      discoverWorkflows: () => [],
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });
    expect(code).toBe(1);
    expect(stderr.some((l) => l.includes("DRIFT DETECTED"))).toBe(true);
    expect(stderr.some((l) => l.includes("schedule drift"))).toBe(true);
  });

  it("returns 1 and names the missing slug when a workflow uses an undeclared slug", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const yamlWithNewSlug = [
      "on:",
      "  schedule:",
      '    - cron: "0 4 * * *"',
      "jobs:",
      "  probe:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: |",
      "          sentry-cli monitors run \\",
      "            --environment production \\",
      "            never-registered-slug \\",
      '            -- "./probe.sh"',
    ].join("\n");
    const code = main({
      monitors: [],
      uiManaged: [],
      readWorkflow: () => ({ exists: true, source: yamlWithNewSlug }),
      discoverWorkflows: () => [".github/workflows/some-new-probe.yml"],
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });
    expect(code).toBe(1);
    expect(stderr.some((l) => l.includes("UNDECLARED SLUGS DETECTED"))).toBe(
      true,
    );
    expect(stderr.some((l) => l.includes("never-registered-slug"))).toBe(true);
    expect(
      stderr.some((l) => l.includes(".github/workflows/some-new-probe.yml")),
    ).toBe(true);
    // The fix-up sentence must point operators at both lists so they
    // know the difference between full management and UI-managed
    // acknowledgement.
    expect(
      stderr.some(
        (l) =>
          l.includes("SENTRY_MONITORS") &&
          l.includes("SENTRY_MONITORS_KNOWN_UI_MANAGED"),
      ),
    ).toBe(true);
  });

  it("emits BOTH drift and undeclared-slug error blocks when both are present", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const driftYaml = 'on:\n  schedule:\n    - cron: "0 0 * * *"\n';
    const newSlugYaml =
      "          sentry-cli monitors run --environment production rogue -- ./x.sh";
    const code = main({
      monitors: [baseMonitor],
      uiManaged: [],
      readWorkflow: (wf) => {
        if (wf === baseMonitor.workflowFile) {
          return { exists: true, source: driftYaml };
        }
        return { exists: true, source: newSlugYaml };
      },
      discoverWorkflows: () => [".github/workflows/rogue.yml"],
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });
    expect(code).toBe(1);
    expect(stderr.some((l) => l.includes("DRIFT DETECTED"))).toBe(true);
    expect(stderr.some((l) => l.includes("UNDECLARED SLUGS DETECTED"))).toBe(
      true,
    );
    expect(stderr.some((l) => l.includes("rogue"))).toBe(true);
  });

  it("treats SENTRY_MONITORS_KNOWN_UI_MANAGED entries as registered (no false-positive)", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = main({
      monitors: [],
      uiManaged: [
        {
          slug: "managed-in-ui",
          workflowFile: ".github/workflows/ui-managed.yml",
          note: "lives in the Sentry UI for now",
        },
      ],
      readWorkflow: () => ({
        exists: true,
        source: [
          "on:",
          "  schedule:",
          '    - cron: "*/15 * * * *"',
          "  workflow_dispatch: {}",
          "",
          "jobs:",
          "  probe:",
          "    steps:",
          "      - run: sentry-cli monitors run --environment production managed-in-ui -- ./run.sh",
        ].join("\n"),
      }),
      discoverWorkflows: () => [".github/workflows/ui-managed.yml"],
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });
    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.some((l) => l.includes("UI-managed slug"))).toBe(true);
    expect(stdout.some((l) => l.includes("managed-in-ui"))).toBe(true);
  });
});

// Belt-and-braces: actually run the real checked-in monitors against
// the real checked-in workflows using the production reader. If any
// drift exists at this commit — in either direction — this test will
// fail with the same reason the CI step would print, surfacing it in
// `pnpm test` even before the dedicated CI step runs.
describe("SENTRY_MONITORS / SENTRY_MONITORS_KNOWN_UI_MANAGED (real config)", () => {
  it("matches the cron in every referenced workflow file AND has no undeclared slugs in any workflow", () => {
    const stderr: string[] = [];
    const stdout: string[] = [];
    const code = main({
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });
    if (code !== 0) {
      throw new Error(
        `Sentry monitor drift or undeclared slug detected:\n${stderr.join("\n")}`,
      );
    }
    expect(SENTRY_MONITORS.length).toBeGreaterThan(0);
  });

  it("every UI-managed inventory entry's slug actually appears in the workflow it claims to heartbeat for", () => {
    // Tightening loop on the inventory: an entry whose `workflowFile`
    // doesn't actually invoke the slug is a stale entry — surface it
    // here rather than discovering at the next "monitor stopped
    // paging" outage.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, "..", "..");
    for (const entry of SENTRY_MONITORS_KNOWN_UI_MANAGED) {
      const abs = path.join(repoRoot, entry.workflowFile);
      expect(existsSync(abs), `${entry.workflowFile} missing`).toBe(true);
      const source = readFileSync(abs, "utf8");
      const slugs = extractMonitorSlugsFromWorkflowYaml(source);
      expect(
        slugs,
        `expected workflow ${entry.workflowFile} to invoke \`sentry-cli monitors run ${entry.slug}\``,
      ).toContain(entry.slug);
    }
  });
});
