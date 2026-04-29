# Runbook: Backup verify

The Postgres dump that protects us from corruption / accidental DELETE /
malicious wipe is only useful if it can actually be restored. The nightly
`pg_dump` itself is owned by the deployment platform / managed Postgres
provider (we cannot reach the production network from GitHub Actions),
but the **scheduled restore-from-dump tests** that prove the dumps are
restorable live in this repo on two cadences:

| Aspect | Nightly smoke | Weekly fuller |
| --- | --- | --- |
| Workflow | [`.github/workflows/backup-verify-nightly.yml`](../../.github/workflows/backup-verify-nightly.yml) | [`.github/workflows/backup-verify.yml`](../../.github/workflows/backup-verify.yml) |
| Verifier script | [`scripts/src/verifyBackup.ts`](../../scripts/src/verifyBackup.ts) `--mode=smoke` | same script `--mode=full` |
| Schedule | `0 3 * * 1-6` (Mon-Sat 03:00 UTC) — six per week | `0 3 * * 0` (Sunday 03:00 UTC) — once per week |
| Probe surface | `pg_restore` of the latest `*.dump` into a throwaway sandbox DB, followed by freshness check, row-count smoke against `audit_events` / `payment_intents` / `orders`, optional live-vs-restored row-count comparison (when `LIVE_COUNTS_URL` or `LIVE_COUNTS_MANIFEST` is set), week-over-week row-count drift check vs the prior verify run's persisted history, and required-extension presence check | smoke + anti-join FK integrity across `orders ↔ payment_intents ↔ users` + `VACUUM (ANALYZE)` (full heap scan, catches block-level corruption) + per-table inventory + best-effort `amcheck` btree validation + end-to-end audit-chain replay against `audit_events` |
| Sentry Cron slug | `backup-verify-nightly` | `backup-verify` |
| Pager channel | Sentry Cron monitor (heartbeat) + GitHub "Failed workflow run" mail (backstop) | same |

The two cadences run on different days so they never collide on the
shared `RESTORE_DATABASE_URL` sandbox; each has its own Sentry Cron
monitor so missed-check-in pages route distinctly. The nightly is the
primary safety net (catches a broken dump within ~24h instead of waiting
up to 7 days); the weekly fuller pass adds the deeper checks that smoke
mode skips for runtime reasons.

The verify pass exits non-zero and pages on:

| Code | Meaning | Mode | Page who |
| ---- | ------- | ---- | -------- |
| 1    | Generic verify error (the script's `fail()` default) | both | Whoever caught the page — escalate after triage |
| 2    | Missing `BACKUP_FETCH_CMD` or no `*.dump` files in `BACKUP_DIR` | both | Platform team (transport) |
| 3    | Missing `RESTORE_DATABASE_URL` — refused to restore for safety | both | Platform team (workflow config) |
| 4    | `pg_restore` exited non-zero (corrupt dump, schema drift, structurally broken file) | both | Platform team (transport / DB owner) |
| 5    | Smoke `psql` exited non-zero — restored DB is missing one of `audit_events` / `payment_intents` / `orders`, OR any of those tables has zero rows after restore (a structurally-valid but empty dump). | both | DB owner |
| 6    | Stale dump — newest `*.dump` in `BACKUP_DIR` is older than `MAX_DUMP_AGE_HOURS` (default 36h). Strong signal the nightly producer stalled and we restored last week's data. | both | Platform team (freshness) |
| 7    | FK integrity violation in the restored data (orphan `payment_intents.order_id`, dangling `orders.user_id` / `payment_intents.user_id`). The dump is internally inconsistent. | full only | Platform team + DB owner |
| 8    | Audit-chain hash chain failed to validate end-to-end on the restored data — either the dump was corrupted in transit OR a row was rewritten in place before the dump was taken. | full only | **Audit / compliance owners** (this is the only code that page-routes there) |
| 9    | A name in `REQUIRED_EXTENSIONS` (e.g. `pgcrypto`, `pg_trgm`) is missing on the restored sandbox. The data is technically present but the production app will not boot against it. | both | Platform team (sandbox config) |
| 10   | `VACUUM (ANALYZE)` exited non-zero (likely block-level corruption surfaced by a full heap scan that `pg_restore`'s `COPY` replay didn't notice). | full only | Platform team + DB owner |
| 11   | Per-table inventory psql exited non-zero (catalog query against `pg_stat_user_tables` failed). Rare; usually a wedged sandbox rather than a backup-quality issue. | full only | Platform team |
| 12   | `amcheck` `bt_index_check()` reported a corrupt btree index. **Note**: `amcheck` extension *missing* in the sandbox is downgraded to a `::warning::` and exit 0 — this code only fires when the extension is present and an index is actually broken. | full only | Platform team + DB owner |
| 13   | Unknown `--mode` value (operator typo / workflow misconfig). | both | Repo owner (workflow YAML) |
| 14   | Restored row counts are stale or incomplete vs the live source / manifest — the dump is restorable but its data lags production. **Distinct from exit 6** (which is "the dump *file* is older than `MAX_DUMP_AGE_HOURS`"): this code fires when the file mtime is fresh but its contents lag, which the file-mtime check cannot see. Names every offending table and the absolute / percentage delta in the failure line so on-call doesn't have to dig through logs. Skipped (with a `[verifyBackup]` notice and exit 0) when neither `LIVE_COUNTS_URL` nor `LIVE_COUNTS_MANIFEST` is set. | both | Platform team + DB owner |
| 15   | Restored row counts dropped sharply vs the most recent prior verify run (the per-run history file under `WEEK_OVER_WEEK_HISTORY`, default `${BACKUP_DIR}/verify-row-counts-history.json`). One or more tables in `WEEK_OVER_WEEK_TABLES` (default `audit_events,payment_intents,orders`) shrunk by more than `WEEK_OVER_WEEK_MAX_DROP_RATIO` (default 20%) since last week. **Distinct from exit 14**: exit 14 compares restored vs *current* live, so it can't see the case where the producer regenerated the manifest off the same partial dump (manifest agrees with restored, but both regressed). Exit 15 compares restored vs *the prior verify's* restored, so it catches that case. Names every offending table + the prior count + the drop percentage. Recording a baseline (no prior history) does NOT page; only a real drop after a baseline exists does. | both | Platform team + DB owner |

> **On-call routing tip:** the grouping above is the page-routing contract.
> Codes 2/3/6/9/13 are about the transport / freshness / sandbox config /
> workflow misconfig and belong to the platform team (or the repo owner
> for code 13). Codes 4/5/7/10/11/12/14/15 are about the dump's internal
> consistency / completeness and need both platform + the DB owner. Code
> 8 is the audit-integrity invariant and is the only one that should
> land in the audit/compliance owners' on-call queue. If you change the
> grouping here, also update the routing rules in your alert manager so
> pages don't drop on the floor.

## Heartbeat — paging when the scheduler itself stops running

GitHub's "Failed workflow run" notification and the verifier's own exit
codes only fire when the workflow actually executes. They will **not**
fire if the scheduler itself stops running — for example:

- GitHub Actions has an outage or queueing backlog.
- The workflow is silently auto-disabled (GitHub auto-disables scheduled
  workflows after 60 days of inactivity, which can happen if
  `BACKUP_VERIFY_ENABLED` is flipped off temporarily and forgotten).
- The schedule is silently delayed for hours (or skipped entirely) under
  load.
- Someone deletes/renames `.github/workflows/backup-verify.yml` or breaks
  the YAML.

In any of those cases the dumps could quietly stop being verified for
days/weeks, and we wouldn't notice until the next time someone tried to
restore one — usually during an outage, which is the worst possible time
to discover the dumps are unusable. To close that gap **each workflow's**
fetch + verify step is wrapped with `sentry-cli monitors run`, which
posts an `in_progress` check-in at start and an `ok`/`error` check-in at
finish to its own **Sentry Cron monitor** — slug `backup-verify-nightly`
for the Mon-Sat smoke cadence and slug `backup-verify` for the Sunday
fuller cadence. Sentry pages on-call automatically when an expected
check-in fails to arrive within the monitor's check-in margin — i.e. when
the scheduler *itself* fails to execute on time, regardless of whether
the dump itself is healthy. The two slugs are kept distinct on purpose
so a stuck nightly schedule doesn't get masked by a still-running weekly
schedule (or vice versa).

This mirrors the pattern used by the rate-limit-store healthz probe
([`docs/runbooks/rate-limit-store.md`](rate-limit-store.md), Step 5);
keep the two configurations in lockstep when refactoring the heartbeat
wrapper.

### Distinguishing the two pages

There are two distinct on-call page *shapes* produced by these
workflows; each shape can come from either cadence (nightly or weekly).
They have different titles/fingerprints by design, so on-call knows
which playbook section to start from:

| Page | What it means | Where to start |
| --- | --- | --- |
| **GitHub "Failed workflow run" mail for `Backup verify (nightly smoke)` or `Backup verify (weekly full)`** AND a Sentry Cron monitor `error` check-in on the matching slug | The verify job *ran* but exited non-zero. The latest dump is **not restorable**, or the fetch step couldn't pull it. | Jump to ["Backup verification failed"](#backup-verification-failed) below — the dump itself is broken. |
| **Sentry Cron monitor `missed_check_in` issue on `backup-verify-nightly` or `backup-verify`** with no corresponding GitHub workflow run in the timeline | The verify job *did not run at all* on its expected day — the scheduler dropped it. The dumps may be fine, but we have **lost coverage** until we fix the scheduler. | Jump to ["Backup verification stopped running"](#backup-verification-stopped-running) below — investigate the scheduler before the dumps. |

The clearest tell-tale: open **GitHub → Actions** and look at both
workflows' run timelines. If the most recent **nightly** run is older
than ~36h, or the most recent **weekly** run is older than ~8 days, the
corresponding scheduler stopped; if the most recent run is recent and
red, the dump is broken. The Sentry issue title also distinguishes them
— `Missed check-in` vs the workflow-failure mail subject — so triage
doesn't require opening GitHub.

## Sentry Cron monitor configuration

The monitor configuration is **declared in code** at
[`scripts/src/sentryMonitors.config.ts`](../../scripts/src/sentryMonitors.config.ts)
(slug `backup-verify`). Two pieces of automation keep the Sentry-side
state in lockstep with the workflow YAML:

- **CI drift check** — the `Sentry Cron monitors in sync with workflow
  cron` step in `.github/workflows/ci.yml` runs
  `pnpm --filter @workspace/scripts run check-sentry-monitors` on
  every PR. It parses the `cron:` value from this workflow's
  `on.schedule` block and fails the build when it disagrees with the
  declared `schedule`. So the cron values can never silently drift
  apart — change the workflow's `cron:` and `sentryMonitors.config.ts`
  in the same PR or CI rejects the change.
- **Release-time push** — the `sentry-monitors-sync` job in
  `.github/workflows/release.yml` runs
  `pnpm --filter @workspace/scripts run sync-sentry-monitors` on every
  release tag. The script PUTs each declared monitor to Sentry's
  Monitors API (`PUT /api/0/organizations/<org>/monitors/<slug>/`),
  which is idempotent — re-running it without changes is a no-op, and
  a changed `schedule` / `checkin_margin` / `max_runtime` is propagated
  in one job. **Do not edit the monitor in the Sentry UI** — the next
  release will overwrite the manual change. To rotate a value, edit
  `sentryMonitors.config.ts`.

The values currently declared (mirrored here for triage convenience —
the source-of-truth is the config file):

Configure **two** monitors in the Sentry UI (**Crons → Add Monitor**),
one per cadence. Check-ins from each workflow lazily upsert its monitor
on first run, but explicit configuration ensures the schedule + margins
are correct from the first tick:

### Monitor: `backup-verify-nightly`

| Setting | Value | Why |
| --- | --- | --- |
| Slug | `backup-verify-nightly` | Must match the slug in `backup-verify-nightly.yml`'s `sentry-cli monitors run …` invocation. |
| Schedule type | Crontab | Mirrors the GH Actions `schedule:` cadence. |
| Schedule | `0 3 * * 1-6` | Same cron expression as the GH Actions schedule (Mon-Sat 03:00 UTC). Keep this in lockstep with the workflow file — if you ever change the cron in one place, change it in the other in the same PR. |
| Timezone | `UTC` | GH Actions schedules run in UTC. |
| Check-in margin | `60` minutes | Absorbs runner queue time, the workflow's ~30s boot, and `apt-get install postgresql-client`. The job itself is allowed up to 30 minutes (`timeout-minutes: 30`); 60 min is comfortable without being so loose that a missed run goes uncaught past the next on-call shift change. |
| Max runtime | `45` minutes | The workflow's `timeout-minutes: 30` is the hard ceiling; 45 min gives Sentry slack so a healthy long-running smoke restore (large dump, slow runner) doesn't trip a false `error` check-in. Anything longer than this means the runner hung mid-restore. |
| Failure issue threshold | `1` | Page on the first missed check-in — there is no "noisy" failure mode for "the nightly backup-verify job stopped running." Even a single missed night is real loss of coverage. |
| Recovery threshold | `1` | Resolve the issue as soon as the next check-in arrives — once the scheduler is back, we don't need to keep the page open. |
| Environment | `production` | The workflow always passes `--environment production`. |
| Owner / on-call | platform / data-resilience owners | So the page routes to whoever owns the restore drills. Owner is configured in the Sentry UI Teams settings — the API doesn't yet model team ownership for monitors created via PUT. |

To verify the sync wiring without waiting for a release tag, run
locally:

```sh
SENTRY_ORG=<org> DRY_RUN=1 \
  pnpm --filter @workspace/scripts run sync-sentry-monitors
```

This logs the exact JSON payloads the release job would send, without
hitting Sentry. See ["End-to-end integration test against a real Sentry
org"](#end-to-end-integration-test-against-a-real-sentry-org) below for
the deeper drill that actually round-trips the request against the
Sentry Monitors API — run that one before shipping any change to the
sync script's request shape.

### Monitor: `backup-verify`

| Setting | Value | Why |
| --- | --- | --- |
| Slug | `backup-verify` | Must match the slug in `backup-verify.yml`'s `sentry-cli monitors run …` invocation. |
| Schedule type | Crontab | Mirrors the GH Actions `schedule:` cadence. |
| Schedule | `0 3 * * 0` | Same cron expression as the GH Actions schedule (Sunday 03:00 UTC). |
| Timezone | `UTC` | GH Actions schedules run in UTC. |
| Check-in margin | `60` minutes | Same rationale as the nightly monitor; absorbs runner queue + boot. |
| Max runtime | `90` minutes | The weekly fuller pass adds VACUUM ANALYZE + per-index `amcheck` and the workflow's `timeout-minutes: 60` is the hard ceiling; 90 min gives Sentry slack so a healthy long-running fuller restore doesn't trip a false `error` check-in. Higher than the nightly's 45 min on purpose because the fuller pass legitimately takes longer. |
| Failure issue threshold | `1` | Page on the first missed check-in — a single missed week is real loss of coverage. |
| Recovery threshold | `1` | Resolve the issue as soon as the next check-in arrives. |
| Environment | `production` | The workflow always passes `--environment production`. |
| Owner / on-call | platform / data-resilience owners | So the page routes to whoever owns the restore drills. |

### Verifying the heartbeat

From each Sentry monitor's detail page, the timeline should show one
green check-in per scheduled tick (six per week for nightly, one per
week for weekly). To end-to-end verify the page path without waiting
for a real tick:

1. Trigger an ad-hoc run via **Actions → Backup verify (nightly smoke) →
   Run workflow** (or the weekly equivalent — the `workflow_dispatch:`
   entry point exists on both). Confirm a green check-in appears in the
   matching Sentry monitor timeline within a few minutes.
2. To rehearse the *missed check-in* page specifically, briefly disable
   the corresponding workflow (**Actions → Backup verify (…) → ⋯ →
   Disable workflow**) and wait for one cron tick + check-in margin.
   Sentry should fire a `backup-verify-nightly` (or `backup-verify`)
   cron `Missed check-in` issue. Re-enable the workflow once the page
   is confirmed.

### End-to-end integration test against a real Sentry org

The 25 vitest tests in
[`scripts/src/syncSentryMonitors.test.ts`](../../scripts/src/syncSentryMonitors.test.ts)
cover the request shape, retry behaviour, dry-run output, and env-var
validation by stubbing `global.fetch`. They **do not exercise the real
Sentry Monitors API contract** — so a Sentry-side schema change
(renamed field, stricter validation, auth scope tightening) would slip
past CI and only surface as a 4xx during the next release sync, when
the on-call engineer is least equipped to debug it.

The opt-in integration test in
[`scripts/src/syncSentryMonitors.integration.test.ts`](../../scripts/src/syncSentryMonitors.integration.test.ts)
closes that gap. It runs `main()` against a real (sandbox / staging)
Sentry org with a unique throwaway slug, then GETs the monitor back
and asserts the round-tripped values match every field we sent (slug,
name, type, schedule, schedule_type, timezone, checkin_margin,
max_runtime, failure_issue_threshold, recovery_threshold). It re-runs
the upsert a second time to prove idempotency against the real API,
then DELETEs the monitor in `finally` so cleanup is robust even when
the assertions fail.

It does **not** run on every PR — Sentry doesn't appreciate the API
churn, and we don't want to spend a sandbox token rate budget on
PR noise. Run it manually:

- Before merging a PR that changes the request shape in
  `syncSentryMonitors.ts` (payload fields, endpoint path, headers).
- Before cutting a release that's expected to depend on the sync (for
  example, after rotating the production `SENTRY_AUTH_TOKEN`, or after
  Sentry announces a Monitors API change).

There are two equivalent invocations:

1. **GitHub Actions (preferred for CI provenance):** open
   **Actions → Sentry monitor sync — integration → Run workflow**
   ([`.github/workflows/sentry-monitors-integration.yml`](../../.github/workflows/sentry-monitors-integration.yml)).
   The workflow is `workflow_dispatch:` only and will fail loudly if
   the sandbox secret / org var aren't wired, so a "green" run is
   real evidence that the PUT contract still matches Sentry.
2. **Local shell (for ad-hoc API debugging):**

   ```sh
   SENTRY_INTEGRATION=1 \
   SENTRY_INTEGRATION_AUTH_TOKEN=<sandbox-internal-integration-token> \
   SENTRY_INTEGRATION_ORG=<sandbox-org-slug> \
   SENTRY_INTEGRATION_PROJECT=<sandbox-project-slug>   # optional
     pnpm --filter @workspace/scripts run test:sentry-integration
   ```

   When `SENTRY_INTEGRATION=1` is not set the test file is a complete
   no-op (vitest skips the entire `describe` block), so this same
   command on a developer laptop without the env vars cannot
   accidentally hit Sentry.

**Required configuration** (set under **Settings → Secrets and
variables → Actions** on the repo, used only by the integration
workflow above):

| Name | Kind | Purpose |
| --- | --- | --- |
| `SENTRY_INTEGRATION_AUTH_TOKEN` | secret | Internal-integration token on the **sandbox** Sentry org with `project:write` (PUT) and `project:read` (GET) scope. **Never reuse the production sync token** — keep blast radius limited to the sandbox so a buggy test run can't disturb the real monitors. |
| `SENTRY_INTEGRATION_ORG` | var | Sandbox / staging org slug. |
| `SENTRY_INTEGRATION_PROJECT` | var | Optional. Sandbox project slug; when set the test monitor is bound to that project (mirrors the production behaviour when `SENTRY_PROJECT` is set). |
| `SENTRY_INTEGRATION_BASE_URL` | var | Optional. Defaults to `https://sentry.io`. Set for self-hosted sandboxes. |

**On failure:** the test names every assertion that didn't round-trip,
so the GH Actions log line tells you exactly which field Sentry
mangled. Common shapes:

- *HTTP 400 with a `config.<field>` error string* — Sentry tightened
  validation on a field we send (e.g. it now rejects values outside a
  range we previously got away with). Adjust `SentryMonitorConfig` /
  `buildPayload` and re-run the integration test until it stays green
  before merging the change.
- *HTTP 401/403* — the sandbox token lost a scope (or expired). Mint a
  fresh internal-integration token on the sandbox org with
  `project:write` + `project:read` and rotate the secret.
- *Round-trip mismatch on a field we sent* — Sentry silently
  normalised the value (clamped a margin, renamed an enum, dropped
  the timezone). The unit tests cannot see this. Update
  `buildPayload` / `SentryMonitorConfig` to the new shape and re-run.
- *Cleanup `DELETE` failure logged after a passing test* — the test
  succeeded but the throwaway monitor leaked. Open the sandbox org's
  monitor list, search for the `epplaa-sync-itest-` prefix, and
  delete any leftovers manually.

If the workflow run is healthy, you have positive evidence the next
release-time sync will succeed against the production org (assuming
the prod token has the same scopes as the sandbox token used here).

## Required GitHub repo configuration

Configured under **Settings → Secrets and variables → Actions** on the
repo. The workflow degrades safely when these are missing — see inline
comments in `backup-verify.yml` for the matrix.

Variables (`vars.*`):

| Name | Production value | Purpose |
| --- | --- | --- |
| `BACKUP_VERIFY_ENABLED` | `1` | Kill switch — gates **both** the nightly and weekly workflows (they share the same variable on purpose, so flipping it off silences the entire backup-verify safety net deliberately rather than leaving one cadence quietly running). Set to anything else to silence both workflows without removing the files. **Note**: while disabled, *both* Sentry Cron monitors (`backup-verify-nightly` and `backup-verify`) will start paging on missed check-ins — that is intentional. If you need to disable for a known reason (e.g. backup share migration), also temporarily mute both Sentry monitors and set a calendar reminder to re-enable everything. |
| `SENTRY_ORG`, `SENTRY_PROJECT` | (same as the release / healthz workflows) | Reused so events land in the same Sentry project as the api-server's runtime events. |

Secrets (`secrets.*`):

| Name | Purpose |
| --- | --- |
| `RESTORE_DATABASE_URL` | Sandbox DB URL the dump is restored into. **Must never** point at the live DB — `verifyBackup.ts` pg_restore's with `--clean --if-exists`, which would wipe whatever it points at. |
| `BACKUP_FETCH_CMD` | Shell snippet that downloads the latest dump into `./backups/<date>.dump`. Owned by the platform team because it embeds the backup-share credentials. |
| `BACKUP_VERIFY_SENTRY_DSN` | DSN that `sentry-cli monitors run` uses to post the cron-monitor check-ins **for both workflows** (the nightly `backup-verify-nightly` slug and the weekly `backup-verify` slug). Usually the same DSN as the api-server's `SENTRY_DSN` so check-ins land in the same project; kept as a separate repo secret so it can be rotated independently of the runtime DSN. **Without this secret the heartbeat is silently disabled** — each workflow logs a `::warning::` and runs the verifier directly. Configure it to get coverage for "the job stopped running at all." |
| `LIVE_COUNTS_URL` | *(optional)* Read-only Postgres connection string the verifier `psql`-queries to fetch expected row counts for the live-vs-restored comparison (exit 14). Use the cheapest read-only role you have on production. **Mutually exclusive** with `LIVE_COUNTS_MANIFEST_URL` (the verifier rejects the run if both are set). When neither is configured the comparison is skipped with a `[verifyBackup]` notice and a stale-but-restorable dump can pass undetected. **Same secret on both workflows** — keep them in lockstep so both cadences agree on what "fresh" means. |
| `LIVE_COUNTS_MANIFEST_URL` | *(optional)* HTTP(S) URL to a small JSON snapshot the platform's `pg_dump` cron writes alongside the dump, mapping table name → live row count. Use this when the GH Actions runner cannot reach the production DB directly. The workflow `curl -fsSL`s it into `./backups/live-counts.json` *before* invoking the verifier and exports `LIVE_COUNTS_MANIFEST=$BACKUP_DIR/live-counts.json` for the verifier to read. **Mutually exclusive** with `LIVE_COUNTS_URL`. Manifest format: `{"audit_events": 1234567, "payment_intents": 89012, "orders": 4567}`. **Operational note:** if the `curl` itself fails (manifest URL 404, DNS broken, etc.) the workflow step exits non-zero *before* `verifyBackup.ts` even runs, so the GH Actions failure surfaces with the curl exit status — not exit code 14. Triage that as a manifest-transport problem (check the URL + the producer cron) rather than a stale-dump problem. |

Optional tuning env vars (set on the workflow step `env:`, not as repo
secrets — they're not sensitive):

| Name | Default | Purpose |
| --- | --- | --- |
| `MAX_DUMP_AGE_HOURS` | `36` | Newest `*.dump` in `BACKUP_DIR` must be at most this many hours old, otherwise exit 6. 36h gives one full nightly cycle of slack so a single missed nightly does not page, but two missed nightlies do. Lower it if you tighten the nightly cadence. |
| `REQUIRED_EXTENSIONS` | *(unset → check skipped)* | Comma-separated list of Postgres extensions that must be installed on the restored sandbox (e.g. `pgcrypto,pg_trgm`). When unset the extension check logs a notice and skips — set it once you know which extensions the production schema actually depends on. Mismatch → exit 9. |
| `LIVE_COUNTS_TABLES` | `audit_events,payment_intents,orders` | Comma-separated list of tables the verifier queries via `LIVE_COUNTS_URL` for the live-vs-restored comparison. Only consulted in the `LIVE_COUNTS_URL` branch — the `LIVE_COUNTS_MANIFEST` branch trusts whatever tables the manifest lists, on the assumption that the platform's `pg_dump` cron is the source-of-truth for which tables matter. Keep the list small (count(*) on production tables is not free); the default covers the money-flow + audit chain. Each entry must be a plain table name or `schema.table` — alphanumerics + underscore only. |
| `LIVE_COUNTS_MIN_RATIO` | `0.99` | Minimum fraction of the live count we tolerate seeing in the restored sandbox. `0.99` (the default) absorbs the small write-traffic gap between when `pg_dump` snapshotted and when the verifier reads the live count, without silently accepting a dump that's missing a meaningful chunk of rows. Lower it (e.g. `0.95`) if your write traffic is bursty enough that 1% drift produces false positives; **do not** lower it past `0.9` without the DB owner's sign-off — at that point a real partial-table-skip hides inside the threshold. Must be in `(0, 1]`. |
| `WEEK_OVER_WEEK_HISTORY` | `${BACKUP_DIR}/verify-row-counts-history.json` | Path to the per-run row-count history file used by the week-over-week drift check (exit 15). Must be writable by the workflow user — point it somewhere persistent across runs (the same backup share where the dumps live works well; a runner-local path resets every run and silently disables the check). The file is a versioned JSON object — see `verifyBackup.ts` for the shape. Delete it to reset the baseline (the next run records a fresh baseline and skips the comparison). |
| `WEEK_OVER_WEEK_TABLES` | `audit_events,payment_intents,orders` | Comma-separated list of tables the verifier counts and tracks across runs for the week-over-week comparison (exit 15). Same identifier rules as `LIVE_COUNTS_TABLES`. Default is the same three smoke / money-flow / audit-chain tables — keep the list small because each entry is one extra `count(*)` against the restored sandbox per run. Setting this to an empty value is a hard error (use `WEEK_OVER_WEEK_MAX_DROP_RATIO=1` to disable instead). **Caveat when shrinking the list**: the comparison iterates every table in the prior history entry, so removing a table from this list does NOT stop comparing it until the prior history entry rolls off (or you delete the history file to reset the baseline). Adding a table is safe — the new table is recorded on the next run and starts participating in comparisons one run later. |
| `WEEK_OVER_WEEK_MAX_DROP_RATIO` | `0.2` | Maximum drop (as a fraction in `[0, 1]`) tolerated on any tracked table between two consecutive verify runs before exit 15 fires. `0.2` (the default) means a 20% drop pages — generous enough to absorb a one-off purge / archival pass without paging, tight enough to catch the motivating regression of a partial pg_dump (`orders` 1.2M -> 5). **Do not** lower below ~0.05 without DB owner sign-off (legitimate purges trip false positives) and **do not** raise above ~0.5 (real partial-table-skips hide inside the threshold). Set to exactly `1` to disable the check entirely without removing the env var. |
| `WEEK_OVER_WEEK_MAX_HISTORY` | `12` | Number of history entries to retain in `WEEK_OVER_WEEK_HISTORY`. ~3 months of weekly entries by default; older entries are dropped FIFO. Only the most recent entry is consulted for comparison — the older entries exist for human triage when a page fires. Must be a positive integer. |

## Backup verification failed

You're here because the verify job ran and exited non-zero. The dump
itself is the problem — the scheduler is fine.

1. Open the failing GitHub Actions run linked from the Sentry `error`
   check-in (or from the "Failed workflow run" mail) and find the exit
   code in the step log. Map it to the table at the top of this runbook
   to know whether to look at fetch, restore, or smoke.
2. **Exit 2 (`BACKUP_FETCH_CMD missing` / no dumps)** — the platform
   team's snippet is broken or the backup share is empty. Page the
   platform team; do not retry until they confirm the share is healthy.
3. **Exit 3 (`RESTORE_DATABASE_URL missing`)** — repo configuration
   regressed. Re-check **Settings → Secrets and variables → Actions**
   and confirm the secret is set; never point it at the live DB.
4. **Exit 4 (`pg_restore` failed)** — the dump itself is corrupt or the
   schema has drifted past what the dump represents. Pull the dump
   locally and re-run `pg_restore` to capture the real error; common
   causes are a missing extension on the sandbox DB
   (`CREATE EXTENSION` in the sandbox before re-running) or a corrupt
   transfer (re-fetch and re-checksum).
5. **Exit 5 (smoke `psql` failed)** — the restore "succeeded" but the
   restored DB is missing core tables (`audit_events`, `payment_intents`,
   `orders`). This usually means we restored a partial / pre-migration
   dump. Check the `pg_dump` step on the platform side.
6. **Exit 6 (stale dump)** — the newest `*.dump` in `BACKUP_DIR` is older
   than `MAX_DUMP_AGE_HOURS` (36h by default). The verifier refused to
   "verify" last week's dump as if it were this week's. The nightly
   producer almost certainly stalled — page the platform team and check
   the producer's last successful run timestamp on the backup share. Do
   **not** widen `MAX_DUMP_AGE_HOURS` to silence this; that hides the
   producer outage. Fires in both modes.
7. **Exit 7 (FK integrity, full mode only)** — the restored data has
   orphan `payment_intents.order_id`, dangling `orders.user_id`, or
   dangling `payment_intents.user_id`. The dump is internally
   inconsistent. Pull the failing counts out of the step log (the
   `fail()` line lists exactly which join is broken) and:
   - If counts are small (< 100) and stable across reruns, this is
     likely a single bad migration that landed mid-`pg_dump` snapshot —
     re-fetch the next nightly and confirm it clears. File a ticket
     against the DB owner to investigate the source rows.
   - If counts grow week-over-week, a write path is creating rows that
     violate the join. **Do not** silence — page the DB owner.
8. **Exit 8 (audit chain broken, full mode only)** — page the **audit /
   compliance owners**, not the platform team. Either the dump was
   corrupted in transit (re-fetch and re-checksum the dump file, then
   re-run; if the chain validates on the re-fetched copy, file a
   transport-corruption ticket against the platform team) OR an
   `audit_events` row was rewritten in place before the dump was taken
   — which by the append-only invariant in
   `artifacts/api-server/src/lib/audit.ts` should be impossible. The
   latter is a security incident: preserve the dump file, do not
   overwrite it, and follow the audit-tamper incident response (out of
   scope for this runbook).
   > **Cross-reference — in-prod chain verifier.** The same
   > `verifyAuditChain()` invariant is also probed against the **live**
   > `audit_events` table every few hours by the in-prod scheduled
   > runner in `artifacts/api-server/src/lib/auditChainVerifier.ts`
   > (see ["In-prod audit-chain verifier"](#in-prod-audit-chain-verifier)
   > below). If the live runner has been firing
   > `audit_chain_tamper_detected` Sentry alerts in the days leading up
   > to a weekly exit-8 page, the live tamper happened before the
   > `pg_dump` was taken — the dump didn't corrupt anything, it
   > faithfully captured a tampered live row. Triage from the live
   > runner's first detection rather than from the weekly drill, and
   > preserve both the dump and the live `audit_events` table state.
   > Conversely, an exit 8 with a clean live runner timeline strongly
   > suggests transport corruption rather than live tampering — start
   > with a re-fetch + re-checksum of the dump.
9. **Exit 9 (missing extensions)** — the restored sandbox is missing one
   or more names from `REQUIRED_EXTENSIONS` (the `fail()` line lists
   them). Either install them on the sandbox (`CREATE EXTENSION ...`)
   and rerun, or fix the dump's extension preamble on the producer
   side. The data IS present in the sandbox but the production app
   will not boot against it, which is exactly the failure the restore
   drill is supposed to surface ahead of an actual recovery. Fires in
   both modes.
10. **Exit 10 (`VACUUM (ANALYZE)` failed, full mode only)** — pg_restore
    replayed the dump but VACUUM hit an unreadable page on a full heap
    scan. This is the classic "smoke passed, fuller pass caught real
    corruption" signal. Pull the dump locally and re-run `pg_restore` +
    `VACUUM (VERBOSE, ANALYZE)` to identify the offending relation, then
    page the platform team to investigate the source DB and the dump
    transport.
11. **Exit 11 (table inventory psql failed, full mode only)** — the
    `pg_stat_user_tables` query against the restored DB failed. Rare;
    most likely a sandbox DB without a stats collector, or psql being
    wedged. Re-run the workflow once before escalating.
12. **Exit 12 (`amcheck` btree validation failed, full mode only)** — a
    btree index on the restored DB is corrupt. **Note**: this exit code
    only fires if the `amcheck` extension was available in the sandbox
    AND `bt_index_check()` reported a real corruption; an unavailable
    extension is downgraded to a `::warning::` and exit 0 (smoke +
    vacuum + inventory still ran). On a real exit 12: pull the dump
    locally, re-run `pg_restore` + `bt_index_check` to find the failing
    index, then page the platform team — a corrupt index in the dump
    means the source DB likely has the same corrupt index.
13. **Exit 13 (unknown `--mode` value)** — operator typo in the workflow
    YAML. Check the `--mode=…` arg passed to `verifyBackup.ts` and fix
    the workflow file.
14. **Exit 14 (live-counts comparison failed, both modes)** — the dump
    is restorable, but the restored row counts for one or more tables
    are below `LIVE_COUNTS_MIN_RATIO` (default 99%) of the live
    source / manifest counts. The verifier names every offending
    table and the absolute / percentage delta in the `fail()` line at
    the bottom of the step log — read that first; it tells you which
    write path is at risk and by how much. Important: this is **not**
    the same as exit 6 (which is "the dump *file* mtime is older than
    `MAX_DUMP_AGE_HOURS`"). Exit 14 fires when the file is fresh but
    its *contents* lag — the producer wrote a new dump file, but
    `pg_dump` silently skipped a critical table, or the file is a
    symlink/copy of an older dump that just had its mtime touched. To
    triage:
    - **Tables with restored=0 against a non-zero live count** — the
      dump is missing a whole table. Almost certainly a `pg_dump`
      argument regression (e.g. `--exclude-table` accidentally
      matched it, or a `--schema-only` slipped in). Page the platform
      team and pull the producer logs for the most recent run.
    - **Tables with restored < live but > 0, ratio close to threshold
      (e.g. 98%)** — could be legitimate write-traffic drift between
      the `pg_dump` snapshot and the verifier's live read, especially
      on append-heavy tables (`audit_events`). Re-run once: if the
      next nightly clears, log it and move on; if it persists or
      grows, the producer is silently behind. Do **not** lower
      `LIVE_COUNTS_MIN_RATIO` past `0.9` to silence — at that point a
      real partial-table-skip hides inside the threshold (page the DB
      owner first; tune the threshold only with their sign-off).
    - **Tables with restored >> live** — investigate
      `LIVE_COUNTS_URL` is actually pointing at production (not at a
      stale read replica that lags writes). Often this means the
      "live" source itself is the stale one and the restored data is
      newer.
    - **psql connection failure to `LIVE_COUNTS_URL`** — also exits 14
      (with a `psql exited N querying count(*) FROM …` line). Check
      production network reachability + the read-only role's
      grants; the `LIVE_COUNTS_MANIFEST_URL` path exists for exactly
      this case (runners that can't reach prod).
15. **Exit 15 (week-over-week row-count drop, both modes)** — the dump
    is restorable, the smoke + live-counts checks both passed, but
    one or more tables in `WEEK_OVER_WEEK_TABLES` shrunk by more than
    `WEEK_OVER_WEEK_MAX_DROP_RATIO` (default 20%) compared to the
    most recent prior verify run's persisted counts. The verifier
    names every offending table along with `current=`, `prior=`, the
    drop percentage, and the absolute delta in the `fail()` line —
    read that first; it tells you which write path is at risk and by
    how much. **Important**: this is **not** the same as exit 14.
    Exit 14 compares restored vs *current* live, so it cannot see
    the case where the producer regenerated the manifest off the
    same partial dump (manifest agrees with restored, but both have
    regressed). Exit 15 compares restored vs *the prior verify's*
    restored, which catches that case. Triage:
    - **One table dropped to ~0 with the others unchanged** — almost
      certainly a `pg_dump` argument regression (e.g.
      `--exclude-table` accidentally matched it, or a partial dump
      was published over the good one). Page the platform team and
      pull the producer logs for the most recent run.
    - **All tables dropped by similar percentages (e.g. 30-40%
      across the board)** — likely a real bulk-delete / archival
      pass landed on the source DB. Confirm with the DB owner that
      the deletion is intentional. Once confirmed, accept the new
      baseline by deleting the history file
      (`WEEK_OVER_WEEK_HISTORY`) on the backup share and re-running
      the workflow — the next run will record a fresh baseline and
      pass.
    - **A single table dropped by just over the threshold (e.g.
      21%)** — could be a legitimate one-off purge. Re-run once: if
      the next run's counts are stable around the new value, it's
      real and you can clear the history file to accept the new
      baseline (after DB owner sign-off). If it keeps shrinking
      week-over-week, the producer is silently losing data.
    - **`WEEK_OVER_WEEK_HISTORY` is unreadable / malformed** — also
      exits 15 with a `cannot read week-over-week history` or `…
      not valid JSON / unknown version` message. Most likely a
      half-written file from a previous crash; delete it and re-run
      to record a fresh baseline. Investigate the storage backend
      if the corruption recurs.
    - **`fail()` line says "cannot write …"** — the history path is
      not writable by the workflow user. Either fix the directory
      permissions on the backup share or point
      `WEEK_OVER_WEEK_HISTORY` somewhere writable. Without a
      writable history path the next run cannot establish a
      baseline, leaving us blind to this failure mode.

    The history file is **intentionally not updated** when this code
    fires, so the page keeps firing on every subsequent run until
    either the data is restored OR the operator clears the history
    file to accept the new baseline. Do not silence the workflow as
    the recovery path.

In all cases, **do not silence the workflow** as the recovery path —
the page is telling you the dump is bad, and silencing it will mask the
problem, not fix it.

## Backup verification stopped running

You're here because Sentry fired a `Missed check-in` on either the
`backup-verify-nightly` or the `backup-verify` monitor. The dumps may
still be fine — the *scheduler* is the problem. Until you fix it we have
no signal that the dumps remain restorable on that cadence.

The slug in the Sentry issue tells you which workflow to investigate:
`backup-verify-nightly` → `.github/workflows/backup-verify-nightly.yml`,
`backup-verify` → `.github/workflows/backup-verify.yml`. The triage
steps below apply equally to either workflow — substitute the right
workflow name in step 1.

1. Open **GitHub → Actions → Backup verify (nightly smoke)** *or*
   **Backup verify (weekly full)** (whichever monitor paged). Look at
   the timeline:
   - **No runs in the last expected window** (~36h for nightly, ~8 days
     for weekly) — the schedule was dropped. Continue to step 2.
   - **A run in the window, but it was cancelled or never started a
     job** — likely a GitHub Actions outage at the scheduled time.
     Check [the GitHub status page](https://www.githubstatus.com) for
     a corresponding incident.
2. Check whether the workflow has been auto-disabled. GitHub disables
   scheduled workflows after 60 days of inactivity. If you see a
   "This scheduled workflow is disabled because there hasn't been
   activity in this repository for at least 60 days" banner at the top
   of the Actions page, click **Enable workflow** and trigger a manual
   run via **Run workflow** to confirm it's back.
3. Check whether the kill switch is off. Open
   **Settings → Secrets and variables → Actions → Variables** and
   confirm `BACKUP_VERIFY_ENABLED` is `1`. If it was set to anything
   else, **both** jobs were being skipped on every tick (the Sentry
   monitors don't see check-ins when `if:` skips the job). Restore it
   to `1` and expect the *other* monitor to also clear once its next
   tick lands.
4. Check that the workflow file still exists and parses. Run
   `gh workflow list` (or browse to **Actions** in the GitHub UI) and
   confirm both `Backup verify (nightly smoke)` and `Backup verify
   (weekly full)` are listed. If someone renamed or deleted either
   `.github/workflows/backup-verify-nightly.yml` or
   `.github/workflows/backup-verify.yml`, restore it from git history.
5. Once the scheduler is healthy, trigger an ad-hoc run via
   **Run workflow** on the affected workflow to (a) confirm the wiring
   end-to-end and (b) post a fresh `ok` check-in to Sentry so the
   missed-check-in issue auto-resolves. Do **not** mark the issue
   resolved manually before the workflow runs successfully — you'll
   lose the audit trail of when coverage was actually restored.

## In-prod audit-chain verifier

The weekly backup-verify drill (exit 8 above) only sees the chain
*after* the most recent `pg_dump`, so a tamper-then-redump sequence —
or any in-place edit of `audit_events` between drills — could go
undetected for up to a week. To close that gap the api-server runs a
lightweight in-prod loop that calls `verifyAuditChain()` from
`artifacts/api-server/src/lib/audit.ts` against the **live DB** on a
configurable cadence and pages the **same audit/compliance owners**
that exit 8 routes to.

| Aspect | Value |
| --- | --- |
| Implementation | [`artifacts/api-server/src/lib/auditChainVerifier.ts`](../../artifacts/api-server/src/lib/auditChainVerifier.ts) |
| Cadence | Every `AUDIT_CHAIN_VERIFY_INTERVAL_MS` ms (default `14_400_000` = 4h; minimum 60s, sub-minute values fall back to the default). First run is staggered ~5 min after boot to avoid racing schema/seed init. |
| Probe | `verifyAuditChain(0)` — full-chain replay against `audit_events`. |
| On a non-null offending seq | (a) Structured log `audit_chain_tamper_detected` with `{ offendingSeq, source, durationMs }`. (b) `captureMessage("audit_chain_tamper_detected", { level: "fatal", tags: { subsystem: "auditChain", check: "verifyAuditChain", source }, fingerprint: ["audit_chain_tamper_detected"], extra: { offendingSeq, durationMs, verifiedAt } })` — the audit/compliance owners' Sentry alert routing rule keys off `subsystem=auditChain` + the stable fingerprint, mirroring exit 8 above. (c) Trips `auditChainVerifyHealthWatcher` so /healthz reports `subsystems.auditChainVerify.state = "degraded"` and the duration probe (see the rate-limit-store runbook for the duration-probe contract) keeps paging until an operator manually intervenes. |
| On a null result | Closes the watcher streak (sets `state = "healthy"`, stamps `lastRecoveredAt`). The Sentry issue stays open as the forensic trail; only the in-memory health state recovers. |
| On a probe error (DB unreachable / query timeout) | Logs warn `audit_chain_verify_failed`; stores the message in `subsystems.auditChainVerify.lastVerifyError`; **does NOT trip the watcher and does NOT call `captureMessage`** — conflating "we couldn't measure the chain" with "the chain is broken" would erode the alert's signal and cross-page audit/compliance owners for what is actually a platform incident (the dbHealthWatcher already pages on the underlying DB outage via /readyz). |
| Pager channel | Same as exit 8 — audit/compliance owners' on-call queue, via the Sentry alert rule keyed on `subsystem=auditChain` + `audit_chain_tamper_detected` fingerprint. |

### Admin endpoint — `POST /api/internal/audit-chain/verify`

Exposes the same `runAuditChainVerification()` path so an operator can
force an immediate verify between scheduled ticks — for example after
a suspected DB restore, before/after maintenance, or when investigating
a Sentry `audit_chain_tamper_detected` alert. Sharing the
implementation guarantees the on-demand probe has the same paging
semantics as the scheduled tick.

- **Auth**: gated by `requireAdmin` (the env-allowlist gate in
  `artifacts/api-server/src/routes/admin.ts`). Use the env-allowlist
  rather than the DB role check on purpose: it still authorises
  operators when the very table being investigated has issues.
- **Request**: empty body.
- **Responses**:
  - `200 { ok: true, offendingSeq: null, durationMs, verifiedAtIso, snapshot }` — chain is intact.
  - `409 { ok: false, error: "audit_chain_tamper_detected", offendingSeq, durationMs, verifiedAtIso }` — tamper detected. The Sentry capture + structured log have already fired from inside `runAuditChainVerification` before the response is sent.
  - `503 { ok: false, error: "verify_failed", detail, durationMs }` — the probe itself errored (DB unreachable, query timeout). Triage as a platform incident, not an audit incident.

Example:

```sh
curl -fsS -X POST -u "$ADMIN_USER:$ADMIN_PASS" \
  https://<host>/api/internal/audit-chain/verify | jq
```

### Tuning env vars

| Name | Default | Purpose |
| --- | --- | --- |
| `AUDIT_CHAIN_VERIFY_INTERVAL_MS` | `14400000` (4h) | Cadence between scheduled verify runs against the live `audit_events` table. Sub-minute values (or any non-numeric/zero/negative value) fall back to the 4h default — sub-minute polling would slam the DB on a large chain and isn't a realistic operator intent. Lower it (e.g. to 30 min) if you want tighter detection latency on a small table; do not raise it past ~12h without sign-off from the audit/compliance owners — the whole point of this runner is to detect tampering between weekly drills, and a 24h cadence approaches that drill cadence. |

### /healthz surface

The verifier exposes its state under `subsystems.auditChainVerify` in
the `/healthz` response. Shape (extends the standard
`SubsystemSnapshot`):

```json
{
  "state": "healthy" | "degraded",
  "failureCount": <number>,
  "firstFailureAt": <ms-epoch | null>,
  "lastRecoveredAt": <ms-epoch | null>,
  "lastVerifiedAt": <ms-epoch | null>,
  "lastDurationMs": <number | null>,
  "lastOffendingSeq": <number | null>,
  "lastVerifyError": <string | null>,
  "intervalMs": 14400000
}
```

Triage tells:

- `state="degraded"` + `lastOffendingSeq` set + `lastVerifyError=null` → tamper detected; the Sentry page is the canonical alert.
- `state="healthy"` + `lastVerifyError` set → the probe is failing to measure (DB-pool issue); not an audit incident, look at /readyz.
- `lastVerifiedAt=null` after the boot stagger window has elapsed → the verifier never started; check the api-server boot logs for `audit_chain_verifier_started`.

## Local invocation

Useful when iterating on the verifier itself or when reproducing a
pg_restore / freshness / FK / chain failure locally. The script
defaults to `--mode=smoke`; pass `--mode=full` to reproduce a weekly
fuller run locally.

```sh
# Smoke (matches the nightly workflow):
BACKUP_DIR=/tmp/backups \
RESTORE_DATABASE_URL='postgres://verify:verify@localhost:5432/sandbox' \
MAX_DUMP_AGE_HOURS=36 \
REQUIRED_EXTENSIONS=pgcrypto,pg_trgm \
LIVE_COUNTS_MANIFEST=/tmp/backups/live-counts.json \
  pnpm --filter @workspace/scripts exec tsx src/verifyBackup.ts --mode=smoke

# Full (matches the weekly workflow — adds FK integrity + VACUUM
# ANALYZE + inventory + amcheck btree validation + audit-chain replay):
BACKUP_DIR=/tmp/backups \
RESTORE_DATABASE_URL='postgres://verify:verify@localhost:5432/sandbox' \
MAX_DUMP_AGE_HOURS=36 \
REQUIRED_EXTENSIONS=pgcrypto,pg_trgm \
LIVE_COUNTS_MANIFEST=/tmp/backups/live-counts.json \
  pnpm --filter @workspace/scripts exec tsx src/verifyBackup.ts --mode=full
```

Drop `LIVE_COUNTS_MANIFEST` (and don't set `LIVE_COUNTS_URL`) to skip
the live-vs-restored comparison locally — the verifier prints a
`[verifyBackup]` skip notice and still runs every other check.

Same exit codes as the workflows. The script logs each check's verdict
on its own `[verifyBackup]` line so you can see at a glance which step
failed without scrolling back through the `pg_restore` output.

To rehearse each new failure mode against a local sandbox:

- **Exit 6 (stale dump):** `touch -d '3 days ago' /tmp/backups/old.dump`
  with no fresher file, then rerun.
- **Exit 7 (FK integrity, full mode only):** after a successful run,
  `psql $RESTORE_DATABASE_URL -c "INSERT INTO payment_intents (id,
  user_id, purpose, gateway, reference, amount_minor, currency_code,
  order_id) VALUES ('pi_orphan', 'usr_x', 'order', 'devmock',
  'ref_orphan', 100, 'NGN', 'ord_does_not_exist');"` then rerun with
  `--mode=full` (it will re-restore over the row, so for the exit-7
  rehearsal edit the dump or stage the bad row in the source DB before
  `pg_dump`).
- **Exit 8 (audit chain broken, full mode only):** the chain triggers
  in `artifacts/api-server/src/lib/audit.ts` block UPDATE/DELETE on
  `audit_events` at the DB level, so you can only rehearse this by
  pre-tampering with a copy of the dump (e.g. `pg_restore` to a sandbox,
  drop the triggers, mutate one row's payload, re-`pg_dump`, then point
  the verifier at the tampered dump and run `--mode=full`).
- **Exit 9 (missing extensions):** drop a known extension from the
  sandbox (`DROP EXTENSION pgcrypto`) before rerun.
- **Exit 13 (unknown `--mode`):** pass `--mode=foo` to confirm the
  argument parser fails fast.
- **Exit 14 (live counts stale/incomplete):** the cleanest local
  rehearsal is via the manifest path, because it doesn't require a
  second running Postgres. After a successful smoke run against a
  freshly restored sandbox, write a manifest that overstates the live
  count for one table by enough to breach the default 99% threshold,
  then rerun:
  ```sh
  RESTORED_AUDIT=$(psql "$RESTORE_DATABASE_URL" -At -c \
    'SELECT count(*) FROM audit_events')
  # Claim live=2x restored — guaranteed to breach 0.99.
  printf '{"audit_events": %d}\n' "$((RESTORED_AUDIT * 2))" \
    > /tmp/backups/live-counts.json
  LIVE_COUNTS_MANIFEST=/tmp/backups/live-counts.json \
  BACKUP_DIR=/tmp/backups \
  RESTORE_DATABASE_URL='postgres://verify:verify@localhost:5432/sandbox' \
    pnpm --filter @workspace/scripts exec tsx src/verifyBackup.ts \
      --mode=smoke
  ```
  The verifier should exit 14 with a `fail()` line that names
  `audit_events` and the percentage / absolute delta. Replacing the
  manifest content with the real `RESTORED_AUDIT` (or removing the
  env var entirely) clears the rehearsal. To rehearse the
  `LIVE_COUNTS_URL` branch, point it at any read-only Postgres with
  the relevant tables and re-run; the comparison branch is the same
  past the source-resolution step.
- **Exit 15 (week-over-week row-count drop):** the cleanest local
  rehearsal is to record a baseline against the real restored counts,
  then rewrite the saved baseline to claim a much higher prior count
  for one table — guaranteed to breach the default 20% drop threshold
  on the next run:
  ```sh
  rm -f /tmp/backups/verify-row-counts-history.json
  # First run: records a baseline against the real restored counts
  # and exits 0 (no prior history -> nothing to compare against).
  BACKUP_DIR=/tmp/backups \
  RESTORE_DATABASE_URL='postgres://verify:verify@localhost:5432/sandbox' \
    pnpm --filter @workspace/scripts exec tsx src/verifyBackup.ts \
      --mode=smoke
  # Inflate the baseline's orders count 10x so the next run sees a
  # ~90% drop, well past the 20% default threshold.
  python3 -c "
  import json, sys
  p = '/tmp/backups/verify-row-counts-history.json'
  h = json.load(open(p))
  h['entries'][-1]['counts']['orders'] *= 10
  json.dump(h, open(p, 'w'))
  "
  # Second run: comparison fires -> exit 15.
  BACKUP_DIR=/tmp/backups \
  RESTORE_DATABASE_URL='postgres://verify:verify@localhost:5432/sandbox' \
    pnpm --filter @workspace/scripts exec tsx src/verifyBackup.ts \
      --mode=smoke
  ```
  The verifier should exit 15 with a `fail()` line naming `orders`
  and the inflated drop percentage. `rm` the history file to clear
  the rehearsal; the next run will record a fresh baseline.
