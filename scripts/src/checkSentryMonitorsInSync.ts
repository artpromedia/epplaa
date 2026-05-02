/**
 * CI drift check (task #77 + bidirectional reverse scan, task #110).
 *
 * Two complementary directions, both run by `main()` and both able to
 * fail the build:
 *
 *   1. Declared-but-wrong (task #77). For every entry in
 *      `sentryMonitors.config.ts`'s `SENTRY_MONITORS`, read the
 *      referenced workflow YAML and assert its `cron:` value matches
 *      the declared `schedule`. Catches "I changed the workflow cron
 *      and forgot to update the monitor config (or vice versa)".
 *
 *   2. Used-but-undeclared (task #110). Walk every
 *      `.github/workflows/*.yml`, find every `sentry-cli monitors run
 *      <slug>` invocation, and assert each slug is declared in either
 *      `SENTRY_MONITORS` or `SENTRY_MONITORS_KNOWN_UI_MANAGED`.
 *      Catches "I added a new scheduled workflow with a Sentry
 *      heartbeat but forgot to register the monitor", which would
 *      otherwise ship a workflow without on-call coverage for the
 *      "scheduler stopped running" failure mode.
 *
 * Exits 0 when both directions are clean, non-zero (with one line per
 * offender on stderr) when anything has drifted.
 *
 * Wired into `.github/workflows/ci.yml` so PRs that change a cron or
 * add a heartbeat without registering its monitor can't merge.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run check-sentry-monitors
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SENTRY_MONITORS,
  SENTRY_MONITORS_KNOWN_UI_MANAGED,
  diffMonitorAgainstWorkflow,
  extractMonitorSlugsFromWorkflowYaml,
  hasAutomaticTrigger,
  type SentryMonitorConfig,
  type SentryMonitorUiManagedEntry,
} from "./sentryMonitors.config.js";

// scripts/src/<file>.ts -> repo root is two levels up. Computed via
// import.meta.url because the package is ESM and `__dirname` isn't
// defined in that scope.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

const WORKFLOWS_DIR_REL = path.join(".github", "workflows");

interface CheckResult {
  monitor: SentryMonitorConfig;
  driftReason: string | null;
  /** Set when the workflow file referenced by the monitor is missing
   *  from disk — surfaced as its own message because "the workflow
   *  YAML is gone" is a different remediation than "the cron drifted". */
  fileMissing?: boolean;
}

interface ReverseScanFinding {
  /** Slug found in a workflow YAML that isn't declared in the config. */
  slug: string;
  /** The workflow file the slug was used in (relative to repo root). */
  workflowFile: string;
  /** Human-readable reason, surfaced verbatim by the CI step. */
  reason: string;
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

/**
 * Scan every workflow file for `sentry-cli monitors run <slug>`
 * invocations and report any slug that isn't in `knownSlugs`.
 *
 * Pure function (modulo the injected `readWorkflow`) so the test
 * suite can drive it with inline YAML strings — no I/O is hard-coded
 * here.
 *
 * Behaviour notes:
 *   - Files that don't exist are silently skipped. They can only
 *     show up in this list via `discoverWorkflows`, which already
 *     filters by extension; a race-deletion between discovery and
 *     read should not fail the check.
 *   - Each `(workflowFile, slug)` pair is reported at most once even
 *     if the same slug appears multiple times in the same file
 *     (e.g. duplicate echo strings); CI noise from a single
 *     unregistered slug should be one line, not N.
 *   - Different workflows referencing the same unregistered slug
 *     are reported separately so the offender's workflow file is
 *     always named in the message.
 */
export function runReverseScan(
  workflowFiles: readonly string[],
  knownSlugs: ReadonlySet<string>,
  readWorkflow: (workflowFile: string) => { exists: boolean; source: string },
): ReverseScanFinding[] {
  const findings: ReverseScanFinding[] = [];
  for (const wf of workflowFiles) {
    const file = readWorkflow(wf);
    if (!file.exists) continue;
    const slugsInFile = extractMonitorSlugsFromWorkflowYaml(file.source);
    const seenInThisFile = new Set<string>();
    for (const slug of slugsInFile) {
      if (knownSlugs.has(slug)) continue;
      if (seenInThisFile.has(slug)) continue;
      seenInThisFile.add(slug);
      findings.push({
        slug,
        workflowFile: wf,
        reason:
          `workflow ${wf} invokes \`sentry-cli monitors run ${slug}\` ` +
          `but slug "${slug}" is not declared in scripts/src/sentryMonitors.config.ts ` +
          `(neither SENTRY_MONITORS nor SENTRY_MONITORS_KNOWN_UI_MANAGED). ` +
          `Add a full SENTRY_MONITORS entry to manage the schedule + check-in margin ` +
          `+ max runtime from this repo (preferred — see check-healthz-degraded for the shape), ` +
          `or, if the monitor is configured in the Sentry UI for now, add a ` +
          `SENTRY_MONITORS_KNOWN_UI_MANAGED entry with a \`note\` documenting why. ` +
          `Skipping registration would let this workflow ship without on-call coverage ` +
          `for the "scheduler stopped running" failure mode.`,
      });
    }
  }
  return findings;
}

/**
 * Check 3 (task #225): For every workflow that invokes `sentry-cli monitors
 * run <slug>` (whether the slug is in SENTRY_MONITORS or
 * SENTRY_MONITORS_KNOWN_UI_MANAGED), assert the workflow has at least one
 * `schedule:` cron block. A heartbeat workflow without a `schedule:` only
 * runs on `workflow_dispatch` and will never send automatic check-ins to
 * Sentry, making the cron monitor permanently miss-fire.
 */
export function runHeartbeatScheduleCheck(
  workflowFiles: readonly string[],
  knownSlugs: ReadonlySet<string>,
  readWorkflow: (workflowFile: string) => { exists: boolean; source: string },
): Array<{ workflowFile: string; slug: string; reason: string }> {
  const findings: Array<{ workflowFile: string; slug: string; reason: string }> = [];
  for (const wf of workflowFiles) {
    const file = readWorkflow(wf);
    if (!file.exists) continue;
    const slugsInFile = extractMonitorSlugsFromWorkflowYaml(file.source);
    if (slugsInFile.length === 0) continue;
    // Only check workflows that have declared heartbeats
    const knownSlugCount = slugsInFile.filter(s => knownSlugs.has(s)).length;
    if (knownSlugCount === 0) continue; // handled by reverse scan (undeclared)
    // Accept any automatic trigger — `schedule:` cron OR `push:` events
    // (e.g. release.yml's `push: tags: "v*"`). A workflow with only
    // `workflow_dispatch:` would be the broken case this check is for.
    if (hasAutomaticTrigger(file.source)) continue;
    const uniqueSlugs = [...new Set(slugsInFile.filter(s => knownSlugs.has(s)))];
    for (const slug of uniqueSlugs) {
      findings.push({
        workflowFile: wf,
        slug,
        reason:
          `workflow ${wf} invokes \`sentry-cli monitors run ${slug}\` ` +
          `but has no automatic trigger (\`schedule:\` cron or \`push:\` event). ` +
          `Without one the Sentry Cron monitor will never receive an automatic ` +
          `check-in and will permanently fire "missed_check_in" pages. Either add ` +
          `a \`schedule:\` block / \`push:\` trigger to the workflow or remove the ` +
          `heartbeat invocation.`,
      });
    }
  }
  return findings;
}

function readWorkflowFromDisk(
  workflowFile: string,
): { exists: boolean; source: string } {
  const absolute = path.join(REPO_ROOT, workflowFile);
  if (!existsSync(absolute)) return { exists: false, source: "" };
  return { exists: true, source: readFileSync(absolute, "utf8") };
}

function discoverWorkflowsFromDisk(): string[] {
  const absolute = path.join(REPO_ROOT, WORKFLOWS_DIR_REL);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()
    .map((f) => path.join(WORKFLOWS_DIR_REL, f));
}

export function buildKnownSlugSet(
  monitors: readonly SentryMonitorConfig[],
  uiManaged: readonly SentryMonitorUiManagedEntry[],
): Set<string> {
  return new Set<string>([
    ...monitors.map((m) => m.slug),
    ...uiManaged.map((m) => m.slug),
  ]);
}

export function main(
  deps: {
    monitors?: readonly SentryMonitorConfig[];
    uiManaged?: readonly SentryMonitorUiManagedEntry[];
    readWorkflow?: (workflowFile: string) => {
      exists: boolean;
      source: string;
    };
    discoverWorkflows?: () => readonly string[];
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
  } = {},
): 0 | 1 {
  const monitors = deps.monitors ?? SENTRY_MONITORS;
  const uiManaged = deps.uiManaged ?? SENTRY_MONITORS_KNOWN_UI_MANAGED;
  const readWorkflow = deps.readWorkflow ?? readWorkflowFromDisk;
  const discoverWorkflows = deps.discoverWorkflows ?? discoverWorkflowsFromDisk;
  const stdout =
    deps.stdout ?? ((line: string) => process.stdout.write(line + "\n"));
  const stderr =
    deps.stderr ?? ((line: string) => process.stderr.write(line + "\n"));

  const results = runChecks(monitors, readWorkflow);
  const drifted = results.filter((r) => r.driftReason !== null);

  const workflowFiles = discoverWorkflows();
  const knownSlugs = buildKnownSlugSet(monitors, uiManaged);
  const reverseFindings = runReverseScan(
    workflowFiles,
    knownSlugs,
    readWorkflow,
  );
  const heartbeatFindings = runHeartbeatScheduleCheck(workflowFiles, knownSlugs, readWorkflow);

  if (drifted.length === 0 && reverseFindings.length === 0 && heartbeatFindings.length === 0) {
    stdout(
      `[checkSentryMonitorsInSync] ${monitors.length} monitor(s) in sync with workflow YAML.`,
    );
    for (const r of results) {
      stdout(
        `  - ${r.monitor.slug} <- ${r.monitor.workflowFile} (cron "${r.monitor.schedule}")`,
      );
    }
    if (uiManaged.length > 0) {
      stdout(
        `[checkSentryMonitorsInSync] ${uiManaged.length} UI-managed slug(s) ` +
          `recognised by the reverse scan (declared in SENTRY_MONITORS_KNOWN_UI_MANAGED ` +
          `but not pushed by sync-sentry-monitors):`,
      );
      for (const e of uiManaged) {
        stdout(`  - ${e.slug} <- ${e.workflowFile}`);
      }
    }
    stdout(
      `[checkSentryMonitorsInSync] reverse scan checked ${workflowFiles.length} ` +
        `workflow file(s); no undeclared slugs found.`,
    );
    return 0;
  }

  if (drifted.length > 0) {
    stderr("[checkSentryMonitorsInSync] DRIFT DETECTED:");
    for (const r of drifted) {
      stderr(`  - ${r.driftReason}`);
    }
    stderr(
      "Fix: edit either the workflow YAML's `cron:` value or the monitor's `schedule` in scripts/src/sentryMonitors.config.ts so they match, then re-run this check.",
    );
  }
  if (reverseFindings.length > 0) {
    stderr("[checkSentryMonitorsInSync] UNDECLARED SLUGS DETECTED:");
    for (const f of reverseFindings) {
      stderr(`  - ${f.reason}`);
    }
    stderr(
      "Fix: register each slug listed above in scripts/src/sentryMonitors.config.ts " +
        "(SENTRY_MONITORS for full management, or SENTRY_MONITORS_KNOWN_UI_MANAGED if " +
        "the monitor is intentionally configured in the Sentry UI for now), then " +
        "re-run this check.",
    );
  }
  if (heartbeatFindings.length > 0) {
    stderr("[checkSentryMonitorsInSync] MISSING SCHEDULE BLOCKS DETECTED:");
    for (const f of heartbeatFindings) {
      stderr(`  - ${f.reason}`);
    }
    stderr(
      "Fix: add a `schedule:` cron block to each workflow listed above so the " +
        "Sentry Cron monitor receives automatic check-ins, or remove the " +
        "`sentry-cli monitors run` invocation if the workflow is not meant to " +
        "run on a schedule.",
    );
  }
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
