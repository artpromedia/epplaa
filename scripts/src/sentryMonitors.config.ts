/**
 * Source-of-truth for the Sentry Cron monitors that page on-call when
 * one of our scheduled GitHub Actions workflows stops running.
 *
 * Why this file exists (task #77):
 *
 * Two scheduled workflows wrap their main step in
 * `sentry-cli monitors run <slug> -- ...` and rely on a Sentry Cron
 * monitor with that slug to page when the expected check-in fails to
 * arrive on time:
 *
 *   .github/workflows/check-healthz-degraded.yml -> slug check-healthz-degraded
 *   .github/workflows/backup-verify.yml          -> slug backup-verify
 *
 * Until this file was introduced, the monitor schedule, check-in
 * margin, max runtime and environment lived ONLY in the runbooks
 * (docs/runbooks/rate-limit-store.md and docs/runbooks/backup-verify.md)
 * and the actual values were typed by hand into the Sentry UI. If
 * someone changed the cron in the workflow YAML without remembering
 * to mirror the change in Sentry — or vice versa — the monitor would
 * either start firing false `missed_check_in` pages or silently stop
 * firing real ones.
 *
 * This module is the single source-of-truth. Two things consume it:
 *
 *   1. scripts/src/syncSentryMonitors.ts — pushes these configs to
 *      Sentry's monitor API at release time so the Sentry-side state
 *      is regenerated from this file rather than maintained by hand.
 *
 *   2. scripts/src/checkSentryMonitorsInSync.ts — runs in CI and
 *      compares each declared `schedule` to the cron value in the
 *      workflow YAML it heartbeats for. Fails the build if they
 *      disagree, which catches the "I changed the workflow cron and
 *      forgot to update the monitor config" failure mode at PR time
 *      rather than at the next missed-check-in page.
 *
 * To change a schedule:
 *   - Edit the cron in the workflow YAML AND the matching `schedule`
 *     in this file in the SAME PR. CI will fail if you only change one.
 *   - Re-run the release workflow (or trigger `pnpm --filter
 *     @workspace/scripts run sync-sentry-monitors` manually) to
 *     propagate the change to Sentry.
 */

export interface SentryMonitorConfig {
  /** Sentry monitor slug. Must match the slug in the workflow's
   *  `sentry-cli monitors run <slug>` invocation. */
  slug: string;
  /** Human-readable name shown in the Sentry UI. */
  name: string;
  /** Workflow YAML this monitor heartbeats for, relative to the repo
   *  root. The drift check parses this file's `on.schedule` block and
   *  asserts the cron there matches `schedule` below. */
  workflowFile: string;
  /** Crontab expression. Must equal the workflow's `cron:` value. */
  schedule: string;
  /** Always "crontab" for our workflows (GH Actions schedules use
   *  crontab syntax). Kept explicit so the Sentry API call doesn't
   *  silently default to interval and reinterpret the schedule. */
  scheduleType: "crontab";
  /** Timezone the schedule is evaluated in. GH Actions schedules run
   *  in UTC, so this is "UTC" for both monitors. */
  timezone: string;
  /** Minutes Sentry will wait past the expected tick before declaring
   *  a check-in missed. Sized per-workflow based on observed runner
   *  queue + boot time. See runbook tables for the rationale. */
  checkinMarginMinutes: number;
  /** Minutes Sentry will wait for an `ok`/`error` after `in_progress`
   *  before declaring the run hung. Should be greater than the
   *  workflow's `timeout-minutes:` so a healthy long run doesn't trip
   *  a false `error` check-in. */
  maxRuntimeMinutes: number;
  /** How many consecutive failures before Sentry opens an issue. We
   *  use 1 for both — there is no "noisy" failure mode for "the
   *  scheduled job stopped running." */
  failureIssueThreshold: number;
  /** How many consecutive successes before Sentry auto-resolves the
   *  issue. We use 1 for both — once the scheduler is back, we don't
   *  need to keep the page open. */
  recoveryThreshold: number;
  /** Always "production" for our monitors — the `sentry-cli monitors
   *  run` invocation in each workflow always passes
   *  `--environment production`. */
  environment: string;
  /** Pointer to the runbook section that documents this monitor.
   *  Forwarded into the Sentry monitor name / description so on-call
   *  knows where to start when paged. */
  runbookSection: string;
}

/**
 * The monitors. Keep this list in lockstep with the workflow files
 * named in each entry's `workflowFile`. CI's drift check
 * (`checkSentryMonitorsInSync.ts`) enforces the cron equality; the
 * other fields (margin, max runtime, environment) are propagated to
 * Sentry by `syncSentryMonitors.ts` at release time.
 */
export const SENTRY_MONITORS: readonly SentryMonitorConfig[] = [
  {
    slug: "check-healthz-degraded",
    name: "Healthz degraded probe (per-minute)",
    workflowFile: ".github/workflows/check-healthz-degraded.yml",
    schedule: "*/5 * * * *",
    scheduleType: "crontab",
    timezone: "UTC",
    // Generous enough to absorb runner queue time + the workflow's
    // own ~30s install/boot. Tighten only if you're prepared to chase
    // noise from cold-start runners.
    checkinMarginMinutes: 5,
    // The probe loop's `timeout-minutes: 8` gives this slack; anything
    // longer means the runner hung mid-loop.
    maxRuntimeMinutes: 10,
    failureIssueThreshold: 1,
    recoveryThreshold: 1,
    environment: "production",
    runbookSection:
      "docs/runbooks/rate-limit-store.md (Step 5, Heartbeat — paging when the scheduler itself stops running)",
  },
  {
    slug: "backup-verify",
    name: "Backup verify (weekly)",
    workflowFile: ".github/workflows/backup-verify.yml",
    schedule: "0 3 * * 0",
    scheduleType: "crontab",
    timezone: "UTC",
    // Generous enough to absorb runner queue time during weekend
    // backlogs, the workflow's ~30s install/boot, and `apt-get
    // install postgresql-client`. The job itself is allowed up to 30
    // minutes (`timeout-minutes: 30`), but the check-in margin only
    // governs *when the `in_progress` arrives*, so 60 min is
    // comfortable without being so loose that a missed run goes
    // uncaught past the next on-call shift change.
    checkinMarginMinutes: 60,
    // The workflow's `timeout-minutes: 30` is the hard ceiling; 45
    // min gives Sentry slack so a healthy long-running restore (large
    // dump, slow runner) doesn't trip a false `error` check-in.
    maxRuntimeMinutes: 45,
    failureIssueThreshold: 1,
    recoveryThreshold: 1,
    environment: "production",
    runbookSection: "docs/runbooks/backup-verify.md (Sentry Cron monitor configuration)",
  },
] as const;

/**
 * Extract every `cron:` value from a workflow YAML's `on.schedule`
 * block.
 *
 * Implemented as a small regex rather than a full YAML parser to keep
 * `@workspace/scripts` dependency-free for this check. Both target
 * workflows have a flat shape:
 *
 *     on:
 *       schedule:
 *         - cron: "<expr>"
 *       workflow_dispatch: {}
 *
 * The regex tolerates single quotes, double quotes, no quotes, and a
 * trailing inline `# comment`. We deliberately do NOT scope the search
 * to the `on:` block — `cron:` only appears inside `schedule:` in
 * these files, and false positives would still need a `cron:` key,
 * which would itself be a configuration mistake worth surfacing.
 *
 * Returns the list in source order so the caller can include the line
 * verbatim in error messages.
 */
export function extractCronEntriesFromWorkflowYaml(
  yamlSource: string,
): string[] {
  const out: string[] = [];
  // Match lines like:    - cron: "*/5 * * * *"   # optional comment
  // Capture group 1 is the cron expression (without surrounding quotes).
  const re = /^\s+-\s+cron:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+(?:\s+[^\s#]+){0,5}?))\s*(?:#.*)?$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(yamlSource)) !== null) {
    const value = m[1] ?? m[2] ?? m[3];
    if (value !== undefined) out.push(value.trim());
  }
  return out;
}

/**
 * Compare a declared monitor against the workflow YAML it heartbeats
 * for. Pure function — no I/O — so the test suite can drive it with
 * inline YAML strings.
 *
 * Returns null on success, or a human-readable string describing the
 * drift. The CI drift-check binary surfaces these strings verbatim,
 * so they're written to be actionable on first read.
 */
export function diffMonitorAgainstWorkflow(
  monitor: SentryMonitorConfig,
  workflowYamlSource: string,
): string | null {
  const crons = extractCronEntriesFromWorkflowYaml(workflowYamlSource);
  if (crons.length === 0) {
    return (
      `monitor "${monitor.slug}" declares schedule "${monitor.schedule}" ` +
      `but workflow ${monitor.workflowFile} has no \`schedule:\` cron. ` +
      `Either restore the cron in the workflow or remove the monitor entry from sentryMonitors.config.ts.`
    );
  }
  if (crons.length > 1) {
    return (
      `monitor "${monitor.slug}" can only heartbeat a single cron schedule, ` +
      `but workflow ${monitor.workflowFile} declares ${crons.length}: ` +
      `[${crons.map((c) => JSON.stringify(c)).join(", ")}]. ` +
      `Split the workflow or model the additional schedules as separate monitor entries.`
    );
  }
  const observed = crons[0]!;
  if (observed !== monitor.schedule) {
    return (
      `monitor "${monitor.slug}" schedule drift: ` +
      `sentryMonitors.config.ts declares "${monitor.schedule}" but ` +
      `${monitor.workflowFile} has cron "${observed}". ` +
      `Update both in the same PR — Sentry will start paging on missed check-ins ` +
      `(or stop paging on real ones) until they match.`
    );
  }
  return null;
}
