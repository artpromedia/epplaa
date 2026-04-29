/**
 * CI guard for the release-time Sentry issue-alert sync (task #96).
 *
 * Sibling of `checkSentrySyncCredentials.ts` (task #109): same pattern,
 * but for the production-secret issue alerts declared in
 * `productionSecretAlerts.config.ts`. Fails the build when the repo
 * declares "the issue alerts are managed in code" — i.e. one or more
 * entries opt Sentry in for canonical/backstop routing — but the
 * GitHub vars/secrets the release workflow needs to actually push
 * those alerts are missing.
 *
 * Why a separate gate from the monitor sync gate
 * ----------------------------------------------
 * The monitor gate (`checkSentrySyncCredentials.ts`) checks
 * SENTRY_AUTH_TOKEN + SENTRY_ORG. Issue alerts are project-scoped and
 * require a third var, SENTRY_PROJECT, that the monitor sync only
 * uses optionally. Splitting the checks lets a fork keep monitors
 * managed in code while opting out of issue-alert management (or
 * vice versa) by editing the relevant config array down to empty.
 *
 * Same opt-in-by-presence pattern as the rest of the repo's release
 * gates: an empty `selectSentryAlerts(PRODUCTION_SECRET_ALERTS)` array
 * means "we don't manage Sentry issue alerts in code, nothing to
 * sync, no credentials required" and the check no-ops cleanly so a
 * fork that legitimately disables this can do so by removing the
 * Sentry routing flags from each config entry.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run check-sentry-issue-alert-credentials
 *
 * Env vars (forwarded by `.github/workflows/ci.yml`):
 *   SENTRY_AUTH_TOKEN  required when any alert opts Sentry in.
 *   SENTRY_ORG         required when any alert opts Sentry in.
 *   SENTRY_PROJECT     required when any alert opts Sentry in
 *                      (issue rules are project-scoped).
 *
 * Exit codes:
 *   0  no Sentry-routed alerts declared (sync correctly disabled),
 *      OR alerts declared and every required credential is non-empty.
 *   1  alerts declared but one or more credentials missing.
 */
import {
  PRODUCTION_SECRET_ALERTS,
  selectSentryAlerts,
  type ProductionSecretAlertConfig,
} from "./productionSecretAlerts.config.js";

export interface CredentialCheckResult {
  ok: boolean;
  /** GitHub `vars.*` / `secrets.*` identifiers required by the
   *  declared Sentry-routed alerts but absent from the environment. */
  missing: string[];
  /** Tags of every alert that triggered the requirement, included in
   *  the failure message so the operator sees *why* the credentials
   *  are needed. */
  declaredAlertTags: string[];
}

export function checkCredentials(
  alerts: readonly ProductionSecretAlertConfig[],
  env: {
    SENTRY_AUTH_TOKEN?: string;
    SENTRY_ORG?: string;
    SENTRY_PROJECT?: string;
  },
): CredentialCheckResult {
  const sentryAlerts = selectSentryAlerts(alerts);
  const declaredAlertTags = sentryAlerts.map((a) => a.messageTag);
  if (sentryAlerts.length === 0) {
    return { ok: true, missing: [], declaredAlertTags };
  }
  const missing: string[] = [];
  if (env.SENTRY_ORG === undefined || env.SENTRY_ORG.trim() === "") {
    missing.push("vars.SENTRY_ORG");
  }
  if (env.SENTRY_PROJECT === undefined || env.SENTRY_PROJECT.trim() === "") {
    missing.push("vars.SENTRY_PROJECT");
  }
  if (
    env.SENTRY_AUTH_TOKEN === undefined ||
    env.SENTRY_AUTH_TOKEN.trim() === ""
  ) {
    missing.push("secrets.SENTRY_AUTH_TOKEN");
  }
  return { ok: missing.length === 0, missing, declaredAlertTags };
}

export function main(
  deps: {
    env?: NodeJS.ProcessEnv;
    alerts?: readonly ProductionSecretAlertConfig[];
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
  } = {},
): 0 | 1 {
  const env = deps.env ?? process.env;
  const alerts = deps.alerts ?? PRODUCTION_SECRET_ALERTS;
  const stdout =
    deps.stdout ?? ((line: string) => process.stdout.write(line + "\n"));
  const stderr =
    deps.stderr ?? ((line: string) => process.stderr.write(line + "\n"));

  const result = checkCredentials(alerts, {
    SENTRY_AUTH_TOKEN: env.SENTRY_AUTH_TOKEN,
    SENTRY_ORG: env.SENTRY_ORG,
    SENTRY_PROJECT: env.SENTRY_PROJECT,
  });

  if (result.declaredAlertTags.length === 0) {
    stdout(
      "[checkSentryIssueAlertSyncCredentials] no Sentry-routed alerts in productionSecretAlerts.config.ts; release-time sync is intentionally disabled. Nothing to check.",
    );
    return 0;
  }

  if (result.ok) {
    stdout(
      `[checkSentryIssueAlertSyncCredentials] OK — ${result.declaredAlertTags.length} alert(s) declared (${result.declaredAlertTags.join(", ")}); SENTRY_ORG, SENTRY_PROJECT and SENTRY_AUTH_TOKEN are present so the release-time sync job will actually run.`,
    );
    return 0;
  }

  stderr(
    "[checkSentryIssueAlertSyncCredentials] MISCONFIGURED: this repo declares Sentry-routed production-secret alerts in scripts/src/productionSecretAlerts.config.ts but the credentials needed to push them to Sentry are missing.",
  );
  stderr(
    `  Declared alerts that won't sync: ${result.declaredAlertTags.join(", ")}`,
  );
  stderr("  Missing GitHub configuration:");
  for (const id of result.missing) {
    stderr(`    - ${id}`);
  }
  stderr("  Fix one of:");
  stderr(
    "    a) GitHub → Settings → Secrets and variables → Actions: add the missing entries above so the release workflow's `sentry-issue-alerts-sync` job can authenticate against Sentry's project rules API.",
  );
  stderr(
    "    b) If you do NOT want this repo to manage Sentry issue alerts in code, set both `sentry.canonical` and `sentry.backstop` to false on every entry in scripts/src/productionSecretAlerts.config.ts. The release-time sync job will then no-op cleanly. (Note: at least one routing target — Sentry or log-aggregator — should remain enabled, otherwise nobody is paged.)",
  );
  stderr(
    "  Why this matters: the release workflow's `sentry-issue-alerts-sync` job is gated on `vars.SENTRY_ORG != ''` and is skipped (not failed) when missing. Without this CI check, a misconfigured repo would silently stop syncing alert rules and on-call would only notice the next time one of the boot-time secret presence checks fired — and didn't page.",
  );
  return 1;
}

const isDirectInvocation =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /checkSentryIssueAlertSyncCredentials(\.[mc]?[jt]s)?$/.test(process.argv[1]);

if (isDirectInvocation) {
  process.exit(main());
}
