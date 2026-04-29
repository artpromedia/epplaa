import { describe, it, expect } from "vitest";
import {
  extractCronEntriesFromWorkflowYaml,
  diffMonitorAgainstWorkflow,
  SENTRY_MONITORS,
  type SentryMonitorConfig,
} from "./sentryMonitors.config.js";
import { runChecks, main } from "./checkSentryMonitorsInSync.js";

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

describe("main", () => {
  it("returns 0 and logs success when all monitors are in sync", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = main({
      monitors: [baseMonitor],
      readWorkflow: () => ({
        exists: true,
        source: 'on:\n  schedule:\n    - cron: "*/5 * * * *"\n',
      }),
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });
    expect(code).toBe(0);
    expect(stdout.some((l) => l.includes("in sync"))).toBe(true);
    expect(stderr).toEqual([]);
  });

  it("returns 1 and writes per-offender lines to stderr on drift", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = main({
      monitors: [baseMonitor],
      readWorkflow: () => ({
        exists: true,
        source: 'on:\n  schedule:\n    - cron: "*/10 * * * *"\n',
      }),
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });
    expect(code).toBe(1);
    expect(stderr.some((l) => l.includes("DRIFT DETECTED"))).toBe(true);
    expect(stderr.some((l) => l.includes("schedule drift"))).toBe(true);
  });
});

// Belt-and-braces: actually run the real checked-in monitors against
// the real checked-in workflows using the production reader. If any
// drift exists at this commit, this test will fail with the same
// reason the CI step would print, surfacing it in `pnpm test` even
// before the dedicated CI step runs.
describe("SENTRY_MONITORS (real config)", () => {
  it("matches the cron in every referenced workflow file", () => {
    const stderr: string[] = [];
    const stdout: string[] = [];
    const code = main({
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });
    if (code !== 0) {
      throw new Error(
        `Sentry monitor drift detected:\n${stderr.join("\n")}`,
      );
    }
    expect(SENTRY_MONITORS.length).toBeGreaterThan(0);
  });
});
