/**
 * CI guard for the release-time Sentry monitor sync (task #109).
 *
 * Fails the build when this repo declares "Sentry Cron monitors are
 * managed in code" — i.e. `scripts/src/sentryMonitors.config.ts`
 * exports a non-empty `SENTRY_MONITORS` array — but the GitHub
 * vars/secrets the release workflow needs to actually push those
 * monitors to Sentry are missing.
 *
 * Why this script exists
 * ----------------------
 * The release pipeline has two layers of guards that are individually
 * correct but combine into a silent failure:
 *
 *   1. `.github/workflows/release.yml` gates the
 *      `sentry-monitors-sync` job on `vars.SENTRY_ORG != ''`.
 *      → If `SENTRY_ORG` is missing the job is *skipped*, not failed.
 *
 *   2. `scripts/src/syncSentryMonitors.ts` exits non-zero if
 *      `SENTRY_AUTH_TOKEN` or `SENTRY_ORG` is missing at runtime.
 *      → That guard only fires when the job is actually scheduled,
 *        which (per #1) it isn't when `SENTRY_ORG` is missing.
 *
 * Together: if the repo is misconfigured (secret rotated and not
 * re-added, env var typo, repo forked without copying secrets) the
 * sync silently never runs and the next monitor schedule change
 * silently doesn't propagate to Sentry. On-call only finds out the
 * next time a missed-check-in alert *should have fired* — and didn't.
 *
 * This script closes that gap by failing the *PR* build when the
 * declared intent ("we manage these monitors in code") is not backed
 * by the credentials needed to fulfil that intent.
 *
 * Same pattern as the healthz-probe workflow's `HEALTHZ_PROBE_ENABLED`
 * opt-in: presence is the signal. The opt-in here is "the
 * `SENTRY_MONITORS` array has at least one entry"; an empty array
 * means "we don't manage monitors in code, nothing to sync, no
 * credentials required" and the check no-ops cleanly so a fork that
 * legitimately wants to disable monitor management can do so by
 * deleting the entries (the same gesture that makes the release-time
 * sync job a no-op).
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run check-sentry-sync-credentials
 *
 * Env vars (forwarded by `.github/workflows/ci.yml`):
 *   SENTRY_AUTH_TOKEN  required when SENTRY_MONITORS is non-empty.
 *                      Mapped from `secrets.SENTRY_AUTH_TOKEN`.
 *   SENTRY_ORG         required when SENTRY_MONITORS is non-empty.
 *                      Mapped from `vars.SENTRY_ORG`.
 *
 * Exit codes:
 *   0  no monitors declared (sync correctly disabled), OR monitors
 *      declared and every required credential is non-empty.
 *   1  monitors declared but one or more required credentials missing.
 *      stderr lists the exact `vars.*` / `secrets.*` names that need
 *      to be added in GitHub → Settings → Secrets and variables →
 *      Actions, so on-call can fix it without leaving the PR.
 */
import {
  SENTRY_MONITORS,
  type SentryMonitorConfig,
} from "./sentryMonitors.config.js";

export interface CredentialCheckResult {
  ok: boolean;
  /**
   * GitHub `vars.*` / `secrets.*` identifiers that are declared
   * required by `SENTRY_MONITORS` but absent from the environment.
   * Empty when `ok` is true.
   */
  missing: string[];
  /**
   * Slugs of every monitor that triggered the requirement, included
   * in the failure message so the operator sees *why* the credentials
   * are needed (i.e. these are the monitors that won't sync without
   * them).
   */
  declaredMonitorSlugs: string[];
}

/**
 * Pure check — no I/O, no `process.exit`. The CLI wrapper formats the
 * output; this function is what the unit tests exercise.
 *
 * Treats whitespace-only values as missing because GitHub passes the
 * literal empty string when a referenced secret/var is unset, but a
 * stray space (e.g. `vars.SENTRY_ORG = " "`) would produce a value
 * that is technically present but useless to the Sentry API. Same
 * `trim() === ""` guard the sync script itself uses for parity.
 */
export function checkCredentials(
  monitors: readonly SentryMonitorConfig[],
  env: { SENTRY_AUTH_TOKEN?: string; SENTRY_ORG?: string },
): CredentialCheckResult {
  const declaredMonitorSlugs = monitors.map((m) => m.slug);
  if (monitors.length === 0) {
    return { ok: true, missing: [], declaredMonitorSlugs };
  }
  const missing: string[] = [];
  if (env.SENTRY_ORG === undefined || env.SENTRY_ORG.trim() === "") {
    missing.push("vars.SENTRY_ORG");
  }
  if (
    env.SENTRY_AUTH_TOKEN === undefined ||
    env.SENTRY_AUTH_TOKEN.trim() === ""
  ) {
    missing.push("secrets.SENTRY_AUTH_TOKEN");
  }
  return { ok: missing.length === 0, missing, declaredMonitorSlugs };
}

export function main(
  deps: {
    env?: NodeJS.ProcessEnv;
    monitors?: readonly SentryMonitorConfig[];
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
  } = {},
): 0 | 1 {
  const env = deps.env ?? process.env;
  const monitors = deps.monitors ?? SENTRY_MONITORS;
  const stdout =
    deps.stdout ?? ((line: string) => process.stdout.write(line + "\n"));
  const stderr =
    deps.stderr ?? ((line: string) => process.stderr.write(line + "\n"));

  const result = checkCredentials(monitors, {
    SENTRY_AUTH_TOKEN: env.SENTRY_AUTH_TOKEN,
    SENTRY_ORG: env.SENTRY_ORG,
  });

  if (monitors.length === 0) {
    stdout(
      "[checkSentrySyncCredentials] SENTRY_MONITORS is empty; release-time sync is intentionally disabled. Nothing to check.",
    );
    return 0;
  }

  if (result.ok) {
    stdout(
      `[checkSentrySyncCredentials] OK — ${monitors.length} monitor(s) declared (${result.declaredMonitorSlugs.join(", ")}); SENTRY_ORG and SENTRY_AUTH_TOKEN are present so the release-time sync job will actually run.`,
    );
    return 0;
  }

  stderr(
    "[checkSentrySyncCredentials] MISCONFIGURED: this repo declares Sentry Cron monitors in scripts/src/sentryMonitors.config.ts but the credentials needed to push them to Sentry are missing.",
  );
  stderr(
    `  Declared monitors that won't sync: ${result.declaredMonitorSlugs.join(", ")}`,
  );
  stderr("  Missing GitHub configuration:");
  for (const id of result.missing) {
    stderr(`    - ${id}`);
  }
  stderr(
    "  Fix one of:",
  );
  stderr(
    "    a) GitHub → Settings → Secrets and variables → Actions: add the missing entries above so the release workflow's `sentry-monitors-sync` job can authenticate against Sentry's Monitors API.",
  );
  stderr(
    "    b) If you do NOT want this repo to manage Sentry monitors in code (e.g. on a fork that doesn't run its own Sentry project), delete the entries from scripts/src/sentryMonitors.config.ts. An empty SENTRY_MONITORS array is the correct way to opt out — the release-time sync job will then no-op cleanly.",
  );
  stderr(
    "  Why this matters: the release workflow's `sentry-monitors-sync` job is gated on `vars.SENTRY_ORG != ''` and is skipped (not failed) when missing. Without this CI check, a misconfigured repo would silently stop syncing monitors and on-call would only notice the next time a missed-check-in alert *should* have fired — and didn't.",
  );
  return 1;
}

const isDirectInvocation =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /checkSentrySyncCredentials(\.[mc]?[jt]s)?$/.test(process.argv[1]);

if (isDirectInvocation) {
  process.exit(main());
}
