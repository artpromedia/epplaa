# Runbook: Backup verify

The Postgres dump that protects us from corruption / accidental DELETE /
malicious wipe is only useful if it can actually be restored. The nightly
`pg_dump` itself is owned by the deployment platform / managed Postgres
provider (we cannot reach the production network from GitHub Actions),
but the **weekly restore-from-dump smoke test** that proves the dumps are
restorable lives in this repo:

| Aspect | Where it lives |
| --- | --- |
| Workflow | [`.github/workflows/backup-verify.yml`](../../.github/workflows/backup-verify.yml) |
| Verifier script | [`scripts/src/verifyBackup.ts`](../../scripts/src/verifyBackup.ts) |
| Schedule | `0 3 * * 0` (Sunday 03:00 UTC) — once per week |
| Probe surface | `pg_restore` of the latest `*.dump` into a throwaway sandbox DB, followed by freshness check, row-count smoke, extension presence check, anti-join FK integrity across `orders ↔ payment_intents ↔ users`, and end-to-end audit-chain replay against `audit_events` |
| Pager channel | Sentry Cron monitor (heartbeat) + GitHub "Failed workflow run" mail (backstop) |

The verify pass exits non-zero and pages on:

| Code | Meaning | Page who |
| ---- | ------- | -------- |
| 1    | Generic verify error (the script's `fail()` default) | Whoever caught the page — escalate after triage |
| 2    | Missing `BACKUP_FETCH_CMD` or no `*.dump` files in `BACKUP_DIR` | Platform team (transport) |
| 3    | Missing `RESTORE_DATABASE_URL` — refused to restore for safety | Platform team (workflow config) |
| 4    | `pg_restore` exited non-zero (corrupt dump, schema drift, structurally broken file) | Platform team (transport / DB owner) |
| 5    | Smoke `psql` exited non-zero — restored DB is missing one of `audit_events` / `payment_intents` / `orders`, OR any of those tables has zero rows after restore (a structurally-valid but empty dump). | DB owner |
| 6    | Stale dump — newest `*.dump` in `BACKUP_DIR` is older than `MAX_DUMP_AGE_HOURS` (default 36h). Strong signal the nightly producer stalled and we restored last week's data. | Platform team (freshness) |
| 7    | FK integrity violation in the restored data (orphan `payment_intents.order_id`, dangling `orders.user_id` / `payment_intents.user_id`). The dump is internally inconsistent. | Platform team + DB owner |
| 8    | Audit-chain hash chain failed to validate end-to-end on the restored data — either the dump was corrupted in transit OR a row was rewritten in place before the dump was taken. | **Audit / compliance owners** (this is the only code that page-routes there) |
| 9    | A name in `REQUIRED_EXTENSIONS` (e.g. `pgcrypto`, `pg_trgm`) is missing on the restored sandbox. The data is technically present but the production app will not boot against it. | Platform team (sandbox config) |

> **On-call routing tip:** the grouping above is the page-routing contract.
> Codes 2/3/6/9 are about the transport / freshness / sandbox config and
> belong to the platform team. Codes 4/5/7 are about the dump's internal
> consistency and need both platform + the DB owner. Code 8 is the
> audit-integrity invariant and is the only one that should land in the
> audit/compliance owners' on-call queue. If you change the grouping
> here, also update the routing rules in your alert manager so pages
> don't drop on the floor.

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
weeks, and we wouldn't notice until the next time someone tried to
restore one — usually during an outage, which is the worst possible time
to discover the dumps are unusable. To close that gap the workflow's
fetch + verify step is wrapped with `sentry-cli monitors run`, which
posts an `in_progress` check-in at start and an `ok`/`error` check-in at
finish to a **Sentry Cron monitor** with the slug `backup-verify`.
Sentry pages on-call automatically when an expected check-in fails to
arrive within the monitor's check-in margin — i.e. when the scheduler
*itself* fails to execute on time, regardless of whether the dump itself
is healthy.

This mirrors the pattern used by the rate-limit-store healthz probe
([`docs/runbooks/rate-limit-store.md`](rate-limit-store.md), Step 5);
keep the two configurations in lockstep when refactoring the heartbeat
wrapper.

### Distinguishing the two pages

There are two distinct on-call pages produced by this workflow. They
have different titles/fingerprints by design, so on-call knows which
playbook section to start from:

| Page | What it means | Where to start |
| --- | --- | --- |
| **GitHub "Failed workflow run" mail for `Backup verify (weekly)`** AND a Sentry Cron monitor `error` check-in on `backup-verify` | The verify job *ran* but exited non-zero. The latest dump is **not restorable**, or the fetch step couldn't pull it. | Jump to ["Backup verification failed"](#backup-verification-failed) below — the dump itself is broken. |
| **Sentry Cron monitor `missed_check_in` issue on `backup-verify`** with no corresponding GitHub workflow run in the timeline | The verify job *did not run at all* this week — the scheduler dropped it. The dumps may be fine, but we have **lost coverage** until we fix the scheduler. | Jump to ["Backup verification stopped running"](#backup-verification-stopped-running) below — investigate the scheduler before the dumps. |

The clearest tell-tale: open **GitHub → Actions → Backup verify (weekly)**.
If the most recent run is older than ~8 days, the scheduler stopped; if
the most recent run is from this week and is red, the dump is broken.
The Sentry issue title also distinguishes them — `Missed check-in` vs
the workflow-failure mail subject — so triage doesn't require opening
GitHub.

## Sentry Cron monitor configuration

Configure the monitor in the Sentry UI (**Crons → Add Monitor**) with
these values; check-ins from the workflow lazily upsert the monitor on
first run, but explicit configuration ensures the schedule + margins are
correct from the first tick:

| Setting | Value | Why |
| --- | --- | --- |
| Slug | `backup-verify` | Must match the slug in the workflow's `sentry-cli monitors run …` invocation. |
| Schedule type | Crontab | Mirrors the GH Actions `schedule:` cadence. |
| Schedule | `0 3 * * 0` | Same cron expression as the GH Actions schedule, so Sentry expects exactly one check-in per scheduled tick (Sunday 03:00 UTC). Keep this in lockstep with the workflow file — if you ever change the cron in one place, change it in the other in the same PR. |
| Timezone | `UTC` | GH Actions schedules run in UTC. |
| Check-in margin | `60` minutes | Generous enough to absorb runner queue time during weekend backlogs, the workflow's ~30s install/boot, and `apt-get install postgresql-client`. The job itself is allowed up to 30 minutes (`timeout-minutes: 30`), but the check-in margin only governs *when the `in_progress` arrives*, so 60 min is comfortable without being so loose that a missed run goes uncaught past the next on-call shift change. |
| Max runtime | `45` minutes | The workflow's `timeout-minutes: 30` is the hard ceiling; 45 min gives Sentry slack so a healthy long-running restore (large dump, slow runner) doesn't trip a false `error` check-in. Anything longer than this means the runner hung mid-restore. |
| Failure issue threshold | `1` | Page on the first missed check-in — there is no "noisy" failure mode for "the weekly backup-verify job stopped running." A single missed week is already a real loss of coverage. |
| Recovery threshold | `1` | Resolve the issue as soon as the next check-in arrives — once the scheduler is back, we don't need to keep the page open. |
| Environment | `production` | The workflow always passes `--environment production`. |
| Owner / on-call | platform / data-resilience owners | So the page routes to whoever owns the restore drills. |

### Verifying the heartbeat

From the Sentry UI's monitor detail page, the timeline should show one
green check-in per Sunday. To end-to-end verify the page path without
waiting a full week:

1. Trigger an ad-hoc run via **Actions → Backup verify (weekly) → Run
   workflow** (the `workflow_dispatch:` entry point). Confirm a green
   check-in appears in the Sentry monitor timeline within a few minutes.
2. To rehearse the *missed check-in* page specifically, briefly disable
   the workflow (**Actions → Backup verify (weekly) → ⋯ → Disable
   workflow**) and wait for one cron tick + check-in margin (~Sunday
   03:00 UTC + 60 min). Sentry should fire a `backup-verify` cron
   `Missed check-in` issue. Re-enable the workflow once the page is
   confirmed.

## Required GitHub repo configuration

Configured under **Settings → Secrets and variables → Actions** on the
repo. The workflow degrades safely when these are missing — see inline
comments in `backup-verify.yml` for the matrix.

Variables (`vars.*`):

| Name | Production value | Purpose |
| --- | --- | --- |
| `BACKUP_VERIFY_ENABLED` | `1` | Kill switch. Set to anything else to silence the workflow without removing the file. **Note**: while disabled, the Sentry Cron monitor will start paging on missed check-ins — that is intentional. If you need to disable the workflow for a known reason (e.g. backup share migration), also temporarily mute the `backup-verify` Sentry monitor and set a calendar reminder to re-enable both. |
| `SENTRY_ORG`, `SENTRY_PROJECT` | (same as the release / healthz workflows) | Reused so events land in the same Sentry project as the api-server's runtime events. |

Secrets (`secrets.*`):

| Name | Purpose |
| --- | --- |
| `RESTORE_DATABASE_URL` | Sandbox DB URL the dump is restored into. **Must never** point at the live DB — `verifyBackup.ts` pg_restore's with `--clean --if-exists`, which would wipe whatever it points at. |
| `BACKUP_FETCH_CMD` | Shell snippet that downloads the latest dump into `./backups/<date>.dump`. Owned by the platform team because it embeds the backup-share credentials. |
| `BACKUP_VERIFY_SENTRY_DSN` | DSN that `sentry-cli monitors run` uses to post the cron-monitor check-ins. Usually the same DSN as the api-server's `SENTRY_DSN` so check-ins land in the same project; kept as a separate repo secret so it can be rotated independently of the runtime DSN. **Without this secret the heartbeat is silently disabled** — the workflow logs a `::warning::` and runs the verifier directly. Configure it to get coverage for "the job stopped running at all." |

Optional tuning env vars (set on the workflow step `env:`, not as repo
secrets — they're not sensitive):

| Name | Default | Purpose |
| --- | --- | --- |
| `MAX_DUMP_AGE_HOURS` | `36` | Newest `*.dump` in `BACKUP_DIR` must be at most this many hours old, otherwise exit 6. 36h gives one full nightly cycle of slack so a single missed nightly does not page, but two missed nightlies do. Lower it if you tighten the nightly cadence. |
| `REQUIRED_EXTENSIONS` | *(unset → check skipped)* | Comma-separated list of Postgres extensions that must be installed on the restored sandbox (e.g. `pgcrypto,pg_trgm`). When unset the extension check logs a notice and skips — set it once you know which extensions the production schema actually depends on. Mismatch → exit 9. |

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
   producer outage.
7. **Exit 7 (FK integrity)** — the restored data has orphan
   `payment_intents.order_id`, dangling `orders.user_id`, or dangling
   `payment_intents.user_id`. The dump is internally inconsistent. Pull
   the failing counts out of the step log (the `fail()` line lists
   exactly which join is broken) and:
   - If counts are small (< 100) and stable across reruns, this is
     likely a single bad migration that landed mid-`pg_dump` snapshot —
     re-fetch the next nightly and confirm it clears. File a ticket
     against the DB owner to investigate the source rows.
   - If counts grow week-over-week, a write path is creating rows that
     violate the join. **Do not** silence — page the DB owner.
8. **Exit 8 (audit chain broken)** — page the **audit / compliance
   owners**, not the platform team. Either the dump was corrupted in
   transit (re-fetch and re-checksum the dump file, then re-run; if the
   chain validates on the re-fetched copy, file a transport-corruption
   ticket against the platform team) OR an `audit_events` row was
   rewritten in place before the dump was taken — which by the
   append-only invariant in `artifacts/api-server/src/lib/audit.ts`
   should be impossible. The latter is a security incident: preserve
   the dump file, do not overwrite it, and follow the audit-tamper
   incident response (out of scope for this runbook).
9. **Exit 9 (missing extensions)** — the restored sandbox is missing one
   or more names from `REQUIRED_EXTENSIONS` (the `fail()` line lists
   them). Either install them on the sandbox (`CREATE EXTENSION ...`)
   and rerun, or fix the dump's extension preamble on the producer
   side. The data IS present in the sandbox but the production app
   will not boot against it, which is exactly the failure the restore
   drill is supposed to surface ahead of an actual recovery.

In all cases, **do not silence the workflow** as the recovery path —
the page is telling you the dump is bad, and silencing it will mask the
problem, not fix it.

## Backup verification stopped running

You're here because Sentry fired a `Missed check-in` on the
`backup-verify` monitor. The dumps may still be fine — the *scheduler*
is the problem. Until you fix it we have no signal that the dumps
remain restorable.

1. Open **GitHub → Actions → Backup verify (weekly)**. Look at the
   timeline:
   - **No runs in the last week** — the schedule was dropped. Continue
     to step 2.
   - **A run in the last week, but it was cancelled or never started a
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
   else, the job was being skipped on every tick (the Sentry monitor
   doesn't see check-ins when `if:` skips the job). Restore it to `1`.
4. Check that the workflow file still exists and parses. Run
   `gh workflow list` (or browse to **Actions** in the GitHub UI) and
   confirm `Backup verify (weekly)` is listed. If someone renamed or
   deleted `.github/workflows/backup-verify.yml`, restore it from git
   history.
5. Once the scheduler is healthy, trigger an ad-hoc run via
   **Run workflow** to (a) confirm the wiring end-to-end and (b) post
   a fresh `ok` check-in to Sentry so the missed-check-in issue
   auto-resolves. Do **not** mark the issue resolved manually before
   the workflow runs successfully — you'll lose the audit trail of
   when coverage was actually restored.

## Local invocation

Useful when iterating on the verifier itself or when reproducing a
pg_restore / FK / chain failure locally:

```sh
BACKUP_DIR=/tmp/backups \
RESTORE_DATABASE_URL='postgres://verify:verify@localhost:5432/sandbox' \
MAX_DUMP_AGE_HOURS=36 \
REQUIRED_EXTENSIONS=pgcrypto,pg_trgm \
  pnpm --filter @workspace/scripts exec tsx src/verifyBackup.ts
```

Same exit codes as the workflow. The script logs each check's verdict
on its own `[verifyBackup]` line so you can see at a glance which step
failed without scrolling back through the `pg_restore` output.

To rehearse each new failure mode against a local sandbox:

- **Exit 6 (stale dump):** `touch -d '3 days ago' /tmp/backups/old.dump`
  with no fresher file, then rerun.
- **Exit 7 (FK integrity):** after a successful run, `psql $RESTORE_DATABASE_URL
  -c "INSERT INTO payment_intents (id, user_id, purpose, gateway, reference,
  amount_minor, currency_code, order_id) VALUES ('pi_orphan', 'usr_x',
  'order', 'devmock', 'ref_orphan', 100, 'NGN', 'ord_does_not_exist');"`
  then rerun (it will re-restore over the row, so for the exit-7 rehearsal
  edit the dump or stage the bad row in the source DB before `pg_dump`).
- **Exit 8 (audit chain broken):** the chain triggers in
  `artifacts/api-server/src/lib/audit.ts` block UPDATE/DELETE on
  `audit_events` at the DB level, so you can only rehearse this by
  pre-tampering with a copy of the dump (e.g. `pg_restore` to a sandbox,
  drop the triggers, mutate one row's payload, re-`pg_dump`, then point
  the verifier at the tampered dump).
- **Exit 9 (missing extensions):** drop a known extension from the
  sandbox (`DROP EXTENSION pgcrypto`) before rerun.
