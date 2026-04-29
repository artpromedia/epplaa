/**
 * CI drift check (task #77).
 *
 * For every entry in `sentryMonitors.config.ts`, read the referenced
 * workflow YAML and assert its `cron:` value matches the declared
 * `schedule`. Exits 0 when everything is in sync, non-zero (with one
 * line per offender on stderr) when anything has drifted.
 *
 * Wired into `.github/workflows/ci.yml` so a PR that changes a cron in
 * one place but not the other can't merge.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run check-sentry-monitors
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SENTRY_MONITORS,
  diffMonitorAgainstWorkflow,
  type SentryMonitorConfig,
} from "./sentryMonitors.config.js";

// scripts/src/<file>.ts -> repo root is two levels up. Computed via
// import.meta.url because the package is ESM and `__dirname` isn't
// defined in that scope.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

interface CheckResult {
  monitor: SentryMonitorConfig;
  driftReason: string | null;
  /** Set when the workflow file referenced by the monitor is missing
   *  from disk — surfaced as its own message because "the workflow
   *  YAML is gone" is a different remediation than "the cron drifted". */
  fileMissing?: boolean;
}

export function runChecks(
  monitors: readonly SentryMonitorConfig[],
  readWorkflow: (workflowFile: string) => { exists: boolean; source: string },
): CheckResult[] {
  return monitors.map((monitor) => {
    const file = readWorkflow(monitor.workflowFile);
    if (!file.exists) {
      return {
        monitor,
        fileMissing: true,
        driftReason:
          `monitor "${monitor.slug}" references ${monitor.workflowFile} but ` +
          `that file does not exist. Either restore the workflow or remove ` +
          `the monitor entry from sentryMonitors.config.ts.`,
      };
    }
    return {
      monitor,
      driftReason: diffMonitorAgainstWorkflow(monitor, file.source),
    };
  });
}

function readWorkflowFromDisk(
  workflowFile: string,
): { exists: boolean; source: string } {
  const absolute = path.join(REPO_ROOT, workflowFile);
  if (!existsSync(absolute)) return { exists: false, source: "" };
  return { exists: true, source: readFileSync(absolute, "utf8") };
}

export function main(
  deps: {
    monitors?: readonly SentryMonitorConfig[];
    readWorkflow?: (workflowFile: string) => {
      exists: boolean;
      source: string;
    };
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
  } = {},
): 0 | 1 {
  const monitors = deps.monitors ?? SENTRY_MONITORS;
  const readWorkflow = deps.readWorkflow ?? readWorkflowFromDisk;
  const stdout =
    deps.stdout ?? ((line: string) => process.stdout.write(line + "\n"));
  const stderr =
    deps.stderr ?? ((line: string) => process.stderr.write(line + "\n"));

  const results = runChecks(monitors, readWorkflow);
  const drifted = results.filter((r) => r.driftReason !== null);
  if (drifted.length === 0) {
    stdout(
      `[checkSentryMonitorsInSync] ${monitors.length} monitor(s) in sync with workflow YAML.`,
    );
    for (const r of results) {
      stdout(
        `  - ${r.monitor.slug} <- ${r.monitor.workflowFile} (cron "${r.monitor.schedule}")`,
      );
    }
    return 0;
  }
  stderr("[checkSentryMonitorsInSync] DRIFT DETECTED:");
  for (const r of drifted) {
    stderr(`  - ${r.driftReason}`);
  }
  stderr(
    "Fix: edit either the workflow YAML's `cron:` value or the monitor's `schedule` in scripts/src/sentryMonitors.config.ts so they match, then re-run this check.",
  );
  return 1;
}

const isDirectInvocation =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /checkSentryMonitorsInSync(\.[mc]?[jt]s)?$/.test(process.argv[1]);

if (isDirectInvocation) {
  process.exit(main());
}
