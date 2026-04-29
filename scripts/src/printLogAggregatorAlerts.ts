/**
 * Renderer for log-aggregator alerts on the production-secret
 * presence checks (task #96).
 *
 * The actual log aggregator (Datadog Logs / Loki+Alertmanager /
 * CloudWatch Logs Insights) has not yet been centrally provisioned in
 * this repo. Until it is, this script emits ready-to-paste config in
 * each major dialect from the source-of-truth in
 * `productionSecretAlerts.config.ts` so an operator can apply it
 * by hand and the rendered config is reviewable in PRs the same way
 * the Sentry monitor sync output is.
 *
 * Sibling of `syncSentryIssueAlerts.ts`. The Sentry script PUSHES
 * config; this script PRINTS config. The split is deliberate:
 *
 *   - Sentry has one well-known API and the org has standardised on
 *     it (existing monitor sync uses it), so the release pipeline can
 *     push idempotently without operator approval.
 *
 *   - The log aggregator is not yet picked. Pushing requires choosing
 *     the dialect AND the credential channel (Datadog API key vs
 *     Loki + Alertmanager YAML in a separate repo, …). Picking either
 *     would foreclose the other; emitting both lets an operator pick
 *     when the org commits.
 *
 * Once a log aggregator is chosen, swap this printer for a sibling
 * `syncLogAggregatorAlerts.ts` that pushes via the chosen dialect's
 * API. The runbook ("Alert wiring") and the per-tag entries in
 * `productionSecretAlerts.config.ts` won't need to change.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run print-log-aggregator-alerts
 *   pnpm --filter @workspace/scripts run print-log-aggregator-alerts -- --format=datadog
 *   pnpm --filter @workspace/scripts run print-log-aggregator-alerts -- --format=loki
 *
 * Env vars:
 *   RUNBOOK_URL  optional. Public URL of the production-secrets
 *                runbook used to render the deep link inside each
 *                alert's body. Defaults to the relative repo path so
 *                the rule still tells operators where to look.
 *   LOG_SOURCE   optional. The `source:` value the log shipper tags
 *                api-server logs with. Defaults to "api-server" for
 *                the Datadog rendering. Adjust if your shipper uses a
 *                different convention.
 *
 * Exit codes:
 *   0  always (printer never fails — bad input shows as empty output).
 */
import {
  PRODUCTION_SECRET_ALERTS,
  selectLogAggregatorAlerts,
  type ProductionSecretAlertConfig,
} from "./productionSecretAlerts.config.js";

export type RenderFormat = "datadog" | "loki" | "both";

/**
 * Map our internal severity to Datadog Monitor priority
 * (1 = highest, 5 = lowest). `sev-1` -> P1, `sev-2` -> P2 mirrors the
 * common operator mental model.
 */
function datadogPriorityFor(severity: ProductionSecretAlertConfig["severity"]): number {
  return severity === "sev-1" ? 1 : 2;
}

/**
 * Map our internal severity to a Loki/Alertmanager-friendly label
 * value (`critical` for sev-1, `high` for sev-2). The actual routing
 * is then a `route` config in Alertmanager keyed off `severity:`.
 */
function lokiSeverityLabel(severity: ProductionSecretAlertConfig["severity"]): string {
  return severity === "sev-1" ? "critical" : "high";
}

function renderRoutingNote(alert: ProductionSecretAlertConfig): string {
  const role = alert.logAggregator.canonical ? "canonical" : "backstop";
  if (alert.logAggregator.canonical && alert.sentry.canonical) {
    // Defensive: shouldn't happen with the current config, but the
    // renderer should describe the data it sees rather than assume.
    return "canonical (also canonical in Sentry — both pipes page)";
  }
  if (role === "canonical") {
    return "canonical (Sentry-side rule is a backstop only — Sentry can't tell you Sentry is off)";
  }
  return "backstop (canonical alert lives in Sentry — this fires if Sentry is also down)";
}

export function renderDatadog(
  alerts: readonly ProductionSecretAlertConfig[],
  runbookUrl: string,
  logSource: string,
): string {
  const blocks = alerts.map((alert) => {
    const priority = datadogPriorityFor(alert.severity);
    const note = renderRoutingNote(alert);
    // Datadog Terraform monitor block. The `query` filter:
    //   logs("source:<src> message:<tag>").index("*").rollup("count").last("15m") > 0
    // pages on a single matching log line in the last 15 minutes.
    // Window choice: 15 min is conservative for the SENTRY_DSN
    // canonical case (the boot warn fires once per replica boot;
    // multiple replicas booting together inside the window dedup
    // correctly because Datadog's monitor evaluation is on the rolled-
    // up count, not per-line); 15 min is also enough slack for a
    // staggered deploy to be fully on the new image before the
    // operator manually marks the alert resolved.
    return `# ${alert.messageTag} — ${note}
# Severity: ${alert.severity} (Datadog priority P${priority})
# Runbook: ${runbookUrl}${alert.runbookAnchor}
resource "datadog_monitor" "production_secret_${alert.messageTag}" {
  name    = "[managed:${alert.messageTag}] ${alert.summary}"
  type    = "log alert"
  message = <<-EOT
    ${alert.summary}

    The api-server emitted \`${alert.messageTag}\` on a production-shaped boot. Page on-call.

    Runbook: ${runbookUrl}${alert.runbookAnchor}

    @opsgenie-api-server-oncall
  EOT
  query   = "logs(\\"source:${logSource} message:\\\\\\"${alert.messageTag}\\\\\\"\\").index(\\"*\\").rollup(\\"count\\").last(\\"15m\\") > 0"
  monitor_thresholds {
    critical = 0
  }
  priority = ${priority}
  tags = [
    "team:api-server",
    "severity:${alert.severity}",
    "managed:productionSecretAlerts.config.ts",
  ]
  notify_no_data    = false
  renotify_interval = 0
}`;
  });
  return blocks.join("\n\n");
}

export function renderLoki(
  alerts: readonly ProductionSecretAlertConfig[],
  runbookUrl: string,
  logSource: string,
): string {
  // LogQL alerting rule format consumed by Loki Ruler / Alertmanager.
  // Same `for: 0m` / `count_over_time(...) > 0` shape as the Datadog
  // monitor — the alert fires on the first matching log line.
  const groups = alerts.map((alert) => {
    const sevLabel = lokiSeverityLabel(alert.severity);
    const note = renderRoutingNote(alert);
    const lokiQuery = `count_over_time({source="${logSource}"} |= "${alert.messageTag}" [15m])`;
    return `  # ${alert.messageTag} — ${note}
  # Runbook: ${runbookUrl}${alert.runbookAnchor}
  - alert: ProductionSecret_${alert.messageTag}
    expr: ${lokiQuery} > 0
    for: 0m
    labels:
      severity: ${sevLabel}
      team: api-server
      managed_by: productionSecretAlerts.config.ts
      message_tag: ${alert.messageTag}
    annotations:
      summary: "${alert.summary}"
      description: |
        The api-server emitted \`${alert.messageTag}\` on a production-shaped boot.
        Page on-call. See ${runbookUrl}${alert.runbookAnchor} for remediation.`;
  });
  return `groups:
- name: production-secret-presence
  interval: 1m
  rules:
${groups.join("\n")}`;
}

export function render(
  format: RenderFormat,
  alerts: readonly ProductionSecretAlertConfig[],
  runbookUrl: string,
  logSource: string,
): string {
  const filtered = selectLogAggregatorAlerts(alerts);
  if (filtered.length === 0) {
    return "# No log-aggregator-routed alerts declared in productionSecretAlerts.config.ts.\n";
  }
  switch (format) {
    case "datadog":
      return `# ===== Datadog Terraform monitors =====\n# Source-of-truth: scripts/src/productionSecretAlerts.config.ts\n\n${renderDatadog(filtered, runbookUrl, logSource)}\n`;
    case "loki":
      return `# ===== Loki / Alertmanager rules =====\n# Source-of-truth: scripts/src/productionSecretAlerts.config.ts\n\n${renderLoki(filtered, runbookUrl, logSource)}\n`;
    case "both":
      return (
        `# ===== Datadog Terraform monitors =====\n# Source-of-truth: scripts/src/productionSecretAlerts.config.ts\n\n${renderDatadog(filtered, runbookUrl, logSource)}\n\n` +
        `# ===== Loki / Alertmanager rules =====\n# Source-of-truth: scripts/src/productionSecretAlerts.config.ts\n\n${renderLoki(filtered, runbookUrl, logSource)}\n`
      );
  }
}

export function parseFormat(argv: readonly string[]): RenderFormat {
  for (const a of argv) {
    const m = /^--format=(.+)$/.exec(a);
    if (m && m[1] !== undefined) {
      const v = m[1].toLowerCase();
      if (v === "datadog" || v === "loki" || v === "both") return v;
      throw new Error(
        `unknown --format value "${m[1]}"; expected one of: datadog, loki, both`,
      );
    }
  }
  return "both";
}

export function main(
  deps: {
    argv?: readonly string[];
    env?: NodeJS.ProcessEnv;
    alerts?: readonly ProductionSecretAlertConfig[];
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
  } = {},
): 0 | 1 {
  const argv = deps.argv ?? process.argv.slice(2);
  const env = deps.env ?? process.env;
  const alerts = deps.alerts ?? PRODUCTION_SECRET_ALERTS;
  const stdout =
    deps.stdout ?? ((line: string) => process.stdout.write(line + "\n"));
  const stderr =
    deps.stderr ?? ((line: string) => process.stderr.write(line + "\n"));

  let format: RenderFormat;
  try {
    format = parseFormat(argv);
  } catch (err) {
    stderr(`[printLogAggregatorAlerts] ${(err as Error).message}`);
    return 1;
  }
  const runbookUrl = env.RUNBOOK_URL ?? "docs/runbooks/production-secrets.md";
  const logSource = env.LOG_SOURCE ?? "api-server";
  stdout(render(format, alerts, runbookUrl, logSource));
  return 0;
}

const isDirectInvocation =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /printLogAggregatorAlerts(\.[mc]?[jt]s)?$/.test(process.argv[1]);

if (isDirectInvocation) {
  process.exit(main());
}
