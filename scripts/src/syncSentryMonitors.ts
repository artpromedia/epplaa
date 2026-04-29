/**
 * Release-time sync of Sentry Cron monitors (task #77).
 *
 * For every entry in `sentryMonitors.config.ts`, idempotently upsert
 * the matching Sentry Cron monitor via Sentry's Monitors API so the
 * Sentry-side schedule + check-in margin + max runtime + environment
 * are regenerated from this repo rather than maintained by hand in the
 * Sentry UI.
 *
 * This is intentionally separate from the CI drift check
 * (`checkSentryMonitorsInSync.ts`):
 *
 *   - The drift check runs on every PR, has no auth requirements, and
 *     only inspects local files. It catches cron-vs-config drift at PR
 *     time so a bad change can't merge.
 *   - This sync runs at release time (or manually), needs a Sentry
 *     auth token, and is what actually pushes the new schedule into
 *     Sentry. Without it, a merged-but-unsynced change would still
 *     leave Sentry's monitor configured for the old schedule until an
 *     operator hand-edits the UI.
 *
 * Usage:
 *
 *   SENTRY_AUTH_TOKEN=... \
 *   SENTRY_ORG=... \
 *     pnpm --filter @workspace/scripts run sync-sentry-monitors
 *
 * Env vars:
 *
 *   SENTRY_AUTH_TOKEN  required. Internal-integration token with
 *                      `project:write` scope on the project that owns
 *                      the monitors.
 *   SENTRY_ORG         required. Org slug (e.g. "epplaa").
 *   SENTRY_PROJECT     optional. Project slug; when set, every
 *                      upserted monitor is associated with that
 *                      project so issues land in the same place as
 *                      runtime errors. When unset Sentry uses the
 *                      org's default monitor project.
 *   SENTRY_BASE_URL    optional. Defaults to https://sentry.io. Set
 *                      this for self-hosted Sentry installs.
 *   DRY_RUN            optional. When set to "1", the script logs the
 *                      payloads it WOULD send and exits 0 without
 *                      hitting Sentry — useful for verifying the
 *                      release wiring before granting the auth token.
 *
 * Exit codes:
 *   0  every monitor upserted (or successfully dry-run logged)
 *   1  config / auth misconfiguration (missing env, bad URL)
 *   2  one or more upserts failed — see stderr for the per-monitor
 *      Sentry response. The release should be considered partially
 *      synced; re-run after fixing the underlying cause (rotated
 *      token, renamed project, etc.).
 */
import {
  SENTRY_MONITORS,
  type SentryMonitorConfig,
} from "./sentryMonitors.config.js";

interface SentryMonitorPayload {
  name: string;
  slug: string;
  type: "cron_job";
  config: {
    schedule_type: "crontab";
    schedule: string;
    timezone: string;
    checkin_margin: number;
    max_runtime: number;
    failure_issue_threshold: number;
    recovery_threshold: number;
  };
  // `project` is optional — when omitted, Sentry uses the org's
  // default. We always pass it through when SENTRY_PROJECT is set so
  // the upserted monitor lands in the same project as runtime errors.
  project?: string;
}

export function buildPayload(
  monitor: SentryMonitorConfig,
  projectSlug: string | undefined,
): SentryMonitorPayload {
  const payload: SentryMonitorPayload = {
    name: monitor.name,
    slug: monitor.slug,
    type: "cron_job",
    config: {
      schedule_type: monitor.scheduleType,
      schedule: monitor.schedule,
      timezone: monitor.timezone,
      checkin_margin: monitor.checkinMarginMinutes,
      max_runtime: monitor.maxRuntimeMinutes,
      failure_issue_threshold: monitor.failureIssueThreshold,
      recovery_threshold: monitor.recoveryThreshold,
    },
  };
  if (projectSlug !== undefined && projectSlug !== "") {
    payload.project = projectSlug;
  }
  return payload;
}

interface UpsertResult {
  slug: string;
  ok: boolean;
  /** HTTP status of the Sentry response, when one was received. */
  status?: number;
  /** Set on failure — the response body or fetch error. */
  error?: string;
}

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; ok: boolean; text: () => Promise<string> }>;

/**
 * Idempotent upsert via PUT on the slug-scoped endpoint. Sentry's API
 * accepts PUT to /api/0/organizations/{org}/monitors/{slug}/ for both
 * create-if-missing and update-if-present, so a single call covers
 * both first-run and steady-state.
 *
 * The environment is propagated by the workflow's
 * `sentry-cli monitors run --environment production` invocation —
 * Sentry creates the environment lazily on first check-in. We don't
 * pre-create it here because the API surface is environment-scoped
 * (`/monitors/{slug}/environments/{env}/`) and our workflows are
 * single-environment, so the lazy creation is sufficient.
 */
export async function upsertMonitor(
  baseUrl: string,
  org: string,
  authToken: string,
  payload: SentryMonitorPayload,
  fetchImpl: FetchLike,
): Promise<UpsertResult> {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/0/organizations/${encodeURIComponent(org)}/monitors/${encodeURIComponent(payload.slug)}/`;
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return {
      slug: payload.slug,
      ok: false,
      error: `fetch failed: ${(err as Error).message}`,
    };
  }
  if (!res.ok) {
    let body = "";
    try {
      body = await res.text();
    } catch {
      body = "<failed to read response body>";
    }
    return {
      slug: payload.slug,
      ok: false,
      status: res.status,
      error: `HTTP ${res.status}: ${body}`,
    };
  }
  return { slug: payload.slug, ok: true, status: res.status };
}

export async function main(
  deps: {
    env?: NodeJS.ProcessEnv;
    monitors?: readonly SentryMonitorConfig[];
    fetchImpl?: FetchLike;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
  } = {},
): Promise<0 | 1 | 2> {
  const env = deps.env ?? process.env;
  const monitors = deps.monitors ?? SENTRY_MONITORS;
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as FetchLike);
  const stdout =
    deps.stdout ?? ((line: string) => process.stdout.write(line + "\n"));
  const stderr =
    deps.stderr ?? ((line: string) => process.stderr.write(line + "\n"));

  const dryRun = env.DRY_RUN === "1";
  const baseUrl = env.SENTRY_BASE_URL ?? "https://sentry.io";
  const org = env.SENTRY_ORG;
  const projectSlug = env.SENTRY_PROJECT;
  const authToken = env.SENTRY_AUTH_TOKEN;

  if (!org || org.trim() === "") {
    stderr("SENTRY_ORG is required");
    return 1;
  }
  if (!dryRun && (!authToken || authToken.trim() === "")) {
    stderr("SENTRY_AUTH_TOKEN is required (set DRY_RUN=1 to skip the API call)");
    return 1;
  }

  const failures: UpsertResult[] = [];
  for (const monitor of monitors) {
    const payload = buildPayload(monitor, projectSlug);
    if (dryRun) {
      stdout(
        `[syncSentryMonitors][dry-run] would PUT monitor "${monitor.slug}" -> ${baseUrl}/api/0/organizations/${org}/monitors/${monitor.slug}/`,
      );
      stdout(`  payload: ${JSON.stringify(payload)}`);
      continue;
    }
    stdout(
      `[syncSentryMonitors] upserting "${monitor.slug}" (${monitor.schedule}, ${monitor.environment}) ...`,
    );
    const result = await upsertMonitor(
      baseUrl,
      org,
      authToken!,
      payload,
      fetchImpl,
    );
    if (!result.ok) {
      stderr(
        `[syncSentryMonitors] FAILED ${monitor.slug}: ${result.error ?? "unknown error"}`,
      );
      failures.push(result);
    } else {
      stdout(`[syncSentryMonitors]   OK (HTTP ${result.status})`);
    }
  }

  if (failures.length > 0) {
    stderr(
      `[syncSentryMonitors] ${failures.length} of ${monitors.length} upserts failed; re-run after fixing the cause.`,
    );
    return 2;
  }
  if (dryRun) {
    stdout(
      `[syncSentryMonitors] dry-run complete; ${monitors.length} payload(s) logged.`,
    );
  } else {
    stdout(
      `[syncSentryMonitors] ${monitors.length} monitor(s) upserted into ${baseUrl} org=${org}.`,
    );
  }
  return 0;
}

const isDirectInvocation =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /syncSentryMonitors(\.[mc]?[jt]s)?$/.test(process.argv[1]);

if (isDirectInvocation) {
  void main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(
        `syncSentryMonitors crashed: ${(err as Error).message}\n`,
      );
      process.exit(1);
    },
  );
}
