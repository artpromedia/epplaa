import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PRODUCTION_SECRET_ALERTS,
  selectSentryAlerts,
  selectLogAggregatorAlerts,
  sentryRuleNameFor,
  type ProductionSecretAlertConfig,
} from "./productionSecretAlerts.config.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

describe("PRODUCTION_SECRET_ALERTS", () => {
  it("declares the three in-scope tags from task #96 — and only those", () => {
    const tags = PRODUCTION_SECRET_ALERTS.map((a) => a.messageTag).sort();
    expect(tags).toEqual([
      "clerk_secret_key_missing_for_production",
      "sentry_dsn_missing_for_production",
      "session_secret_missing_for_production",
    ]);
  });

  it("each entry has a non-empty summary, severity, runbook anchor and emittedBy", () => {
    for (const alert of PRODUCTION_SECRET_ALERTS) {
      expect(alert.summary, alert.messageTag).not.toBe("");
      expect(["sev-1", "sev-2"]).toContain(alert.severity);
      expect(alert.runbookAnchor.startsWith("#")).toBe(true);
      expect(alert.emittedBy).toMatch(/^services\/api-monolith\//);
    }
  });

  it("every messageTag literal is actually emitted by the named source file", () => {
    // Catches the rename-without-updating-the-config failure mode at
    // PR time rather than at the next missed page. Reads the source
    // file and asserts it contains the literal tag string.
    for (const alert of PRODUCTION_SECRET_ALERTS) {
      const absolute = path.join(REPO_ROOT, alert.emittedBy);
      const source = readFileSync(absolute, "utf8");
      expect(
        source.includes(alert.messageTag),
        `${alert.emittedBy} does not contain literal "${alert.messageTag}" — config drift?`,
      ).toBe(true);
    }
  });

  it("SENTRY_DSN check is log-aggregator-canonical (Sentry can't tell you Sentry is off)", () => {
    const dsn = PRODUCTION_SECRET_ALERTS.find(
      (a) => a.messageTag === "sentry_dsn_missing_for_production",
    );
    expect(dsn).toBeDefined();
    expect(dsn!.logAggregator.canonical).toBe(true);
    expect(dsn!.sentry.canonical).toBe(false);
    // Sentry-side rule is still present as a backstop so a deploy
    // that restores the DSN still surfaces "you were flying blind".
    expect(dsn!.sentry.backstop).toBe(true);
  });

  it("CLERK_SECRET_KEY check is sev-1, Sentry-canonical, log-agg backstop", () => {
    const clerk = PRODUCTION_SECRET_ALERTS.find(
      (a) => a.messageTag === "clerk_secret_key_missing_for_production",
    );
    expect(clerk).toBeDefined();
    expect(clerk!.severity).toBe("sev-1");
    expect(clerk!.sentry.canonical).toBe(true);
    expect(clerk!.logAggregator.backstop).toBe(true);
  });

  it("SESSION_SECRET check is sev-1, Sentry-canonical, log-agg backstop", () => {
    const session = PRODUCTION_SECRET_ALERTS.find(
      (a) => a.messageTag === "session_secret_missing_for_production",
    );
    expect(session).toBeDefined();
    expect(session!.severity).toBe("sev-1");
    expect(session!.sentry.canonical).toBe(true);
    expect(session!.logAggregator.backstop).toBe(true);
  });

  it("every alert opts at least one tool in (otherwise nobody is paged)", () => {
    for (const alert of PRODUCTION_SECRET_ALERTS) {
      const anyRouted =
        alert.sentry.canonical ||
        alert.sentry.backstop ||
        alert.logAggregator.canonical ||
        alert.logAggregator.backstop;
      expect(anyRouted, `${alert.messageTag} routes nowhere`).toBe(true);
    }
  });
});

describe("selectSentryAlerts", () => {
  it("returns every alert that opts Sentry in (canonical or backstop)", () => {
    const out = selectSentryAlerts(PRODUCTION_SECRET_ALERTS);
    // All three currently opt Sentry in — DSN as backstop, the
    // others as canonical.
    expect(out.map((a) => a.messageTag).sort()).toEqual([
      "clerk_secret_key_missing_for_production",
      "sentry_dsn_missing_for_production",
      "session_secret_missing_for_production",
    ]);
  });

  it("skips entries that opt Sentry out entirely", () => {
    const fixture: ProductionSecretAlertConfig = {
      messageTag: "log_only",
      summary: "x",
      severity: "sev-2",
      runbookAnchor: "#x",
      sentry: { canonical: false, backstop: false },
      logAggregator: { canonical: true, backstop: false },
      emittedBy: "services/api-monolith/src/lib/sentry.ts",
    };
    expect(selectSentryAlerts([fixture])).toEqual([]);
  });
});

describe("selectLogAggregatorAlerts", () => {
  it("returns every alert that opts the log aggregator in", () => {
    const out = selectLogAggregatorAlerts(PRODUCTION_SECRET_ALERTS);
    // All three opt the log agg in — DSN as canonical, the others as
    // backstop.
    expect(out.map((a) => a.messageTag).sort()).toEqual([
      "clerk_secret_key_missing_for_production",
      "sentry_dsn_missing_for_production",
      "session_secret_missing_for_production",
    ]);
  });

  it("skips entries that opt the log aggregator out entirely", () => {
    const fixture: ProductionSecretAlertConfig = {
      messageTag: "sentry_only",
      summary: "x",
      severity: "sev-2",
      runbookAnchor: "#x",
      sentry: { canonical: true, backstop: false },
      logAggregator: { canonical: false, backstop: false },
      emittedBy: "services/api-monolith/src/lib/sentry.ts",
    };
    expect(selectLogAggregatorAlerts([fixture])).toEqual([]);
  });
});

describe("sentryRuleNameFor", () => {
  it("produces a stable, tag-scoped, [managed:...] prefixed name", () => {
    const sample = PRODUCTION_SECRET_ALERTS[0]!;
    const name = sentryRuleNameFor(sample);
    expect(name.startsWith(`[managed:${sample.messageTag}]`)).toBe(true);
    // Calling twice returns the exact same string — pure function.
    expect(sentryRuleNameFor(sample)).toBe(name);
  });

  it("yields distinct names for distinct tags", () => {
    const names = PRODUCTION_SECRET_ALERTS.map(sentryRuleNameFor);
    expect(new Set(names).size).toBe(names.length);
  });
});
