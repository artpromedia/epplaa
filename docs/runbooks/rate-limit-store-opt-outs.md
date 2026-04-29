# Inventory: production deploys opted out of the rate-limit-store hard-fail

This file is the canonical list of production deploys that have set
`RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION=1` to bypass the boot-time
hard failure documented in
[`rate-limit-store.md`](./rate-limit-store.md) (Escape hatch for
legitimate single-replica production deploys).

If you set the opt-out env var on a deploy, **add it here in the same
change**. If a deploy emits the
`rate_limit_store_memory_in_production_via_opt_out` warn from a host
not listed below, the Sentry alert pages on-call instead of merely
notifying — so the inventory is what keeps the alert audit-quiet.

The opt-out is meant to be a known list of named deploys, not a quiet
steady stream of warns from random api-server hosts. Every entry here
is a commitment to wire Redis by the listed sunset date — if a deploy
needs to extend, update this file (with a fresh sunset and a one-line
"why extended" note) in the same change that extends the env var.

## Active opt-outs

| Deploy name | `HOSTNAME` (regex match) | Owner | Reason | Opted-out since | Expected sunset | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| _(none)_ | — | — | — | — | — | No production deploys are currently opted out. The first opted-out deploy must add a row here in the same change that sets `RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION=1` on the deploy. |

### Column definitions

- **Deploy name** — The human-readable name on-call uses to refer to
  the deploy (e.g. `api-canary`, `internal-admin-api`). Should match
  the platform's deploy slug where possible.
- **`HOSTNAME` (regex match)** — A regex that matches the container's
  `HOSTNAME` env var (the same value forwarded into the warn payload's
  `hostname` field). The Sentry alert below uses these patterns to
  decide whether a warn-emitting host is in the inventory. Anchor the
  pattern (`^…$`) and union multiple hosts for the same deploy with
  `|` (e.g. `^api-canary-[a-z0-9]+$`). Use a regex (not a literal)
  because container hostnames usually carry a generated suffix that
  changes on every redeploy.
- **Owner** — Team or individual on-call rotation accountable for
  removing the opt-out by the sunset date. Use a routable handle
  (Slack channel, email alias, on-call rotation name) rather than a
  person's name so it survives reorgs.
- **Reason** — One of: `canary`, `internal-tool`, or a short free-form
  explanation. The runbook only sanctions canary deploys and
  internal-only tools — anything else needs an explicit comment in
  the row explaining why a managed Redis isn't being wired instead.
- **Opted-out since** — ISO date the env var was first set on the
  deploy. Helps track how long a deploy has been on the bypassable
  bucket.
- **Expected sunset** — ISO date by which the opt-out should be
  removed (typically by wiring Redis or by retiring the deploy). If
  this date is in the past and the row is still here, the opt-out is
  overdue and on-call should escalate to the listed owner. The
  scheduled sweep below pages on overdue rows automatically — the
  honour system is no longer the only enforcement.
- **Notes** — Optional. Anything triage needs to know — replica count,
  traffic shape, why Redis hasn't been wired yet, links to follow-up
  work.

## How the Sentry alert uses this file

The api-server emits a structured `pino` warn keyed off the message
tag `rate_limit_store_memory_in_production_via_opt_out` on every boot
of an opted-out deploy. The structured payload includes the
container's `HOSTNAME` (as the `hostname` field) so the Sentry alert
can decide whether the warn is coming from a known opt-out deploy or
a host that should not have set the env var.

Two Sentry alert rules are wired off the same warn tag:

1. **Audit notification** — fires for every host on this list.
   Routed to the rate-limit owners channel as a notification (not a
   page). Used to confirm at a glance that the inventory matches
   what's actually emitting the warn.
2. **Page on unknown host** — fires for any host *not* matched by any
   row in this inventory. Routed to the rate-limit on-call rotation
   as a page. Treat it as a misuse: somebody set the opt-out env var
   on a deploy that wasn't sanctioned, and the abuse-prevention layer
   may now be silently bypassable on a multi-replica deploy.

See `docs/runbooks/rate-limit-store.md` (Wire alerts section) for the
exact Sentry rule wiring.

## Scheduled sunset sweep

A scheduled GitHub Actions workflow
([`.github/workflows/check-rate-limit-opt-out-sunsets.yml`](../../.github/workflows/check-rate-limit-opt-out-sunsets.yml))
parses the `Active opt-outs` table in this file once a day and exits
non-zero (which forwards a fatal-level Sentry event to on-call) when
any row's `Expected sunset` is in the past. The structured page body
names the offending deploy + owner so on-call can route the nudge
directly to the team that owns it without re-grepping the file.

The probe lives at
[`scripts/src/checkRateLimitOptOutSunsets.ts`](../../scripts/src/checkRateLimitOptOutSunsets.ts)
and can be run locally:

```sh
pnpm --filter @workspace/scripts run check-rate-limit-opt-out-sunsets
# Or pin a future date to rehearse the page condition:
TODAY=2030-01-01 pnpm --filter @workspace/scripts run check-rate-limit-opt-out-sunsets
```

| Aspect | Where it lives |
| --- | --- |
| Scheduler | GitHub Actions `schedule:` cron, daily at 13:00 UTC. |
| Probe command | `pnpm --filter @workspace/scripts run check-rate-limit-opt-out-sunsets` (the same CLI you can run locally). |
| Pager channel | On non-zero exit the workflow calls `sentry-cli send-event --level fatal --tag subsystem:rate_limit --tag alert:rate_limit_opt_out_sunset_overdue --fingerprint rate_limit_opt_out_sunset_overdue`. Sentry's default new-issue rule pages on fatal-level events. The fingerprint groups all daily ticks into a single Sentry issue per outstanding overdue row so on-call gets one page per incident, not one per cron tick. |
| Page body | The probe's JSON stdout line is forwarded as `extra.probe_output` so on-call sees `outcome`, `today`, the offending row's `deployName`, `owner`, `expectedSunset`, and `daysOverdue` without re-curling anything. The link to the failing GitHub Actions run is forwarded as `extra.workflow_run`. |
| Heartbeat (scheduler-itself failure) | The probe is wrapped with `sentry-cli monitors run check-rate-limit-opt-out-sunsets`, which posts an `in_progress` check-in at start and an `ok`/`error` check-in at finish to a Sentry Cron monitor with the slug `check-rate-limit-opt-out-sunsets`. Sentry pages on-call when an expected daily check-in fails to arrive — closing the same gap that the `check-healthz-degraded` heartbeat closes. |
| Backstop | Even with `secrets.OPT_OUT_SUNSET_SENTRY_DSN` unset, the workflow itself exits non-zero on any failing iteration, which triggers the standard GitHub "Failed workflow run" notification to repo watchers. |

Exit codes (also documented in the script header):

- `0` — no overdue rows (or the file is in its placeholder/empty
  state with no real opt-outs configured).
- `1` — probe error (file missing, malformed table, unparseable
  `Expected sunset`). The probe itself failed; a human should look
  rather than treat it as healthy.
- `2` — at least one row's `Expected sunset` is in the past. Page.

The probe is unit-covered in
[`scripts/src/checkRateLimitOptOutSunsets.test.ts`](../../scripts/src/checkRateLimitOptOutSunsets.test.ts)
(parser, decision matrix, and CLI entrypoint paths).

When an entry is added or extended in the table above, no separate
change is needed to keep the sweep working — it re-reads this file
on every run and trusts the table shape documented in the column
definitions. Schema changes (adding/removing/renaming a column)
require updating the parser and the matching test cases in the same
change so the probe doesn't silently start treating the new shape as
malformed.

## Auto-sync

The Sentry rules above used to be configured by hand: an operator
pasted the union of every `HOSTNAME (regex match)` row into each
rule's `hostname:` filter (positive `re` for the audit-notification
rule, negated `nre` for the page-on-unknown-host rule) in the same
change that adds a row to this file. The hand-paste was the single
point of failure in the alerting chain — if a canary deploy got a
new hostname suffix, or somebody updated this inventory but forgot
the Sentry rule, on-call got paged for a deploy that was actually
sanctioned (or, worse, a real misuse on a stale inventory hostname
got silently absorbed by the audit-notification rule).

The
[`sync-sentry-opt-out-audit-filter.yml`](../../.github/workflows/sync-sentry-opt-out-audit-filter.yml)
GitHub Actions workflow (task #108) closes that gap. It runs the
`scripts/src/syncSentryOptOutAuditFilter.ts` syncer in two modes:

- **PR-time check (`CHECK_ONLY=1`).** On every PR that changes this
  file, the workflow GETs both Sentry rules, computes the inventory
  union from this file using the same `parseInventoryTable` parser
  the sunset sweep uses, and fails the PR with exit 2 if either
  rule's `hostname:` filter `value` no longer matches. It never
  writes in this mode — it only flags drift so the author can re-run
  the auto-sync after merge (or update the rule in the Sentry UI
  themselves before re-pushing the PR).
- **Auto-sync (default mode).** On a push to `main` that touched
  this file (and on a daily schedule as a backstop), the workflow
  PUTs the inventory union into each rule's `hostname:` filter.
  Only the `hostname:` filter `value` is owned by the syncer —
  every other field on the rule (name, actions, owners, frequency,
  the filter's `id` / `match` / other fields, the rest of the
  filters and conditions arrays) is round-tripped verbatim from the
  GET response, so PagerDuty / Slack routing the operator added in
  the Sentry UI is preserved.

Operator implications:

1. **Adding / removing an opt-out is a one-step change.** Edit this
   file, open a PR. The PR-time check tells you whether the rules
   will need updating; the post-merge auto-sync does the update.
   You no longer hand-paste the union into the Sentry UI.
2. **The match mode (`re` vs `nre`) is checked, never auto-flipped.**
   A flipped mode is treated as a probe error (exit 1) and surfaced
   to the rate-limit owners — the syncer can't safely guess whether
   the audit rule should suddenly start paging or the page rule
   should go quiet. Fix it in the Sentry UI manually if it ever
   diverges.
3. **The empty-inventory state writes a sentinel.** When this file
   has no active opt-outs (only the `_(none)_` placeholder row),
   the syncer writes the regex `^__no_inventoried_opt_outs__$`
   (overridable via `EMPTY_INVENTORY_PLACEHOLDER`) into both rules'
   `hostname:` filter. Sentry's filter `value` field can't be
   blanked, and a stale union from a previous active state would
   silently rot in the rule, so the sentinel is the safest choice:
   the audit rule never fires (no inventoried hosts to audit) and
   the page rule fires for any warn-emitting host (which is the
   right outcome — somebody set the opt-out env var on a deploy
   that isn't on the inventory).
4. **The auto-sync workflow uses the same Sentry creds as the drift
   rehearsal**, plus `alerts:write` on the auth token. See the
   workflow file for the exact required `vars` / `secrets` list.

Local dry-run + check-only:

```sh
# Dry-run auto-sync against a real Sentry project — useful when
# verifying a planned inventory change before opening the PR.
SENTRY_ORG=epplaa SENTRY_PROJECT=api-server \
RATE_LIMIT_OPT_OUT_AUDIT_RULE_ID=… RATE_LIMIT_OPT_OUT_PAGE_RULE_ID=… \
SENTRY_AUTH_TOKEN=… DRY_RUN=1 \
  pnpm --filter @workspace/scripts run sync-sentry-opt-out-audit-filter

# Same, but in PR-style "fail loudly on drift, never write" mode.
… CHECK_ONLY=1 \
  pnpm --filter @workspace/scripts run sync-sentry-opt-out-audit-filter
```

The script's exit codes mirror `checkRateLimitOptOutSunsets.ts`:
`0 = in sync / synced / dry-run completed`, `1 = probe error
(missing config, parse failure, Sentry GET failure, missing or
flipped hostname filter)`, `2 = drift detected (CHECK_ONLY) or
PUT failed (auto-sync)`. Both `1` and `2` page on-call.

The auto-syncer is unit-covered in
`scripts/src/syncSentryOptOutAuditFilter.test.ts` (parser, hostname
filter location, decision matrix, GET / PUT request shape, full
end-to-end through `main()`).

## Responding to an overdue sunset page

When the daily sweep above pages on-call (Sentry alert
`alert:rate_limit_opt_out_sunset_overdue`, fingerprint
`rate_limit_opt_out_sunset_overdue`), the page body's
`extra.probe_output` JSON line names the offending row(s) verbatim:
`deployName`, `owner`, `expectedSunset`, and `daysOverdue`. Use that
to route, then pick one of the two responses below. Don't silence,
snooze, or reassign the Sentry issue without a corresponding inventory
change — the issue auto-resolves on the next clean daily run, so a
legitimate fix needs no extra Sentry click.

### Option A — extend the sunset (the deploy still legitimately needs
the opt-out)

Use this when Redis is in flight but not yet wired, the deploy is
scheduled for retirement on a known date, or another concrete
follow-up is in motion. "We haven't gotten to it" is **not** a valid
extension reason — open a follow-up issue and pick a real date.

1. Open a PR that, in the same commit:
   - Updates the row's `Expected sunset` cell to a new ISO date in
     the future. Keep the date short (typically 30–60 days out, never
     more than a quarter); the whole point of this inventory is that
     opt-outs don't sit forever.
   - Appends a one-line `why extended` note to the row's `Notes`
     cell, dated with today's ISO date. Example:
     `2026-04-29: extended +30d, Redis cluster provisioned, wiring PR #1234`.
     Don't overwrite previous extension notes — append, so the audit
     trail of how many times this row has been extended stays in the
     file.
2. Self-review: if this is the **third or more** extension on the
   same row, escalate to the row's owner team's lead instead of just
   merging. Repeated extensions usually mean the underlying Redis
   wiring isn't actually being prioritised, and quietly extending
   again hides that from leadership. Note the escalation in the PR
   description.
3. Merge the PR. The next daily sweep (≤24h) will see the new
   sunset and exit 0; the existing Sentry issue auto-resolves on
   that clean run. If you want immediate confirmation, trigger
   `check-rate-limit-opt-out-sunsets` via `workflow_dispatch:` and
   verify the run is green before walking away.

### Option B — remove the opt-out (Redis is wired or the deploy is
gone)

Follow [_When an opted-out deploy graduates to Redis_](#when-an-opted-out-deploy-graduates-to-redis)
below. Same expectation: drop the env var on the deploy AND delete
the row in the same change so the next sweep run goes green.

### Acknowledging the page

The Sentry issue's status is the source of truth for whether the
incident is being worked, not a chat ack. Acknowledge by:

1. **In Sentry**: assign the issue to yourself (or the on-call
   engineer who's actually picking it up) so a parallel responder
   doesn't double-up. Don't change the status to `resolved`
   manually — see step 3.
2. **In the inventory**: open the PR for option A or B above
   within the same on-call shift. Link the PR back from the Sentry
   issue's comments so a later auditor can trace the fix from the
   page.
3. **After the fix merges**: leave the Sentry issue alone. The
   probe's fingerprint reuses the same Sentry issue across every
   daily tick, so the next clean run (exit 0) auto-resolves it. A
   manual `resolved` click before the inventory PR merges is the
   one thing not to do — the next morning's tick will reopen the
   same issue and the audit trail looks like the page bounced
   instead of being acted on.

If the page is a false positive (probe bug, inventory schema drift
that the parser misread, etc.), exit code 1 (`probe_error`) fires a
distinct Sentry path that does **not** use the
`rate_limit_opt_out_sunset_overdue` fingerprint — so the page body
will say `outcome: probe_error`, not `outcome: overdue`. Treat that
as a probe-side bug to fix in `scripts/src/checkRateLimitOptOutSunsets.ts`,
not a deploy-side incident.

## PR-time inventory check

The
[`check-rate-limit-opt-out-pr-inventory.yml`](../../.github/workflows/check-rate-limit-opt-out-pr-inventory.yml)
GitHub Actions workflow runs on every pull request to `main` and
**fails the PR** when a deploy-config file in the same PR newly sets
`RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION="1"` inside a
`[services.production.*.env]` table without an accompanying edit to
this inventory file.

Why it exists (task #116): until this gate shipped, the only thing
that caught the failure mode "operator set the opt-out env var on a
deploy but forgot to add a row here" was the runtime
page-on-unknown-host Sentry rule wired in task #93 — i.e. the deploy
ships, the warn fires from the new host, the page-on-unknown-host
rule matches (because this inventory is missing the row), and on-call
gets paged for what is in fact a sanctioned deploy whose author just
forgot to do the paperwork. The
[Drift rehearsal](#drift-rehearsal) section below catches the
*inverse* case (inventory edited but Sentry rule's hand-pasted regex
union not refreshed) but it does NOT catch the "env var changed in
deploy config without a corresponding inventory row" case at PR
review time. This gate shifts that failure from a runtime page to a
CI failure the author can fix before merging.

The probe lives at
[`scripts/src/checkRateLimitOptOutPrInventory.ts`](../../scripts/src/checkRateLimitOptOutPrInventory.ts)
and can be run locally to verify a planned change before it ships:

```sh
BASE_REF=origin/main \
  pnpm --filter @workspace/scripts run check-rate-limit-opt-out-pr-inventory
```

Exit codes (also documented in the script header):

- `0` — ok. Either no deploy config was touched in the PR, or every
  touched deploy is in a state that doesn't require an inventory edit
  (already opted in at BASE, or no longer opted in at HEAD).
- `1` — probe error (git command failed, a touched file couldn't be
  read, etc.). The probe itself failed; a human should look rather
  than treat it as healthy.
- `2` — fail. At least one touched deploy config newly sets
  `RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION="1"` AND this
  inventory file was NOT edited in the same PR.

| Aspect | Where it lives |
| --- | --- |
| Trigger | GitHub Actions on every `pull_request` to `main`. |
| Probe command | `pnpm --filter @workspace/scripts run check-rate-limit-opt-out-pr-inventory` (the same CLI you can run locally). |
| Kill switch | Repo variable `vars.RATE_LIMIT_OPT_OUT_PR_CHECK_ENABLED`. The job is gated on this equalling `"1"`; when unset (or any other value) the workflow no-ops on every PR. Use this if the deploy-config layout drifts in a way the scanner can no longer parse and the gate would start producing false positives. Re-enable as soon as the parser is updated. |
| Pass-through cases (NOT flagged) | (1) PR removes the env var, or sets it to anything other than `"1"`. (2) PR touches a deploy config but the env var was already `"1"` at BASE and is still `"1"` at HEAD (i.e. some other env in the same file changed). (3) PR removes the env var AND removes the inventory row in the same change — the inventory file IS touched, so the gate trivially passes. |
| Failure remediation | Add a row to the `Active opt-outs` table above naming the deploy, an anchored hostname regex, the owner, the reason, the opted-out-since date, and an expected sunset. Push the row in the same PR as the env-var change and the gate flips green. |

### How to legitimately silence the gate

There are two sanctioned ways to silence this gate. Both are
auditable through their normal channels (a repo-variable change
shows up in the GitHub audit log; a paired inventory edit shows up
in the PR diff itself).

1. **Edit the inventory in the same PR.** This is the canonical
   path: any edit to
   `docs/runbooks/rate-limit-store-opt-outs.md` flips the gate
   green. The "graduating off opt-out" workflow (remove the env var
   from the deploy AND remove the inventory row in the same PR) is
   the textbook example — the inventory file is touched as part of
   the row removal, so the gate passes naturally with no extra
   ceremony.
2. **Toggle the repo-variable kill switch.** Set
   `vars.RATE_LIMIT_OPT_OUT_PR_CHECK_ENABLED` to anything other
   than `"1"` in
   *Settings -> Secrets and variables -> Actions -> Variables*. The
   workflow is gated on `if: vars.RATE_LIMIT_OPT_OUT_PR_CHECK_ENABLED == '1'`,
   so flipping the variable disables the gate on every PR until it
   is set back to `"1"`. Use this only when the deploy-config
   layout has drifted in a way the scanner can no longer parse and
   the gate is producing false positives — log the rationale in
   the PR that motivated the toggle and re-enable as soon as the
   parser is updated.

If you find yourself reaching for the kill switch for any other
reason, you are likely either (a) trying to ship an opt-out without
the audit row this inventory exists to keep — don't, or (b) hitting
a real bug in the scanner — file an issue and patch
`scripts/src/checkRateLimitOptOutPrInventory.ts` instead of disabling
the gate.

The gate itself is unit-covered in
[`scripts/src/checkRateLimitOptOutPrInventory.test.ts`](../../scripts/src/checkRateLimitOptOutPrInventory.test.ts)
(scanner edge cases, decision matrix, and the CLI entrypoint paths
including missing-BASE_REF, git-failure, no-deploys-touched,
newly-opted-in-without-inventory-edit, newly-opted-in-with-inventory-edit,
already-opted-in, graduating-off-opt-out, newly-added-deploy-config,
and the `DEPLOY_CONFIG_PATHS` override).

## Drift rehearsal

The auto-sync workflow above is the proactive guard. The drift
rehearsal below is the defence-in-depth one — it catches the case
where auto-sync was paused, mis-credentialed, or somebody hand-
edited a rule in the Sentry UI between syncs.

The
[`rehearse-rate-limit-opt-out-inventory.yml`](../../.github/workflows/rehearse-rate-limit-opt-out-inventory.yml)
weekly GitHub Actions workflow detects that drift before a real
opt-out warn fires. It runs every Sunday off-peak (a few minutes
after the existing weekly
[`rehearse-healthz-degraded.yml`](../../.github/workflows/rehearse-healthz-degraded.yml)
rehearsal), fetches both Sentry rules via the rules API, and asserts
that:

- The set of regex alternatives in each rule's `hostname:` filter
  equals the set computed from this file's `HOSTNAME (regex match)`
  column (order-insensitive, dedupe-aware, splitting on top-level
  `|` so a row that unions multiple hostnames-for-one-deploy
  contributes each alternative).
- The audit-notification rule's match mode is `re` and the page-
  on-unknown-host rule's match mode is `nre` — a flipped mode would
  silently page on every sanctioned canary boot.
- The inventory file parses cleanly (no malformed table, no row
  with an empty hostname cell).

A drift fails the job with exit code 2 and forwards a fatal-level
event to Sentry tagged
`alert:rate_limit_opt_out_inventory_drift`, which the rate-limit
owners' Sentry rule pages on. A probe error (file read failure,
Sentry API error, malformed rule body) fails with exit code 1 and
forwards an error-level event tagged
`alert:rate_limit_opt_out_inventory_probe_error` so a broken
rehearsal isn't silently swallowed.

The probe itself lives in
`artifacts/api-server/src/scripts/checkRateLimitOptOutInventoryDrift.ts`
and can be run locally to verify a planned change before it ships:

```sh
INVENTORY_PATH=docs/runbooks/rate-limit-store-opt-outs.md \
SENTRY_RULES_PATH=/path/to/sentry-rules.json \
  pnpm --filter @workspace/api-server run check-rate-limit-opt-out-inventory-drift
```

The `sentry-rules.json` file shape is
`{ "rules": [{ "name", "expectedMatchMode", "rule": <Sentry rule body> }, …] }`
— the workflow builds it from the Sentry API response; for an
ad-hoc local check you can construct it by hand from the same API
or by exporting the rules from the Sentry UI.

When this rehearsal pages, fix the drift in the same change:

1. Open both Sentry rules and the inventory file side-by-side.
2. Decide which side is correct — usually the inventory is the
   source of truth and the Sentry filter is stale (e.g. the
   auto-sync workflow above was paused or had its credentials
   rotated, or somebody hand-edited the rule in the Sentry UI).
   The fast path is to re-trigger the auto-sync workflow via
   `workflow_dispatch:` on
   [`sync-sentry-opt-out-audit-filter.yml`](../../.github/workflows/sync-sentry-opt-out-audit-filter.yml);
   if that's blocked, hand-paste the union of every `HOSTNAME
   (regex match)` cell, joined with `|`, into each rule's
   `hostname:` filter `value` field. Keep the audit rule on
   `match: re` and the page rule on `match: nre`.
3. Re-run this workflow via `workflow_dispatch:` and confirm it
   exits 0 (in_sync) before resolving the Sentry issue.

## When an opted-out deploy graduates to Redis

Remove the opt-out env var on the deploy AND remove the row from this
file in the same change. Don't leave a dead row behind — the Sentry
alert relies on this file being a tight inventory, and a stale row
would mask a future misuse on the same hostname pattern.

If the deploy is being retired entirely (not migrated to Redis),
remove the row anyway and add a one-line note in the commit message
so the audit trail is preserved in `git log` even though the file
itself stays clean.
