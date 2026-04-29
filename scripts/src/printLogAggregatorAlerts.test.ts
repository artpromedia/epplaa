import { describe, it, expect } from "vitest";
import {
  parseFormat,
  render,
  main,
} from "./printLogAggregatorAlerts.js";
import {
  PRODUCTION_SECRET_ALERTS,
  type ProductionSecretAlertConfig,
} from "./productionSecretAlerts.config.js";

const dsnAlert: ProductionSecretAlertConfig = {
  messageTag: "sentry_dsn_missing_for_production",
  summary: "DSN missing",
  severity: "sev-2",
  runbookAnchor: "#sentry_dsn",
  sentry: { canonical: false, backstop: true },
  logAggregator: { canonical: true, backstop: false },
  emittedBy: "artifacts/api-server/src/lib/sentry.ts",
};

const clerkAlert: ProductionSecretAlertConfig = {
  messageTag: "clerk_secret_key_missing_for_production",
  summary: "Clerk auth bypass",
  severity: "sev-1",
  runbookAnchor: "#clerk_secret_key",
  sentry: { canonical: true, backstop: false },
  logAggregator: { canonical: false, backstop: true },
  emittedBy: "artifacts/api-server/src/middlewares/clerkProxyMiddleware.ts",
};

const sentryOnly: ProductionSecretAlertConfig = {
  ...clerkAlert,
  messageTag: "sentry_only",
  logAggregator: { canonical: false, backstop: false },
};

describe("parseFormat", () => {
  it("defaults to 'both' when no flag is given", () => {
    expect(parseFormat([])).toBe("both");
  });
  it.each(["datadog", "loki", "both"] as const)(
    "accepts --format=%s",
    (fmt) => {
      expect(parseFormat([`--format=${fmt}`])).toBe(fmt);
    },
  );
  it("rejects unknown formats with an actionable message", () => {
    expect(() => parseFormat(["--format=splunk"])).toThrowError(
      /unknown.*splunk/,
    );
  });
});

describe("render", () => {
  it("emits the no-op comment when no log-agg-routed alerts are declared", () => {
    const out = render("both", [sentryOnly], "https://r/", "api-server");
    expect(out).toContain("No log-aggregator-routed alerts");
  });

  it("datadog format includes the message tag, runbook anchor, priority, and managed tag", () => {
    const out = render("datadog", [dsnAlert], "https://r/", "api-server");
    expect(out).toContain("Datadog Terraform monitors");
    expect(out).toContain("sentry_dsn_missing_for_production");
    expect(out).toContain("https://r/#sentry_dsn");
    // sev-2 -> P2
    expect(out).toContain("priority = 2");
    expect(out).toContain("managed:productionSecretAlerts.config.ts");
    expect(out).toContain("source:api-server");
    // Routing-note for the DSN canonical case is rendered.
    expect(out).toContain("canonical");
    expect(out).toContain("Sentry can't tell you Sentry is off");
  });

  it("datadog priority maps sev-1 to P1", () => {
    const out = render("datadog", [clerkAlert], "https://r/", "api-server");
    expect(out).toContain("priority = 1");
  });

  it("loki format produces an alert rule with the right severity label and tag-scoped name", () => {
    const out = render("loki", [clerkAlert], "https://r/", "api-server");
    expect(out).toContain("Loki / Alertmanager rules");
    expect(out).toContain(
      "alert: ProductionSecret_clerk_secret_key_missing_for_production",
    );
    expect(out).toContain("severity: critical"); // sev-1 -> critical
    expect(out).toContain('{source="api-server"} |= "clerk_secret_key_missing_for_production"');
    expect(out).toContain("https://r/#clerk_secret_key");
  });

  it("loki maps sev-2 to high", () => {
    const out = render("loki", [dsnAlert], "https://r/", "api-server");
    expect(out).toContain("severity: high");
  });

  it("'both' contains both blocks", () => {
    const out = render(
      "both",
      [dsnAlert, clerkAlert],
      "https://r/",
      "api-server",
    );
    expect(out).toContain("Datadog Terraform monitors");
    expect(out).toContain("Loki / Alertmanager rules");
    expect(out).toContain("sentry_dsn_missing_for_production");
    expect(out).toContain("clerk_secret_key_missing_for_production");
  });

  it("filters out alerts that opt the log aggregator out entirely", () => {
    const out = render(
      "both",
      [sentryOnly, dsnAlert],
      "https://r/",
      "api-server",
    );
    expect(out).not.toContain("sentry_only");
    expect(out).toContain("sentry_dsn_missing_for_production");
  });

  it("uses the real config to render every declared log-agg alert", () => {
    const out = render(
      "both",
      PRODUCTION_SECRET_ALERTS,
      "https://example/runbook.md",
      "api-server",
    );
    for (const a of PRODUCTION_SECRET_ALERTS) {
      if (a.logAggregator.canonical || a.logAggregator.backstop) {
        expect(out).toContain(a.messageTag);
      }
    }
  });
});

describe("main", () => {
  it("returns 0 and writes rendered output to stdout", () => {
    const stdout: string[] = [];
    const code = main({
      argv: ["--format=loki"],
      env: { RUNBOOK_URL: "https://r/", LOG_SOURCE: "api-server" },
      alerts: [dsnAlert],
      stdout: (l) => stdout.push(l),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(stdout.join("\n")).toContain("Loki / Alertmanager");
  });

  it("returns 1 with an actionable error on an unknown --format", () => {
    const stderr: string[] = [];
    const code = main({
      argv: ["--format=splunk"],
      stdout: () => {},
      stderr: (l) => stderr.push(l),
    });
    expect(code).toBe(1);
    expect(stderr.join("\n")).toMatch(/unknown.*splunk/);
  });

  it("falls back to defaults when env is empty", () => {
    const stdout: string[] = [];
    const code = main({
      argv: [],
      env: {},
      alerts: [dsnAlert],
      stdout: (l) => stdout.push(l),
      stderr: () => {},
    });
    expect(code).toBe(0);
    // Default RUNBOOK_URL is a relative path inside the repo, default
    // LOG_SOURCE is "api-server".
    const out = stdout.join("\n");
    expect(out).toContain("docs/runbooks/production-secrets.md#sentry_dsn");
    expect(out).toContain("source:api-server");
  });
});
