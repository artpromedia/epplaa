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
  overdue and on-call should escalate to the listed owner.
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

## When an opted-out deploy graduates to Redis

Remove the opt-out env var on the deploy AND remove the row from this
file in the same change. Don't leave a dead row behind — the Sentry
alert relies on this file being a tight inventory, and a stale row
would mask a future misuse on the same hostname pattern.

If the deploy is being retired entirely (not migrated to Redis),
remove the row anyway and add a one-line note in the commit message
so the audit trail is preserved in `git log` even though the file
itself stays clean.
