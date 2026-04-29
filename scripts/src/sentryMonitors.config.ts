/**
 * Source-of-truth for the Sentry Cron monitors that page on-call when
 * one of our scheduled GitHub Actions workflows stops running.
 *
 * Why this file exists (task #77):
 *
 * Scheduled workflows wrap their main step in
 * `sentry-cli monitors run <slug> -- ...` and rely on a Sentry Cron
 * monitor with that slug to page when the expected check-in fails to
 * arrive on time, e.g.:
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
 *   1. scripts/src/syncSentryMonitors.ts — pushes the SENTRY_MONITORS
 *      configs to Sentry's monitor API at release time so the
 *      Sentry-side state is regenerated from this file rather than
 *      maintained by hand. (UI-managed slugs in
 *      SENTRY_MONITORS_KNOWN_UI_MANAGED are NOT pushed — they are
 *      inventory-only entries for monitors that still live in the
 *      Sentry UI pending migration.)
 *
 *   2. scripts/src/checkSentryMonitorsInSync.ts — runs in CI and
 *      enforces drift in BOTH directions:
 *        - declared-but-wrong: every SENTRY_MONITORS entry's
 *          `schedule` must equal the cron in its workflow YAML.
 *        - used-but-undeclared: every `sentry-cli monitors run <slug>`
 *          invocation across `.github/workflows/*.yml` must reference
 *          a slug declared in either SENTRY_MONITORS or
 *          SENTRY_MONITORS_KNOWN_UI_MANAGED. So adding a new
 *          scheduled workflow with a heartbeat without registering
 *          its slug fails CI before the workflow can ship without
 *          on-call coverage (task #110).
 *
 * To change a schedule:
 *   - Edit the cron in the workflow YAML AND the matching `schedule`
 *     in this file in the SAME PR. CI will fail if you only change one.
 *   - Re-run the release workflow (or trigger `pnpm --filter
 *     @workspace/scripts run sync-sentry-monitors` manually) to
 *     propagate the change to Sentry.
 *
 * To add a new scheduled workflow with a Sentry heartbeat:
 *   - Either add a full SENTRY_MONITORS entry (preferred — manages
 *     the schedule + margins from this repo end-to-end), OR
 *   - Add a SENTRY_MONITORS_KNOWN_UI_MANAGED inventory entry naming
 *     the slug + workflow + a `note` explaining why it's still in
 *     the Sentry UI. CI will fail with a clear "undeclared slug"
 *     message if you skip both.
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
    slug: "backup-verify-nightly",
    name: "Backup verify (nightly smoke)",
    workflowFile: ".github/workflows/backup-verify-nightly.yml",
    schedule: "0 3 * * 1-6",
    scheduleType: "crontab",
    timezone: "UTC",
    // Same rationale as `backup-verify` below — runner queue time on
    // weekend backlogs, ~30s install/boot, plus `apt-get install
    // postgresql-client`. The nightly cadence runs Mon-Sat; a missed
    // night should page within hours rather than waiting for the next
    // on-call shift change. Runbook: docs/runbooks/backup-verify.md
    // (Monitor: `backup-verify-nightly`).
    checkinMarginMinutes: 60,
    // The workflow's `timeout-minutes: 30` is the hard ceiling; 45
    // min gives Sentry slack so a healthy long-running smoke restore
    // (large dump, slow runner) doesn't trip a false `error`
    // check-in.
    maxRuntimeMinutes: 45,
    failureIssueThreshold: 1,
    recoveryThreshold: 1,
    environment: "production",
    runbookSection:
      "docs/runbooks/backup-verify.md (Monitor: `backup-verify-nightly`)",
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
 * Inventory entry for a Sentry Cron monitor whose configuration still
 * lives in the Sentry UI rather than in this file. Exists so the
 * "used-but-undeclared" check (task #110) has a way to acknowledge
 * pre-existing UI-managed slugs without forcing a same-PR migration
 * to fully-managed `SENTRY_MONITORS` configs (which would require
 * importing the existing UI-side margin / max-runtime values, and
 * any divergence would be silently overwritten on the next
 * release-time `sync-sentry-monitors` run).
 *
 * Adding a new entry here is a deliberate signal in PR review that
 * the slug is intentionally NOT yet managed from this repo, and
 * should be migrated when the UI-side values can be verified against
 * the runbook.
 */
export interface SentryMonitorUiManagedEntry {
  /** Sentry monitor slug used by the workflow's
   *  `sentry-cli monitors run <slug>` invocation. */
  slug: string;
  /** Workflow YAML this monitor heartbeats for, relative to the repo
   *  root. Lets the inventory double as documentation of which
   *  workflow each UI-managed slug pages for. */
  workflowFile: string;
  /** Why this monitor is here rather than in `SENTRY_MONITORS` —
   *  surfaced in PR review when someone adds a new entry. Typically
   *  references the runbook that documents the UI-side values and a
   *  follow-up task or rationale for the migration. */
  note: string;
}

/**
 * Slugs whose Sentry monitors are configured by hand in the Sentry UI
 * (not pushed by `syncSentryMonitors.ts`) but which the
 * "used-but-undeclared" CI check still needs to recognise as
 * registered. Each entry records the workflow it pages for and a
 * `note` explaining why it's not a full `SENTRY_MONITORS` config yet.
 *
 * Migration target: every entry here should eventually move to
 * `SENTRY_MONITORS` once its check-in margin + max runtime are
 * verified against the runbook (so the next sync run doesn't
 * overwrite a hand-tuned value). The list should shrink, not grow.
 */
export const SENTRY_MONITORS_KNOWN_UI_MANAGED: readonly SentryMonitorUiManagedEntry[] = [
  {
    slug: "check-production-hostname-pattern",
    workflowFile: ".github/workflows/check-production-hostname-pattern.yml",
    note:
      "Per-15-minute post-deploy hostname-pattern probe (task #89). " +
      "Currently configured in the Sentry UI; will be retired once " +
      "`check-readyz-config` is confirmed paging on every misconfiguration " +
      "this workflow caught (the generalised probe is a strict superset — " +
      "see docs/runbooks/staging-only-endpoints.md, *Post-deploy verifier: " +
      "full readyz config block*). No migration to SENTRY_MONITORS planned " +
      "because the workflow itself is on the retirement path.",
  },
  {
    slug: "check-readyz-config",
    workflowFile: ".github/workflows/check-readyz-config.yml",
    note:
      "Per-15-minute post-deploy /readyz config probe (task #101). " +
      "Currently configured in the Sentry UI; migrate to SENTRY_MONITORS " +
      "once the runbook (docs/runbooks/staging-only-endpoints.md) " +
      "documents the check-in margin + max-runtime so the next sync " +
      "doesn't silently overwrite the UI-tuned values.",
  },
  {
    slug: "check-rate-limit-opt-out-sunsets",
    workflowFile: ".github/workflows/check-rate-limit-opt-out-sunsets.yml",
    note:
      "Daily 13:00 UTC opt-out-sunset check. Currently configured in the " +
      "Sentry UI; migrate to SENTRY_MONITORS once the runbook " +
      "(docs/runbooks/rate-limit-store-opt-outs.md) documents the " +
      "check-in margin + max-runtime so the next sync doesn't silently " +
      "overwrite the UI-tuned values.",
  },
  {
    slug: "probe-rehearsal-notify-webhook",
    workflowFile: ".github/workflows/probe-rehearsal-notify-webhook.yml",
    note:
      "Daily 16:23 UTC liveness probe for the rehearsal-notify webhook. " +
      "Currently configured in the Sentry UI; migrate to SENTRY_MONITORS " +
      "once the runbook (docs/runbooks/rate-limit-store.md, *Daily " +
      "rehearsal-notify-webhook liveness probe*) documents the check-in " +
      "margin + max-runtime so the next sync doesn't silently overwrite " +
      "the UI-tuned values.",
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

/**
 * Find every Sentry Cron monitor slug that a workflow YAML invokes via
 * `sentry-cli monitors run <slug> -- ...`.
 *
 * Used by the "used-but-undeclared" CI check (task #110): scanning
 * each `.github/workflows/*.yml` for these slugs and asserting each
 * one is declared in `SENTRY_MONITORS` or
 * `SENTRY_MONITORS_KNOWN_UI_MANAGED` catches a brand-new scheduled
 * workflow that wires up a heartbeat but forgets to register the
 * slug — which would otherwise ship without on-call coverage.
 *
 * Implementation notes:
 *
 *   - YAML comment lines (`^\s*#…`) are stripped first so a
 *     header-block sentence like
 *         "# The verify step is wrapped with `sentry-cli monitors run backup-verify ...`"
 *     does not register as a real heartbeat invocation.
 *
 *   - Bash line-continuations (`\` at end of line) are joined onto a
 *     single logical line, because the canonical invocation in this
 *     repo is split across four lines for readability:
 *         sentry-cli monitors run \
 *           --environment production \
 *           <slug> \
 *           -- "$RUNNER_TEMP/probe.sh"
 *
 *   - Flags are skipped: any `--flag value` or `--flag=value` (and
 *     short `-f value`) tokens between `run` and the slug are
 *     consumed before the first positional argument is treated as
 *     the slug. The bash arg separator `--` (alone) terminates the
 *     match so it can't be mistaken for a flag.
 *
 *   - Dynamic slug references like `${slug}` (which appear inside
 *     echo strings in helper / rehearsal workflows that explain the
 *     pattern but don't actually invoke it for a single fixed slug)
 *     are filtered out — Sentry slugs are kebab-case
 *     `[a-z0-9][a-z0-9-_]*`, so anything containing `$`, `{`, `}`,
 *     uppercase, or other non-slug characters is not a real slug.
 *
 * Returns the slugs in source order so callers can include them
 * verbatim in error messages. Duplicates are preserved — the caller
 * decides whether to dedupe per-file or globally.
 */
export function extractMonitorSlugsFromWorkflowYaml(
  yamlSource: string,
): string[] {
  const stripped = yamlSource
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  const joined = stripped.replace(/\\\s*\n\s*/g, " ");
  const out: string[] = [];
  // Match `sentry-cli monitors run <args>` up to the bash arg
  // separator `--` (with surrounding whitespace) or the end of the
  // logical line, whichever comes first.
  const re = /sentry-cli\s+monitors\s+run\s+([^\n]*?)(?=\s+--(?:\s|$)|\s*$)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(joined)) !== null) {
    const slug = pickSlugFromArgString(m[1] ?? "");
    if (slug !== null && isPlausibleSentrySlug(slug)) {
      out.push(slug);
    }
  }
  return out;
}

/**
 * Walk the args after `sentry-cli monitors run` and return the first
 * positional (non-flag) token, which is the monitor slug. Skips
 * `--flag value`, `--flag=value`, and `-f value` patterns.
 *
 * Returns null when no positional token is found — defensive: a
 * malformed invocation should be surfaced as "no slug" upstream
 * rather than silently swallowed.
 */
function pickSlugFromArgString(argString: string): string | null {
  const tokens = argString.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t.startsWith("--")) {
      // `--flag=value` is one token; `--flag value` is two.
      i += t.includes("=") ? 1 : 2;
      continue;
    }
    if (t.startsWith("-")) {
      // Short flag taking a separate value (e.g. `-e production`).
      // Conservatively consume the value too.
      i += 2;
      continue;
    }
    return t;
  }
  return null;
}

/**
 * True iff the candidate string looks like a real Sentry monitor
 * slug. Sentry slugs are kebab-case `[a-z0-9][a-z0-9-_]*`. We use
 * this to filter out shell-variable expansions (`${slug}`),
 * GitHub-Actions expressions (`${{ ... }}`), and other dynamic
 * references that appear inside echo strings in helper workflows.
 */
function isPlausibleSentrySlug(candidate: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/.test(candidate);
}
