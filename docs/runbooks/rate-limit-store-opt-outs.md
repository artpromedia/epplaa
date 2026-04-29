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

## When an opted-out deploy graduates to Redis

Remove the opt-out env var on the deploy AND remove the row from this
file in the same change. Don't leave a dead row behind — the Sentry
alert relies on this file being a tight inventory, and a stale row
would mask a future misuse on the same hostname pattern.

If the deploy is being retired entirely (not migrated to Redis),
remove the row anyway and add a one-line note in the commit message
so the audit trail is preserved in `git log` even though the file
itself stays clean.
