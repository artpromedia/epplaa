import { describe, it, expect } from "vitest";
import {
  checkCredentials,
  main,
} from "./checkSentrySyncCredentials.js";
import type { SentryMonitorConfig } from "./sentryMonitors.config.js";

const monitor: SentryMonitorConfig = {
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

const otherMonitor: SentryMonitorConfig = {
  ...monitor,
  slug: "other-example",
  name: "Other Example",
};

describe("checkCredentials", () => {
  it("is OK when no monitors are declared, regardless of env (sync correctly disabled)", () => {
    const result = checkCredentials([], {});
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.declaredMonitorSlugs).toEqual([]);
  });

  it("is OK when monitors are declared and both credentials are present", () => {
    const result = checkCredentials([monitor], {
      SENTRY_ORG: "epplaa",
      SENTRY_AUTH_TOKEN: "tok",
    });
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.declaredMonitorSlugs).toEqual(["example"]);
  });

  it("flags vars.SENTRY_ORG when only it is missing", () => {
    const result = checkCredentials([monitor], {
      SENTRY_AUTH_TOKEN: "tok",
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["vars.SENTRY_ORG"]);
  });

  it("flags secrets.SENTRY_AUTH_TOKEN when only it is missing", () => {
    const result = checkCredentials([monitor], {
      SENTRY_ORG: "epplaa",
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["secrets.SENTRY_AUTH_TOKEN"]);
  });

  it("flags both when both are missing (typical fork-without-secrets case)", () => {
    const result = checkCredentials([monitor], {});
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([
      "vars.SENTRY_ORG",
      "secrets.SENTRY_AUTH_TOKEN",
    ]);
  });

  it("treats whitespace-only env values as missing (parity with syncSentryMonitors)", () => {
    const result = checkCredentials([monitor], {
      SENTRY_ORG: "   ",
      SENTRY_AUTH_TOKEN: "\t\n",
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([
      "vars.SENTRY_ORG",
      "secrets.SENTRY_AUTH_TOKEN",
    ]);
  });

  it("treats the literal empty string as missing", () => {
    const result = checkCredentials([monitor], {
      SENTRY_ORG: "",
      SENTRY_AUTH_TOKEN: "",
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([
      "vars.SENTRY_ORG",
      "secrets.SENTRY_AUTH_TOKEN",
    ]);
  });

  it("returns every declared monitor slug so the failure message names what won't sync", () => {
    const result = checkCredentials([monitor, otherMonitor], {});
    expect(result.declaredMonitorSlugs).toEqual([
      "example",
      "other-example",
    ]);
  });
});

describe("main", () => {
  it("returns 0 and explains the no-op when SENTRY_MONITORS is empty", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = main({
      monitors: [],
      env: {},
      stdout: (l) => stdout.push(l),
      stderr: (l) => stderr.push(l),
    });
    expect(code).toBe(0);
    expect(stdout.some((l) => l.includes("intentionally disabled"))).toBe(
      true,
    );
    expect(stderr).toEqual([]);
  });

  it("returns 0 and confirms readiness when monitors and credentials are both present", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = main({
      monitors: [monitor],
      env: { SENTRY_ORG: "epplaa", SENTRY_AUTH_TOKEN: "tok" },
      stdout: (l) => stdout.push(l),
      stderr: (l) => stderr.push(l),
    });
    expect(code).toBe(0);
    expect(stdout.some((l) => l.includes("OK"))).toBe(true);
    expect(stdout.some((l) => l.includes("example"))).toBe(true);
    expect(stderr).toEqual([]);
  });

  it("returns 1 and prints actionable remediation when credentials are missing", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = main({
      monitors: [monitor],
      env: {},
      stdout: (l) => stdout.push(l),
      stderr: (l) => stderr.push(l),
    });
    expect(code).toBe(1);
    expect(stderr.some((l) => l.includes("MISCONFIGURED"))).toBe(true);
    expect(stderr.some((l) => l.includes("vars.SENTRY_ORG"))).toBe(true);
    expect(stderr.some((l) => l.includes("secrets.SENTRY_AUTH_TOKEN"))).toBe(
      true,
    );
    // Must name the affected monitor so the operator sees what won't sync.
    expect(stderr.some((l) => l.includes("example"))).toBe(true);
    // Must offer the "delete the entries" escape hatch for forks that
    // legitimately don't run their own Sentry project.
    expect(
      stderr.some((l) =>
        l.includes("delete the entries from scripts/src/sentryMonitors.config.ts"),
      ),
    ).toBe(true);
    // Must explain the silent-skip failure mode so the fix isn't a
    // mystery to whoever's reading the failed CI log.
    expect(
      stderr.some((l) =>
        l.includes("`vars.SENTRY_ORG != ''`"),
      ),
    ).toBe(true);
  });

  it("returns 1 when only one credential is missing (partial misconfig)", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = main({
      monitors: [monitor],
      env: { SENTRY_ORG: "epplaa" },
      stdout: (l) => stdout.push(l),
      stderr: (l) => stderr.push(l),
    });
    expect(code).toBe(1);
    expect(stderr.some((l) => l.includes("secrets.SENTRY_AUTH_TOKEN"))).toBe(
      true,
    );
    // Should NOT spuriously list the credential that IS configured.
    expect(stderr.some((l) => /^\s+- vars\.SENTRY_ORG$/.test(l))).toBe(false);
  });
});
