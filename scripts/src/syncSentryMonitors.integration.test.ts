/**
 * Opt-in integration test for `syncSentryMonitors.ts` (task #111).
 *
 * The 25 unit tests in `syncSentryMonitors.test.ts` cover the request
 * shape, retry behaviour, dry-run output, and env-var validation by
 * stubbing `global.fetch`. They DO NOT exercise the real Sentry
 * Monitors API contract — so a Sentry-side schema change (renamed
 * field, stricter validation, auth scope tightening) would slip past
 * CI and only surface as a 4xx during the next release sync.
 *
 * This file fills that gap by round-tripping a throwaway monitor
 * against a real (sandbox/staging) Sentry org:
 *
 *   1. Build a `SentryMonitorConfig` with a unique, time-stamped slug
 *      so concurrent runs / leftover test rows can never collide.
 *   2. Run the script's `main()` against the real Sentry API to PUT
 *      the monitor.
 *   3. GET the monitor back and assert every field we declared made
 *      the round-trip unchanged (name, slug, type, schedule,
 *      schedule_type, timezone, checkin_margin, max_runtime,
 *      failure_issue_threshold, recovery_threshold).
 *   4. DELETE the monitor in `finally`, even when the assertions fail,
 *      so we don't leak test rows into the org over time.
 *
 * The whole `describe` block is gated on `SENTRY_INTEGRATION=1` AND a
 * dedicated test token (`SENTRY_INTEGRATION_AUTH_TOKEN`), so it cannot
 * run from a normal `pnpm test` invocation by accident — both
 * conditions must be true. The dedicated token is intentionally
 * separate from the production `SENTRY_AUTH_TOKEN` so the integration
 * surface can be limited to a sandbox project that only contains
 * throwaway monitors, and so the production token is never exposed to
 * the test runner. The expected pre-merge / pre-release wiring is the
 * `Sentry monitor sync — integration` GitHub workflow, run on
 * workflow_dispatch only — see the runbook entry referenced from
 * `docs/runbooks/backup-verify.md` (section "End-to-end integration
 * test against a real Sentry org").
 *
 * Required env when SENTRY_INTEGRATION=1:
 *   SENTRY_INTEGRATION_AUTH_TOKEN  required. Internal-integration
 *                                  token scoped to the SANDBOX org
 *                                  with `project:write` (needed for
 *                                  PUT) and `project:read` (needed
 *                                  for the round-trip GET) on the
 *                                  test project. Never reuse the
 *                                  production sync token.
 *   SENTRY_INTEGRATION_ORG         required. Sandbox/staging org slug.
 *   SENTRY_INTEGRATION_PROJECT     optional. Sandbox project slug.
 *                                  When set the monitor is bound to
 *                                  that project; when unset Sentry
 *                                  uses the org's default monitor
 *                                  project (matches production
 *                                  behaviour when SENTRY_PROJECT is
 *                                  unset).
 *   SENTRY_INTEGRATION_BASE_URL    optional. Defaults to
 *                                  https://sentry.io. Set this for
 *                                  self-hosted sandboxes.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
} from "vitest";
import { main } from "./syncSentryMonitors.js";
import type { SentryMonitorConfig } from "./sentryMonitors.config.js";

const enabled = process.env.SENTRY_INTEGRATION === "1";

/**
 * Sentry slug constraints (per the Monitors API): lowercase letters,
 * digits, underscores, hyphens; up to 50 chars. We use a fixed prefix
 * + epoch milliseconds + 8 hex chars of randomness so:
 *
 *   - `epplaa-sync-itest-` flags this row as test-owned in case the
 *     `finally` cleanup is killed mid-run (operator can sweep them on
 *     a search).
 *   - The timestamp + random suffix make collisions between concurrent
 *     CI runs effectively impossible without inflating slug length.
 */
function uniqueSlug(): string {
  const ts = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0");
  return `epplaa-sync-itest-${ts}-${rand}`;
}

interface FetchedMonitor {
  slug: string;
  name: string;
  type: string;
  config: {
    schedule_type: string;
    schedule: string;
    timezone: string;
    checkin_margin: number;
    max_runtime: number;
    failure_issue_threshold: number | null;
    recovery_threshold: number | null;
  };
}

async function getMonitor(
  baseUrl: string,
  org: string,
  token: string,
  slug: string,
): Promise<FetchedMonitor> {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/0/organizations/${encodeURIComponent(org)}/monitors/${encodeURIComponent(slug)}/`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET ${slug} failed: HTTP ${res.status}: ${body}`);
  }
  return (await res.json()) as FetchedMonitor;
}

async function deleteMonitor(
  baseUrl: string,
  org: string,
  token: string,
  slug: string,
): Promise<void> {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/0/organizations/${encodeURIComponent(org)}/monitors/${encodeURIComponent(slug)}/`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  // 202/204 are both observed in practice; treat anything 2xx as ok,
  // and 404 as "already gone" so the cleanup is idempotent if a
  // previous run partially cleaned up.
  if (!res.ok && res.status !== 404) {
    const body = await res.text();
    throw new Error(`DELETE ${slug} failed: HTTP ${res.status}: ${body}`);
  }
}

describe.skipIf(!enabled)(
  "syncSentryMonitors integration (real Sentry org)",
  () => {
    let token: string;
    let org: string;
    let projectSlug: string | undefined;
    let baseUrl: string;

    beforeAll(() => {
      const t = process.env.SENTRY_INTEGRATION_AUTH_TOKEN;
      const o = process.env.SENTRY_INTEGRATION_ORG;
      if (!t || t.trim() === "") {
        throw new Error(
          "SENTRY_INTEGRATION=1 requires SENTRY_INTEGRATION_AUTH_TOKEN " +
            "(use a sandbox token, NOT the production sync token).",
        );
      }
      if (!o || o.trim() === "") {
        throw new Error(
          "SENTRY_INTEGRATION=1 requires SENTRY_INTEGRATION_ORG " +
            "(sandbox/staging org slug).",
        );
      }
      token = t;
      org = o;
      const p = process.env.SENTRY_INTEGRATION_PROJECT;
      projectSlug = p && p.trim() !== "" ? p : undefined;
      baseUrl = process.env.SENTRY_INTEGRATION_BASE_URL ?? "https://sentry.io";
    });

    it(
      "round-trips a throwaway monitor through the real Monitors API",
      async () => {
        const slug = uniqueSlug();
        const monitor: SentryMonitorConfig = {
          slug,
          name: `Integration test ${slug}`,
          // workflowFile / runbookSection / environment are not part
          // of the Sentry payload (they're only consumed by the drift
          // check + runbooks), but the type requires them. The values
          // here are descriptive — we are NOT creating a workflow or
          // a runbook section, only a Sentry monitor.
          workflowFile: ".github/workflows/sentry-monitors-integration.yml",
          // Distinctive, easy to eyeball in the Sentry UI if cleanup
          // ever leaks. Cron is intentionally rare-firing so a leaked
          // monitor doesn't generate missed-check-in noise before
          // someone notices.
          schedule: "13 4 * * *",
          scheduleType: "crontab",
          timezone: "UTC",
          checkinMarginMinutes: 7,
          maxRuntimeMinutes: 11,
          failureIssueThreshold: 2,
          recoveryThreshold: 3,
          environment: "production",
          runbookSection:
            "docs/runbooks/backup-verify.md (End-to-end integration test against a real Sentry org)",
        };

        const env: NodeJS.ProcessEnv = {
          SENTRY_AUTH_TOKEN: token,
          SENTRY_ORG: org,
          ...(projectSlug ? { SENTRY_PROJECT: projectSlug } : {}),
          SENTRY_BASE_URL: baseUrl,
        };

        const stdout: string[] = [];
        const stderr: string[] = [];
        try {
          const code = await main({
            env,
            monitors: [monitor],
            stdout: (line) => stdout.push(line),
            stderr: (line) => stderr.push(line),
          });
          expect(
            code,
            `main() exited ${code}; stderr was:\n${stderr.join("\n")}`,
          ).toBe(0);

          // Round-trip the values we sent. We deliberately read them
          // back via a fresh GET (not by trusting the PUT response)
          // so a Sentry-side normalisation that silently mangles a
          // field — e.g. coercing the schedule, dropping the timezone,
          // clamping a margin — is caught here instead of in
          // production.
          const fetched = await getMonitor(baseUrl, org, token, slug);
          expect(fetched.slug).toBe(slug);
          expect(fetched.name).toBe(monitor.name);
          expect(fetched.type).toBe("cron_job");
          expect(fetched.config.schedule_type).toBe(monitor.scheduleType);
          expect(fetched.config.schedule).toBe(monitor.schedule);
          expect(fetched.config.timezone).toBe(monitor.timezone);
          expect(fetched.config.checkin_margin).toBe(
            monitor.checkinMarginMinutes,
          );
          expect(fetched.config.max_runtime).toBe(
            monitor.maxRuntimeMinutes,
          );
          expect(fetched.config.failure_issue_threshold).toBe(
            monitor.failureIssueThreshold,
          );
          expect(fetched.config.recovery_threshold).toBe(
            monitor.recoveryThreshold,
          );

          // Re-PUT with the same payload to prove the upsert is
          // genuinely idempotent against the real API (the unit
          // tests can only assert this against a stub). A second
          // run must still exit 0 and leave the values unchanged.
          const code2 = await main({
            env,
            monitors: [monitor],
            stdout: (line) => stdout.push(line),
            stderr: (line) => stderr.push(line),
          });
          expect(
            code2,
            `idempotent re-run exited ${code2}; stderr was:\n${stderr.join("\n")}`,
          ).toBe(0);
          const fetchedAgain = await getMonitor(baseUrl, org, token, slug);
          expect(fetchedAgain.config.schedule).toBe(monitor.schedule);
          expect(fetchedAgain.config.checkin_margin).toBe(
            monitor.checkinMarginMinutes,
          );
        } finally {
          // Always clean up — even if the assertions above failed —
          // so a broken test run doesn't leave the sandbox org full
          // of stale `epplaa-sync-itest-*` rows. Errors here are
          // surfaced as test failures so an operator notices when
          // cleanup itself is broken (e.g. token lost DELETE scope).
          await deleteMonitor(baseUrl, org, token, slug);
        }
      },
      // Sentry round-trip + idempotent re-run + DELETE can take a
      // few seconds under load; 60s gives comfortable slack without
      // letting a wedged request hang CI indefinitely.
      60_000,
    );
  },
);
