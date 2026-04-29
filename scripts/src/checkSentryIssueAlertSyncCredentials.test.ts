import { describe, it, expect } from "vitest";
import {
  checkCredentials,
  main,
} from "./checkSentryIssueAlertSyncCredentials.js";
import type { ProductionSecretAlertConfig } from "./productionSecretAlerts.config.js";

const sentryAlert: ProductionSecretAlertConfig = {
  messageTag: "clerk_secret_key_missing_for_production",
  summary: "x",
  severity: "sev-1",
  runbookAnchor: "#clerk_secret_key",
  sentry: { canonical: true, backstop: false },
  logAggregator: { canonical: false, backstop: true },
  emittedBy: "artifacts/api-server/src/middlewares/clerkProxyMiddleware.ts",
};

const logOnlyAlert: ProductionSecretAlertConfig = {
  ...sentryAlert,
  messageTag: "log_only",
  sentry: { canonical: false, backstop: false },
  logAggregator: { canonical: true, backstop: false },
};

describe("checkCredentials", () => {
  it("is OK when no Sentry-routed alerts are declared, regardless of env", () => {
    const result = checkCredentials([logOnlyAlert], {});
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.declaredAlertTags).toEqual([]);
  });

  it("is OK when alerts are declared and all three credentials are present", () => {
    const result = checkCredentials([sentryAlert], {
      SENTRY_ORG: "epplaa",
      SENTRY_PROJECT: "api-server",
      SENTRY_AUTH_TOKEN: "tok",
    });
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.declaredAlertTags).toEqual([
      "clerk_secret_key_missing_for_production",
    ]);
  });

  it("flags every missing credential simultaneously", () => {
    const result = checkCredentials([sentryAlert], {});
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([
      "vars.SENTRY_ORG",
      "vars.SENTRY_PROJECT",
      "secrets.SENTRY_AUTH_TOKEN",
    ]);
  });

  it("treats whitespace-only env values as missing", () => {
    const result = checkCredentials([sentryAlert], {
      SENTRY_ORG: "  ",
      SENTRY_PROJECT: "\t",
      SENTRY_AUTH_TOKEN: "\n",
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([
      "vars.SENTRY_ORG",
      "vars.SENTRY_PROJECT",
      "secrets.SENTRY_AUTH_TOKEN",
    ]);
  });

  it("flags only SENTRY_PROJECT when it is the only one missing", () => {
    const result = checkCredentials([sentryAlert], {
      SENTRY_ORG: "o",
      SENTRY_AUTH_TOKEN: "t",
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["vars.SENTRY_PROJECT"]);
  });
});

describe("main", () => {
  it("returns 0 with a clear no-op message when no Sentry-routed alerts exist", () => {
    const stdout: string[] = [];
    const code = main({
      alerts: [logOnlyAlert],
      env: {},
      stdout: (l) => stdout.push(l),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(stdout.some((l) => l.includes("intentionally disabled"))).toBe(
      true,
    );
  });

  it("returns 0 and confirms readiness when alerts and credentials are present", () => {
    const stdout: string[] = [];
    const code = main({
      alerts: [sentryAlert],
      env: {
        SENTRY_ORG: "o",
        SENTRY_PROJECT: "p",
        SENTRY_AUTH_TOKEN: "t",
      },
      stdout: (l) => stdout.push(l),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(stdout.some((l) => l.includes("OK"))).toBe(true);
    expect(
      stdout.some((l) =>
        l.includes("clerk_secret_key_missing_for_production"),
      ),
    ).toBe(true);
  });

  it("returns 1 with actionable remediation when credentials are missing", () => {
    const stderr: string[] = [];
    const code = main({
      alerts: [sentryAlert],
      env: {},
      stdout: () => {},
      stderr: (l) => stderr.push(l),
    });
    expect(code).toBe(1);
    expect(stderr.some((l) => l.includes("MISCONFIGURED"))).toBe(true);
    expect(stderr.some((l) => l.includes("vars.SENTRY_ORG"))).toBe(true);
    expect(stderr.some((l) => l.includes("vars.SENTRY_PROJECT"))).toBe(true);
    expect(stderr.some((l) => l.includes("secrets.SENTRY_AUTH_TOKEN"))).toBe(
      true,
    );
    expect(
      stderr.some((l) =>
        l.includes("clerk_secret_key_missing_for_production"),
      ),
    ).toBe(true);
    // Mentions the opt-out path so a fork can disable cleanly.
    expect(
      stderr.some((l) =>
        l.includes("scripts/src/productionSecretAlerts.config.ts"),
      ),
    ).toBe(true);
  });

  it("returns 1 when only the project slug is missing (partial misconfig)", () => {
    const stderr: string[] = [];
    const code = main({
      alerts: [sentryAlert],
      env: { SENTRY_ORG: "o", SENTRY_AUTH_TOKEN: "t" },
      stdout: () => {},
      stderr: (l) => stderr.push(l),
    });
    expect(code).toBe(1);
    expect(stderr.some((l) => l.includes("vars.SENTRY_PROJECT"))).toBe(true);
    expect(stderr.some((l) => /^\s+- vars\.SENTRY_ORG$/.test(l))).toBe(false);
    expect(
      stderr.some((l) => /^\s+- secrets\.SENTRY_AUTH_TOKEN$/.test(l)),
    ).toBe(false);
  });
});
