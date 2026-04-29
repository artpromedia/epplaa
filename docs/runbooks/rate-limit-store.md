# Runbook: API rate-limit store

The api-server applies per-route + per-identity rate limits in
`artifacts/api-server/src/middlewares/apiRateLimit.ts`. The bucket
backend is selected at boot by the `RATE_LIMIT_STORE` env var:

| Value          | Backend         | When to use                                    |
| -------------- | --------------- | ---------------------------------------------- |
| unset / `memory` | In-process map | Single api-server replica only                 |
| `redis`        | `RedisStore`    | Required for >1 replica (shared sliding window) |

When `RATE_LIMIT_STORE=redis`, `REDIS_URL` must also be set or the
process crashes at boot.

## Symptom: alert from Sentry

You will see one of these:

- Issue `rate_limit_redis_failure_threshold_breached` (level: fatal,
  tag `subsystem=rate_limit`, tag `alert=rate_limit_store_degraded`).
  Fires when the Redis store fails more than
  `RATE_LIMIT_REDIS_FAILURE_ALERT_PER_MIN` times (default 5) within a
  rolling 60-second window. Throttled to one event per
  `RATE_LIMIT_REDIS_FAILURE_ALERT_COOLDOWN_MS` (default 60s).

- Issues tagged `subsystem=rate_limit, kind=rate_limit_redis_bump_failed`
  or `kind=rate_limit_redis_client_error`. Each is forwarded one-per-
  failure via `captureException`. Configure a Sentry alert rule on
  `tags.subsystem == "rate_limit"` if you want a custom rate threshold.

While this alert is firing the Redis store is degrading **open** —
requests are allowed through with no rate limit. Treat it as urgent
because the api is effectively unprotected from abuse.

## Step 1 — Hit `/readyz` first

The `/readyz` endpoint is the primary verification step. It returns
**200** only when this replica's backing dependencies (DB and, when
configured, Redis) are reachable. It returns **503** with a JSON body
listing which dependency failed when something is broken — the
platform load balancer drains 503-returning replicas automatically,
so a replica whose Redis has gone unreachable will fall out of
rotation without human intervention.

```sh
curl -s "$REPL_API_URL/api/readyz" | jq .
# Healthy:
#   { "status": "ready",
#     "checks": { "db": "ok", "redis": "ok" },
#     "rateLimitStore": "redis" }
#
# Unhealthy (503):
#   { "status": "not_ready",
#     "checks": { "db": "ok", "redis": "failed" },
#     "failures": { "redis": "redis_ping_timeout_after_2000ms" },
#     "rateLimitStore": "redis" }
```

Hit `/readyz` against each replica until you have seen all of them
respond. Any replica returning 503 with `redis: "failed"` is
degrading open on rate-limit decisions — every request that lands
there is unrate-limited until either the replica is drained or Redis
recovers. The `failures.redis` string is the underlying Redis error
(or a `redis_ping_timeout_after_*ms` marker when the ping exceeded
`READYZ_REDIS_TIMEOUT_MS`, default 2s).

`/healthz` remains the **liveness** probe — it is intentionally cheap
and always returns 200 with `{ status, rateLimitStore }` so the
platform doesn't restart replicas during transient Redis blips. Use
it to confirm the configured rate-limit backend kind on a replica:

```sh
curl -s "$REPL_API_URL/api/healthz" | jq .
# { "status": "ok", "rateLimitStore": "redis" }
```

Any replica reporting `"memory"` while the rest report `"redis"` is
misconfigured — its `RATE_LIMIT_STORE` env var was not set, so it has
its own per-process bucket and is trivially bypassable by sending
traffic only to that replica.

If you have container shell access:

```sh
echo "RATE_LIMIT_STORE=$RATE_LIMIT_STORE  REDIS_URL=${REDIS_URL:0:24}…"
```

(`REDIS_URL` is truncated so credentials never end up in chat or
ticket bodies.)

## Step 2 — Confirm Redis reachability directly

If `/readyz` reports `redis: "failed"`, confirm with `redis-cli` from
a host that can reach the same Redis endpoint:

```sh
redis-cli -u "$REDIS_URL" PING
# PONG
```

If `PING` fails, the rate limiter is degrading open — fix Redis
connectivity (network, password rotation, TLS cert) before debugging
further. The `rate_limit_redis_client_error` events in Sentry will
have the underlying error message.

## Step 3 — Inspect the buckets

The store keys look like `api:{tier}:{method}:{path}:{identity}` and
are sorted sets keyed by hit timestamp:

```sh
redis-cli -u "$REDIS_URL" --scan --pattern 'api:*' | head
redis-cli -u "$REDIS_URL" ZCARD 'api:anon:GET:/products:ip:1.2.3.4'
```

If `ZCARD` returns 0 across the board even though the api is taking
real traffic, the Lua script is failing — check the
`rate_limit_redis_bump_failed` events in Sentry for the exception
message (most often `NOSCRIPT` after a failover, which the next
`EVAL` call will recover from automatically).

## Step 4 — Tuning the alert

Both knobs are env vars on the api-server deployment:

- `RATE_LIMIT_REDIS_FAILURE_ALERT_PER_MIN` — threshold for the rolled-up
  fatal alert. Lower it during incidents to make the alert more
  sensitive; raise it if a flaky downstream is creating noise.
- `RATE_LIMIT_REDIS_FAILURE_ALERT_COOLDOWN_MS` — minimum gap between
  fatal breach events. Default 60s.

Per-failure events keep flowing to Sentry regardless, so a Sentry
issue alert on `tags.subsystem == "rate_limit"` is always available
as a finer-grained channel.

## Step 5 — Stuck-degraded duration alert (`checkHealthzDegraded`)

The Sentry alert above fires on failure **rate** — >N failures per
rolling minute. It deliberately misses a slow trickle of failures
that keeps a watcher in `degraded` for many minutes without ever
crossing the per-minute threshold. To catch that case we ship a tiny
probe that pages on streak **duration** instead, by walking
`/healthz`'s `subsystems` map and exiting non-zero when **any**
subsystem's `now - firstFailureAt` exceeds a threshold.

The `subsystems` map currently exposes:

- `rateLimitStore` — fed by the Redis rate-limit failure watcher.
- `db` — fed by the `/readyz` Postgres ping (every readiness probe
  call counts as a heartbeat). A DB pool that's been intermittently
  unreachable for > threshold pages on-call without any extra
  background polling.

New subsystems (audit chain queue, payment-gateway circuit breakers,
…) can be added by creating a `SubsystemFailureWatcher` instance and
including its snapshot in the map; the probe will pick them up
automatically.

The page reason names the offending subsystem (e.g. `db degraded for
540123ms (> threshold 300000ms)`) so on-call doesn't have to re-curl
`/healthz` to know where to start digging. When more than one
subsystem is page-worthy at the same time, the reason lists every
offender so a correlated outage is visible at a glance.

### How it's wired in production

The probe is run by a GitHub Actions cron workflow defined in
[`.github/workflows/check-healthz-degraded.yml`](../../.github/workflows/check-healthz-degraded.yml).
It is the canonical production scheduler for this alert — there is no
external uptime monitor or in-process timer doing this job.

| Aspect | Where it lives |
| --- | --- |
| Scheduler | GitHub Actions `schedule:` cron, every 5 minutes |
| Per-iteration cadence | 5 inner iterations × 60s sleep ≈ **once per minute** end-to-end. GH Actions cron has a 5-minute minimum, so the inner loop is what gets us to per-minute resolution without paying for an external uptime monitor. |
| Probe command | `pnpm --filter @workspace/api-server run check-healthz-degraded` (the same CLI you can run locally) |
| Pager channel | On non-zero exit each iteration calls `sentry-cli send-event --level fatal --tag subsystem:rate_limit --tag alert:rate_limit_store_stuck_degraded --fingerprint rate_limit_store_stuck_degraded`. Sentry's default new-issue rule pages on fatal-level events. The fingerprint groups all five iterations into a single Sentry issue per outage so on-call gets one page, not five. |
| Page body | The probe's JSON stdout line is forwarded as `extra.probe_output` so on-call sees `state`, `firstFailureAt`, `durationMs`, `thresholdMs`, and the probe's reason without re-curling `/healthz`. The link to the failing GitHub Actions run is forwarded as `extra.workflow_run`. |
| Real-time chat heads-up | Optional. When `secrets.HEALTHZ_PROBE_NOTIFY_WEBHOOK` is set, the probe loop posts a `:rotating_light: page FIRING on <subsystem> (streak <durationMs> > threshold <thresholdMs>)` message to the configured Slack/Teams webhook on the *first* iteration in a run that exits 2, and a matching `:white_check_mark: page RESOLVED` message on the first subsequent iteration in the same run that returns to exit 0. The Sentry pager path is the canonical alerting channel for on-call; this post exists so #ops sees the incident in real time without waiting for someone to re-broadcast the Sentry issue. Mirrors the rehearsal workflow's chat heads-up so on-call can tell rehearsal blips from real pages by the message text (`REHEARSAL` vs `FIRING/RESOLVED`). Probe-host errors (exit 1) are deliberately *not* posted to chat — they're not api outages and would only confuse #ops; the GitHub failed-workflow-run notification still covers them. |
| Backstop | Even with `HEALTHZ_PROBE_SENTRY_DSN` unset, the workflow itself exits non-zero on any failing iteration, which triggers the standard GitHub "Failed workflow run" notification to repo watchers. |

#### Interpreting the chat heads-up

| Observation | What it means | What to do |
| --- | --- | --- |
| `:rotating_light: page FIRING on <subsystem> (streak <durationMs> > threshold <thresholdMs>)` post in `${HEALTHZ_PROBE_NOTIFY_CHANNEL}` | A real (non-rehearsal) iteration of the per-minute probe just exited 2 — i.e. `<subsystem>` has been in `state=degraded` for longer than the streak threshold and Sentry has been paged for on-call. The chat post is purely informational so #ops sees the incident without waiting for a Sentry re-broadcast. | Confirm on-call has acknowledged the matching `rate_limit_store_stuck_degraded` Sentry issue; coordinate triage in-thread. Walk the rest of this runbook starting at Step 1 for the named subsystem. |
| `:white_check_mark: page RESOLVED` post in the same thread/channel | A subsequent iteration in the *same* workflow run returned to exit 0 — the probe sees the subsystem as healthy again. This is per-run only; cross-run recovery (this run all-green after a previous run paged) is intentionally silent and Sentry's auto-resolve is the source of truth across runs. | Cross-check `/healthz` and the Sentry issue before fully closing the incident — a subsystem can flap healthy briefly and re-degrade. |
| `::warning::notify webhook returned HTTP <code>` in the workflow log AND no chat post in `${HEALTHZ_PROBE_NOTIFY_CHANNEL}` while the run still failed via Sentry | The chat path is broken (rotated webhook URL, archived destination channel, Slack/Teams rate-limiting). The Sentry pager is unaffected — on-call still got the page — but #ops won't see the next real outage in real time until the webhook is fixed. Same failure modes as the rehearsal `Notify chat …` steps. | Slack: re-issue the incoming webhook from the app's *Incoming Webhooks* config and update `secrets.HEALTHZ_PROBE_NOTIFY_WEBHOOK`. Teams: rebuild the workflow trigger URL and update the secret. To verify without waiting for a real outage, trigger `Rehearse stuck-degraded page` via `workflow_dispatch:` — its chat path uses the same webhook pattern. |
| Workflow ran red (Sentry page fired) but no chat post AND no webhook warning | `secrets.HEALTHZ_PROBE_NOTIFY_WEBHOOK` is unset — the chat path is disabled by design. | If you want #ops in the loop, configure the secret per the table above. |

### Heartbeat — paging when the scheduler itself stops running

The streak-duration alert above only fires when a scheduled run *executes*
and observes a stuck-degraded subsystem. It will **not** fire if the
scheduler itself stops running — for example:

- GitHub Actions has an outage or queueing backlog.
- The workflow is silently auto-disabled (GitHub auto-disables scheduled
  workflows after 60 days of inactivity, which can happen if
  `HEALTHZ_PROBE_ENABLED` is flipped off temporarily and forgotten).
- The schedule is silently delayed for hours under load.
- Someone deletes/renames the workflow file or breaks the YAML.

In any of those cases the rate-limit watcher could be stuck in `degraded`
indefinitely with no automatic page. To close that gap the workflow's
probe loop is wrapped with `sentry-cli monitors run`, which posts an
`in_progress` check-in at start and an `ok`/`error` check-in at finish
to a **Sentry Cron monitor** with the slug `check-healthz-degraded`.
Sentry pages on-call automatically when an expected check-in fails to
arrive within the monitor's check-in margin — i.e. when the scheduler
*itself* fails to execute on time, regardless of whether the underlying
api is healthy.

**Distinguishing the two pages.** When the wrapped probe runs and
detects a stuck-degraded subsystem, on-call gets the
`rate_limit_store_stuck_degraded` Sentry issue (subsystem fingerprint;
"the rate-limit store is stuck"). When the wrapped probe *doesn't run
at all*, on-call gets a Sentry Cron monitor failure on
`check-healthz-degraded` ("our stuck-detection job stopped running").
The two pages have different titles/fingerprints by design, so on-call
knows which runbook section to start from.

**One-time Sentry setup.** Configure the monitor in the Sentry UI
(**Crons → Add Monitor**) with these values; check-ins from the
workflow lazily upsert the monitor on first run, but explicit
configuration ensures the schedule + margins are correct from the
first tick:

| Setting | Value | Why |
| --- | --- | --- |
| Slug | `check-healthz-degraded` | Must match the slug in the workflow's `sentry-cli monitors run …` invocation. |
| Schedule type | Crontab | Mirrors the GH Actions `schedule:` cadence. |
| Schedule | `*/5 * * * *` | Same cron expression as the GH Actions schedule, so Sentry expects exactly one check-in per scheduled tick. |
| Timezone | `UTC` | GH Actions schedules run in UTC. |
| Check-in margin | `5` minutes | Generous enough to absorb runner queue time + the workflow's own ~30s install/boot. Tighten only if you're prepared to chase noise from cold-start runners. |
| Max runtime | `10` minutes | The probe loop's `timeout-minutes: 8` gives this slack; anything longer means the runner hung mid-loop. |
| Failure issue threshold | `1` | Page on the first missed check-in — there is no "noisy" failure mode for "the scheduler stopped running." |
| Recovery threshold | `1` | Resolve the issue as soon as the next check-in arrives. |
| Environment | `production` | The workflow always passes `--environment production`. |
| Owner / on-call | api-server / rate-limit owners | So the page routes to the same on-call as the streak-duration alert. |

**Verifying the heartbeat.** From the Sentry UI's monitor detail page,
the timeline should show one green check-in per 5 minutes. To
end-to-end verify the page path, briefly disable the workflow
(**Actions → Healthz degraded probe → ⋯ → Disable workflow**) and wait
for one cron tick + check-in margin (~10 minutes total). Sentry should
fire a `check-healthz-degraded` cron failure issue. Re-enable the
workflow once the page is confirmed.

### Required GitHub repo configuration

Configured under **Settings → Secrets and variables → Actions** on the
repo. The workflow degrades safely when these are missing — see
inline comments in `check-healthz-degraded.yml` for the matrix.

Variables (`vars.*`):

| Name | Production value | Purpose |
| --- | --- | --- |
| `HEALTHZ_PROBE_ENABLED` | `1` | Kill switch. Set to anything else to silence the workflow without removing the file. |
| `HEALTHZ_URL` | `https://<production-api-host>/api/healthz` (e.g. the value of `REPL_API_URL` in production + `/api/healthz`) | The real `/healthz` URL the probe hits. Set this — the probe exits 1 with a clear stderr line if it's missing. |
| `HEALTHZ_DEGRADED_ALERT_THRESHOLD_MS` | `300000` (5 min) | Streak duration that pages. Defaults to 5 min if unset. Lower it (e.g. `120000`) during incidents to make the alert more sensitive; raise it if a flaky downstream is creating noise. |
| `HEALTHZ_PROBE_TIMEOUT_MS` | `5000` | Per-request fetch timeout. Defaults to 5s if unset. |
| `SENTRY_ORG`, `SENTRY_PROJECT` | (same as the release workflow) | Reused so events land in the same Sentry project as the api-server's runtime events. |

Secrets (`secrets.*`):

| Name | Purpose |
| --- | --- |
| `HEALTHZ_PROBE_SENTRY_DSN` | DSN that `sentry-cli send-event` uses to ingest the page event. Usually the same DSN as the api-server's `SENTRY_DSN` so the alert lands in the same project; kept as a separate repo secret so it can be rotated independently of the runtime DSN. |
| `HEALTHZ_PROBE_NOTIFY_WEBHOOK` | Optional. Slack incoming webhook URL or Teams workflow webhook URL. When set, the probe posts a `:rotating_light: page FIRING` message to chat the first time an iteration in a run exits 2 (page), and a `:white_check_mark: page RESOLVED` message the first time a subsequent iteration in the same run goes back to exit 0. Mirrors the rehearsal workflow's `HEALTHZ_REHEARSAL_NOTIFY_WEBHOOK`. Leave unset to disable the chat heads-up entirely — the Sentry pager path is unaffected. The URL itself is the credential, hence `secret` not `var`. |

Variables (chat heads-up):

| Name | Production value | Purpose |
| --- | --- | --- |
| `HEALTHZ_PROBE_NOTIFY_CHANNEL` | `#ops` (default) | Cosmetic channel label included in the chat message and the workflow log so the destination is obvious without inspecting the webhook URL. The actual routing is determined by the webhook URL, not by this value. |

### Probe exit codes

The workflow treats any non-zero exit as actionable and pages. The
codes are kept distinct so log triage can tell them apart:

| Code | Meaning                                                       |
| ---- | ------------------------------------------------------------- |
| 0    | Every subsystem is healthy, OR at least one is degraded but no streak exceeds the threshold |
| 1    | Probe error (network failure, non-2xx, malformed body, missing `HEALTHZ_URL`) — the probe itself failed; investigate the probe host before assuming the api is broken |
| 2    | **Page**: at least one subsystem `state=degraded` and streak duration > threshold (or the response shape regressed in a way that prevents evaluation) |

The probe writes a single JSON line to stdout (or stderr on probe
error) describing what it observed — include that line verbatim in
the page body so on-call sees the offending subsystem, streak
duration, threshold, and `firstFailureAt` without re-curling
`/healthz`. The line includes a `subsystem` field naming the worst
offender and a `subsystems` array with the per-subsystem evaluation
detail. The cron step forwards that line verbatim into the Sentry
event's `extra.probe_output` so the page body is self-contained.

Tunable env vars (probe-side; same names whether you're invoking the
CLI manually or via the cron workflow):

- `HEALTHZ_URL` — **required**, full URL to `/api/healthz`.
- `HEALTHZ_DEGRADED_ALERT_THRESHOLD_MS` — streak duration that
  triggers a page. Default `300000` (5 minutes). A missing,
  non-numeric, zero, or negative value falls back to the default
  rather than producing a flapping zero-ms threshold.
- `HEALTHZ_PROBE_TIMEOUT_MS` — fetch timeout for `/healthz`. Default
  `5000`. Same sanitisation as above.

Set the threshold based on how long you'd tolerate the rate limiter
degrading open before paging — 5 minutes is a reasonable starting
point that won't fire on a transient blip but will catch a Redis
endpoint that's been intermittently failing for a non-trivial window.

### Verifying the wiring end-to-end

You can dry-run the workflow without waiting for the next cron tick:

1. Open **Actions → Healthz degraded probe (per-minute) → Run workflow**
   in GitHub. This invokes the `workflow_dispatch:` entry point.
2. Watch the run logs — each iteration prints its probe JSON line,
   and any non-zero exit prints `::error::probe iteration N exited C`.
3. To rehearse a real page without breaking production, temporarily
   point `vars.HEALTHZ_URL` at a staging `/healthz` whose
   `rateLimitStore.firstFailureAt` is older than the threshold (or
   override `vars.HEALTHZ_DEGRADED_ALERT_THRESHOLD_MS` to a tiny
   value like `1` so the next degraded blip pages). Restore the
   value after the dry run.

### Local invocation

Same script, same exit codes — useful when iterating on the probe
itself or when reproducing a page locally:

```sh
HEALTHZ_URL="$REPL_API_URL/api/healthz" \
HEALTHZ_DEGRADED_ALERT_THRESHOLD_MS=300000 \
  pnpm --filter @workspace/api-server run check-healthz-degraded
```

This probe is complementary to the Sentry rate-based alert in Step
4 — keep both wired up. The Sentry alert catches cliff-edge outages
quickly; this probe catches slow burns the rate alert can miss.

> Prefer the automated rehearsal in the next subsection over the
> manual `vars.*` flip - it does inject + probe + Sentry verification
> + cleanup in a single workflow and won't leave staging in a
> synthetic degraded state if you get distracted halfway through.

### Automated weekly rehearsal (`rehearse-healthz-degraded.yml`)

The manual dry-run above is fine for one-off checks but doesn't run
on a cadence - so a regression in any link of the alerting chain
(Sentry rule disabled, fingerprint stops deduping, PII scrubber
ate the probe JSON, GitHub failure-notification channel rotated)
would only surface during a real outage. To catch those before they
hide an incident, a separate workflow rehearses the full
inject -> probe -> Sentry pager path against staging on a weekly
schedule.

| Aspect | Where it lives |
| --- | --- |
| Workflow file | [`.github/workflows/rehearse-healthz-degraded.yml`](../../.github/workflows/rehearse-healthz-degraded.yml) |
| Cadence | Sundays 04:17 UTC, plus `workflow_dispatch:` for ad-hoc verification |
| Subsystem coverage | Both subsystems exposed by `/healthz`'s `subsystems` map are rehearsed on the same weekly schedule as separate matrix entries: `rateLimitStore` (fingerprint `rate_limit_store_stuck_degraded_rehearsal`, alert tag `rate_limit_store_stuck_degraded`, subsystem tag `rate_limit`) and `db` (fingerprint `stuck_degraded_rehearsal_db`, alert tag `db_stuck_degraded`, subsystem tag `db`). Each entry asserts the same inject -> probe -> verify -> clear cycle independently against its own subsystem, with its own per-subsystem fingerprint, so a regression in one subsystem's pager wiring (Sentry rule disabled, fingerprint renamed, on-call routing drifted, probe's per-subsystem JSON shape regressed) can't be masked by the other still working. The matrix entries are serialised (`max-parallel: 1`) so each one observes a clean staging state — the probe's "worst offender" pick would otherwise flake non-deterministically when both subsystems are stuck simultaneously. `fail-fast: false` means a `db` regression doesn't suppress the `rateLimitStore` signal (and vice versa). |
| Synthetic injector | The api-server exposes guarded `/api/_rehearsal/inject-stuck-degraded` and `/api/_rehearsal/clear-stuck-degraded` endpoints that flip `RedisFailureWatcher` or `dbHealthWatcher` (chosen by the request body's `subsystem` field — `rateLimitStore` or `db`) into a synthetic `degraded` state with a caller-supplied `firstFailureAt`. Source: `artifacts/api-server/src/routes/healthzRehearsal.ts`. The endpoints return 404 unless `HEALTHZ_REHEARSAL_ENABLED=1` is set on the staging api-server, and additionally require an `X-Rehearsal-Token` header that timing-safely matches `HEALTHZ_REHEARSAL_TOKEN`. **Enable both env vars on staging only - never production.** |
| Probe invocation | The same `pnpm --filter @workspace/api-server run check-healthz-degraded` CLI used in production, pointed at staging via `HEALTHZ_URL`. Asserts exit code is exactly `2` and the JSON line contains `subsystem: <THIS matrix entry's subsystem>`, `outcome: page`, and `durationMs > threshold`. |
| Sentry forward | Five `sentry-cli send-event` calls per matrix entry, all sharing that entry's per-subsystem fingerprint. Tagged `rehearsal:1`, `rehearsal_subsystem:<rateLimitStore|db>`, `rehearsal_run_id:<workflow-run-id>-<subsystem>`, plus the entry's `alert:` and `subsystem:` tag values from the matrix definition. The events go to a dedicated `alerts-rehearsal` Sentry project (`HEALTHZ_REHEARSAL_SENTRY_DSN`) so the production Sentry project stays clean. |
| Sentry verification | Polls `https://sentry.io/api/0/organizations/<org>/events/?query=rehearsal_run_id:<id>` for up to 3 minutes and asserts (a) at least one event arrived for *this* run+subsystem (the unique `rehearsal_run_id` tag — which includes the subsystem suffix — is what makes that assertion safe across overlapping runs and across the two matrix entries), (b) the alert / subsystem / rehearsal tags survived ingestion with THIS entry's expected values (so we'd notice if Sentry's PII scrubber started stripping them OR if the production tag values for one subsystem silently drifted), and (c) the 5 sent events collapsed into exactly 1 issue per matrix entry (so we'd notice if the per-subsystem fingerprint deduplication broke). |
| Cleanup | A final `if: ${{ always() }}` step POSTs to `clear-stuck-degraded` with THIS matrix entry's subsystem so even a mid-run failure restores that subsystem on staging to healthy. If that cleanup itself fails, the job fails loudly (and names the offending subsystem in the error) so on-call resets the watcher manually instead of leaving staging stuck-degraded forever (which would otherwise cause the per-minute probe workflow above to start paging on-call for real). |
| Failure semantics | Any non-zero step exits the matrix entry non-zero, which triggers GitHub's standard "Failed workflow run" notification. That itself doubles as an end-to-end check that the failure-notification channel still reaches the right operators - if the rehearsal job is *failing* on a Monday morning and nobody noticed, the GitHub-failure path is broken and that's its own actionable signal. With `fail-fast: false`, both matrix entries always run so the notification names the specific failing subsystem. |

**Required GitHub configuration** (Settings -> Secrets and variables -> Actions):

| Name | Kind | Purpose |
| --- | --- | --- |
| `HEALTHZ_REHEARSAL_ENABLED` | var | Kill switch. Set to `1` to opt in; anything else skips the workflow. |
| `HEALTHZ_REHEARSAL_STAGING_BASE_URL` | var | Base URL of staging api (e.g. `https://api.staging.epplaa.com`). The workflow appends `/api/_rehearsal/*` and `/api/healthz`. |
| `HEALTHZ_REHEARSAL_THRESHOLD_MS` | var (optional) | Threshold the probe is invoked with. Defaults to `60000` (1 min) - a 10-min synthetic streak comfortably trips it. |
| `HEALTHZ_REHEARSAL_INJECT_DURATION_MS` | var (optional) | How far in the past to stamp `firstFailureAt`. Defaults to `600000` (10 min). |
| `HEALTHZ_REHEARSAL_SENTRY_ORG` | var | Sentry org slug used by the verification API call. |
| `HEALTHZ_REHEARSAL_SENTRY_PROJECT` | var | Sentry project SLUG (not numeric ID) used by the verification API call. Should be a dedicated `alerts-rehearsal` project. |
| `HEALTHZ_REHEARSAL_TOKEN` | secret | Bearer token forwarded as `X-Rehearsal-Token`. Must match staging api-server's `HEALTHZ_REHEARSAL_TOKEN` env var. |
| `HEALTHZ_REHEARSAL_SENTRY_DSN` | secret | DSN sentry-cli posts the rehearsal event to. Point at the dedicated `alerts-rehearsal` project. |
| `HEALTHZ_REHEARSAL_SENTRY_AUTH_TOKEN` | secret | Sentry auth token with `event:read` scope on the rehearsal project. Used by the verification step to poll the events API. |
| `HEALTHZ_REHEARSAL_NOTIFY_WEBHOOK` | secret (optional) | Slack incoming webhook URL or Teams workflow webhook URL. The workflow POSTs a `{"text": ...}` payload (compatible with both) before injecting the synthetic streak ("rehearsal STARTING") and again after cleanup ("rehearsal PASSED/FAILED"). Leave unset to skip the chat heads-up entirely — same degrade-safe pattern as the Sentry config above. The URL is itself the credential, hence `secret` not `var`. |
| `HEALTHZ_REHEARSAL_NOTIFY_CHANNEL` | var (optional) | Cosmetic channel label (e.g. `#ops`) included in the chat message and the workflow log so the destination is obvious without inspecting the webhook URL. Defaults to `#ops`. The actual routing is determined by the webhook URL, not by this value. |

**Required staging api-server env vars** (set ONLY on staging, never production):

- `HEALTHZ_REHEARSAL_ENABLED=1`
- `HEALTHZ_REHEARSAL_TOKEN=<long random secret matching the GitHub secret above>`

> **Boot-time guard.** As a defense-in-depth backstop to the
> "staging only" rule above, the api-server entrypoint
> (`artifacts/api-server/src/index.ts`) refuses to start when
> `HEALTHZ_REHEARSAL_ENABLED=1` is observed alongside *any* signal
> that the deploy is reachable as production. The check
> (`assertRehearsalKillSwitchSafe` in
> `artifacts/api-server/src/routes/healthzRehearsal.ts`) logs
> `healthz_rehearsal_kill_switch_on_in_production` and exits 1 before
> binding the listener, so a copy-paste of staging env vars into a
> production deploy crash-loops loudly in platform health checks
> instead of silently exposing `/api/_rehearsal/inject-stuck-degraded`.
>
> The kill switch trips when **any** of the following production
> signals are observed alongside `HEALTHZ_REHEARSAL_ENABLED=1`:
>
> | Signal | Why it's checked |
> | --- | --- |
> | `NODE_ENV=production` | Original signal — the conventional Node.js production marker. |
> | `REPLIT_DEPLOYMENT=1` | Set by the Replit platform on production deployments (vs. dev workspaces). Catches a deploy that runs with `NODE_ENV` unset or "staging" but is being served as a real Replit production deployment. The check matches the literal string `"1"` only — `"true"`, `"yes"`, etc. do **not** trip it. |
> | `DEPLOYMENT_ENVIRONMENT=production` | Generic deployment-env env var that some IaC/CD stacks set independently of `NODE_ENV`. Set this on production deploys for an extra backstop that survives `NODE_ENV` drift. The check matches the literal lowercase string `"production"` only — `"Production"`, `"PROD"`, `"prod"`, `"prd"`, etc. do **not** trip it (mirrors how the conventional `NODE_ENV=production` value is also lowercase). If your CD stack writes a different casing, normalise it to lowercase `"production"` at the deploy layer. |
> | `HOSTNAME` matches `PRODUCTION_HOSTNAME_PATTERN` | Operator-configured regex matched against the container's `HOSTNAME`. The strongest backstop: even if every other env var is wrong, a deploy whose hostname is the real production host (e.g. `api.epplaa.com`) will refuse to boot. |
>
> **Configuring the production-hostname pattern.** Set
> `PRODUCTION_HOSTNAME_PATTERN` on the production api-server deploy to
> a regex that matches the production container's `HOSTNAME` (and
> nothing on staging). For the canonical Epplaa production host this
> is:
>
> ```sh
> PRODUCTION_HOSTNAME_PATTERN='^api\.epplaa\.com$'
> ```
>
> Anchor the pattern (`^…$`) so a partial match on a staging hostname
> like `api.epplaa.com.staging.internal` doesn't accidentally trip
> the guard on staging. Multiple production hosts can be unioned with
> `|` (e.g. `^(api|api-eu|api-apac)\.epplaa\.com$`). The pattern is
> read once at boot. An invalid regex logs
> `healthz_rehearsal_invalid_hostname_pattern` and silently disables
> the hostname check (so a typo doesn't crash an otherwise-correct
> production boot — the other signals still fire).
>
> **Boot-time presence check (task #84).** Because the hostname signal
> is silently disabled when no operator ever set
> `PRODUCTION_HOSTNAME_PATTERN`, the api-server entrypoint also runs
> `assertProductionHostnamePatternConfigured` (in
> `artifacts/api-server/src/routes/healthzRehearsal.ts`) on every
> boot. When a production-shaped deploy is detected (any of
> `NODE_ENV=production`, `REPLIT_DEPLOYMENT=1`,
> `DEPLOYMENT_ENVIRONMENT=production`) but `PRODUCTION_HOSTNAME_PATTERN`
> is unset/empty, the api-server logs a warning identified by the
> message tag `production_hostname_pattern_missing` and continues
> booting. This is intentionally a warning rather than a hard fail so
> existing production deploys that haven't yet been rotated to
> include the pattern don't crash-loop on the first restart after the
> change ships. **Wire a Sentry / log-aggregator alert on the
> `production_hostname_pattern_missing` message tag**, route it to the
> rate-limit owners, and treat it as a misconfigured-deploy
> remediation: set `PRODUCTION_HOSTNAME_PATTERN` on the offending
> deploy and restart. The structured log payload includes
> `production_signals` (which signals tripped the production-shape
> detection), `node_env`, `hostname`, `replit_deployment`, and
> `deployment_environment` so triage can confirm the misconfiguration
> without shelling onto the box. The healthy boot logs nothing — a
> production deploy with the pattern set produces zero output from
> this check, so the alert can fire on first occurrence without
> tuning. The check is unit-covered in
> `artifacts/api-server/src/routes/healthzRehearsal.test.ts`
> (`assertProductionHostnamePatternConfigured —` describe block).
>
> **If you see this error in a production crash log,** unset
> `HEALTHZ_REHEARSAL_ENABLED` on that deploy and restart — do **not**
> work around it by setting `NODE_ENV` to something other than
> `production`, or by unsetting `REPLIT_DEPLOYMENT` /
> `DEPLOYMENT_ENVIRONMENT` / `PRODUCTION_HOSTNAME_PATTERN`. Those
> signals exist precisely to catch the case where one of them has
> been misconfigured; weakening them defeats the backstop.

### Interpreting a failed rehearsal run

When the rehearsal workflow fails, walk the steps top-down:

| Failing step | Likely cause | Where to look |
| --- | --- | --- |
| `Verify required config is present` | One of the GitHub vars/secrets above is missing or got wiped during a Sentry/Slack rotation. | Repo Settings -> Secrets and variables -> Actions. |
| `Notify chat that rehearsal is starting` / `Notify chat with rehearsal result` | These steps are gated on `secrets.HEALTHZ_REHEARSAL_NOTIFY_WEBHOOK` and run with `continue-on-error: true`, so they surface as a yellow warning rather than failing the rehearsal — the rest of the job will still run. A non-2xx response usually means (a) the webhook URL was rotated or revoked in Slack/Teams (most common — Slack invalidates incoming webhooks when the parent app is reinstalled, Teams workflow webhooks expire on a schedule), (b) the destination channel was archived/deleted, or (c) Slack/Teams is rate-limiting the workflow. The `result` notify failing on its own is still actionable: the next real outage's pre-announce won't reach `${HEALTHZ_REHEARSAL_NOTIFY_CHANNEL}` and on-call may misread the synthetic blip as real. The HTTP status + response body are logged in the step output. | Slack: re-issue the incoming webhook from the app's *Incoming Webhooks* config and update `secrets.HEALTHZ_REHEARSAL_NOTIFY_WEBHOOK`. Teams: rebuild the workflow trigger URL from *Workflows -> When a Teams webhook request is received* and update the secret. To rehearse the chat path itself without waiting for next Sunday, trigger the workflow via `workflow_dispatch:`. |
| `Inject synthetic stuck-degraded streak` | Staging api-server is down, or `HEALTHZ_REHEARSAL_ENABLED=1` is no longer set on staging, or the token rotated and the secret + env var drifted. A 404 means the kill switch is off (or staging redeployed without the env). A 401 means the token mismatch. A 503 means the env var is set but the token is missing on the server side. | Hit `/api/_rehearsal/inject-stuck-degraded` from your shell with the staging token to reproduce. |
| `Run probe and assert it pages` | The `/healthz` schema regressed (e.g. `subsystems` map removed), the probe binary in this branch is broken, or the inject didn't actually take effect (likely because staging restarted between inject and probe - the watcher is in-process). Check the printed probe JSON for the actual `subsystem` / `outcome` / `durationMs` values. | `artifacts/api-server/src/scripts/checkHealthzDegraded.ts` and `artifacts/api-server/src/routes/health.ts`. |
| `Forward 5 page events to the rehearsal Sentry project` | `HEALTHZ_REHEARSAL_SENTRY_DSN` is wrong/expired, or the rehearsal project was deleted/renamed. | Sentry dashboard -> alerts-rehearsal project settings -> Client Keys (DSN). |
| `Verify Sentry ingested the rehearsal events` | (a) Sentry is dropping/scrubbing events - check the Sentry stats page for the rehearsal project. (b) The `event:read` scope is missing on the auth token. (c) **Fingerprint dedup broken**: if the failure message says "expected ... 1 issue, saw 5", the per-subsystem fingerprint stopped collapsing iterations - verify nothing renamed `rate_limit_store_stuck_degraded_rehearsal` (rateLimitStore matrix entry) or `stuck_degraded_rehearsal_db` (db matrix entry), and that no new Sentry inbound filter or processor is forcing per-event grouping. The failing matrix entry's job name names the subsystem so you know which fingerprint to check. (d) **Tag stripped**: if the failure says "ingested event tags mismatched", Sentry's PII scrubber or a new `Tag Filter` rule is dropping `alert` / `subsystem` / `rehearsal` — or the expected per-subsystem tag values for the failing matrix entry have drifted from the production pager rule. The on-call page body for production would also be missing those tags. (e) **probe_output stripped**: if the failure says "event ... has no probe_output extra", Sentry's PII scrubber or a project rule is stripping the `--extra probe_output` payload. The on-call page body is composed FROM that extra (the probe JSON line with subsystem / streak duration / threshold / firstFailureAt), so production pages would arrive with no actionable detail. | Sentry project settings -> Data Scrubbing AND Alerts -> Issue alerts in the rehearsal project. The matched event/issue ID is surfaced in the workflow run summary so you can open the offending event directly. |
| `Clear synthetic streak` | Staging is unreachable. Manually POST `clear-stuck-degraded` with the subsystem named in the failing matrix entry's job (`rateLimitStore` or `db`) before leaving - otherwise the per-minute probe workflow against staging will start paging for real for that subsystem. The `if: always()` guard means this step runs even if everything before it failed; if **this** step is the failure, the synthetic streak for THIS matrix entry's subsystem is still live on staging. | Re-run with the same token from your shell, e.g. `curl -X POST .../clear-stuck-degraded -H "X-Rehearsal-Token: $TOKEN" --data '{"subsystem":"db"}'`. |

### Daily rehearsal-notify-webhook liveness probe (`probe-rehearsal-notify-webhook.yml`)

The weekly rehearsal's two `Notify chat ...` steps run with
`continue-on-error: true` so a broken webhook can't block the
rehearsal itself. That is the right tradeoff for the rehearsal --
but it leaves a detection gap: a webhook URL that gets rotated on,
say, Monday isn't observed until the *following* Sunday's rehearsal
goes to post and silently 404s, by which point on-call has lost up
to ~7 days of chat heads-ups. The yellow-warning step hides in the
weekly run summary and is easy to miss.

To shorten that window from ~7 days to ~24h, a separate workflow
([`.github/workflows/probe-rehearsal-notify-webhook.yml`](../../.github/workflows/probe-rehearsal-notify-webhook.yml))
runs daily at 16:23 UTC and quietly verifies the webhook is still
accepting requests, *without* posting a real message into the
destination channel.

| Aspect | Where it lives |
| --- | --- |
| Workflow file | [`.github/workflows/probe-rehearsal-notify-webhook.yml`](../../.github/workflows/probe-rehearsal-notify-webhook.yml) |
| Cadence | Daily at 16:23 UTC, plus `workflow_dispatch:` for ad-hoc verification (e.g. immediately after rotating the webhook URL) |
| What it sends | A single HTTP `GET` against `secrets.HEALTHZ_REHEARSAL_NOTIFY_WEBHOOK`. A `GET` is used deliberately so no real message is posted to the destination channel -- Slack/Teams treat *any* `POST` as a real chat message regardless of body. |
| How it interprets the response | Slack incoming webhooks AND Teams workflow webhooks both return `405 Method Not Allowed` for `GET` against a *valid* URL. So `200`/`204`/`405` = alive (probe passes); `404`/`410` = the URL was rotated/revoked (Slack: `no_service` body after a webhook is revoked; Teams returns `404` once the workflow trigger expires); `401`/`403` = embedded credential rejected; `5xx` or curl-level network/DNS/TLS error = transient or platform problem. Anything other than alive fails the probe and pages. |
| Pager channel | On a non-alive response the workflow exits non-zero. With `secrets.HEALTHZ_PROBE_SENTRY_DSN` configured (recommended -- the probe reuses the same DSN as the per-minute `check-healthz-degraded` workflow so the page lands in the same on-call routing), it also calls `sentry-cli send-event --level fatal --tag subsystem:rehearsal_notify --tag alert:rehearsal_notify_webhook_dead --fingerprint rehearsal_notify_webhook_dead`. The fingerprint groups repeated daily failures (the webhook stays broken until someone fixes it) into a single Sentry issue so on-call gets one page, not one per daily run. |
| Page body | The probe's JSON line (`{outcome, reason, channel, http_code, curl_exit}`) is forwarded as `extra.probe_output`, the truncated platform response body as `extra.response_body`, and the workflow run URL as `extra.workflow_run`. On-call sees the failing channel + HTTP code + Slack/Teams error string without re-curling anything. |
| Backstop | Even with `HEALTHZ_PROBE_SENTRY_DSN` unset, the workflow itself exits non-zero on a non-alive response, which triggers GitHub's standard "Failed workflow run" notification to repo watchers. |
| Heartbeat | The probe is wrapped with `sentry-cli monitors run probe-rehearsal-notify-webhook`, identical pattern to `check-healthz-degraded`. A Sentry Cron monitor with slug `probe-rehearsal-notify-webhook` (configured in the Sentry UI -- daily schedule, generous check-in margin) pages on missed check-ins, which is the only signal that survives the workflow being silently disabled / GH Actions outages / schedule drift. |
| Kill switch | Reuses `vars.HEALTHZ_REHEARSAL_ENABLED` -- toggling the rehearsal off also silences this probe (otherwise we'd page daily about a webhook that nothing is trying to use). |
| Degrade-safe gating | If `secrets.HEALTHZ_REHEARSAL_NOTIFY_WEBHOOK` itself is unset, the job logs a warning and exits 0 -- if the rehearsal isn't configured to post chat heads-ups, there's nothing to liveness-probe and we shouldn't be permanently red. |

**Required Sentry Cron monitor configuration** (one-time, Sentry UI
-> **Crons -> Add Monitor**). Same shape as the
`check-healthz-degraded` monitor in the table earlier; only the
slug, schedule, and runtime/margin differ:

| Setting | Value | Why |
| --- | --- | --- |
| Slug | `probe-rehearsal-notify-webhook` | Must match the slug in the workflow's `sentry-cli monitors run ...` invocation. |
| Schedule type | Crontab | Mirrors the GH Actions `schedule:` cadence. |
| Schedule | `23 16 * * *` | Same cron expression as the GH Actions schedule, so Sentry expects exactly one check-in per day. |
| Timezone | `UTC` | GH Actions schedules run in UTC. |
| Check-in margin | `30` minutes | Generous enough to absorb runner queue time and tolerate the daily tick slipping a bit. The probe itself completes in seconds, so the only realistic delay source is GH Actions scheduling. |
| Max runtime | `5` minutes | The workflow's `timeout-minutes: 5` mirrors this; anything longer means the runner hung. |
| Failure issue threshold | `1` | Page on the first missed daily check-in -- there's no "noisy" failure mode for "the daily probe stopped running." |
| Recovery threshold | `1` | Resolve the issue as soon as the next daily check-in arrives. |
| Environment | `production` | The workflow always passes `--environment production`. |
| Owner / on-call | api-server / rate-limit owners | Same on-call as the rest of this alerting chain so a webhook rotation surfaces in the same channel as the per-minute probe and the weekly rehearsal. |

#### Interpreting a failed daily probe

When this workflow fires the `rehearsal_notify_webhook_dead`
Sentry issue (or the GitHub failed-run notification when Sentry
forwarding isn't configured), the page body's `extra.probe_output`
JSON line tells you which class of failure it is. Map the HTTP
code to the fix:

| HTTP code | Likely cause | Fix |
| --- | --- | --- |
| `404` | The webhook URL was rotated or revoked. Slack invalidates incoming webhooks when the parent app is reinstalled, uninstalled, or the channel the webhook posts to is deleted/archived. Teams workflow trigger URLs expire on their own schedule. The Slack response body is usually `no_service`. | **Slack:** open the workspace's *Apps -> [your app] -> Incoming Webhooks*, re-issue the webhook for the same channel, and update `secrets.HEALTHZ_REHEARSAL_NOTIFY_WEBHOOK`. **Teams:** open *Workflows -> When a Teams webhook request is received*, regenerate the trigger URL, and update the secret. Then trigger this workflow via `workflow_dispatch:` to confirm the new URL is alive without waiting until tomorrow. |
| `410` | The platform explicitly retired the URL (rare; usually only after extended inactivity or an explicit revocation). | Same as `404`. |
| `401` / `403` | The URL is reachable but the embedded credential is no longer accepted. Most often happens when the Slack workspace tightens app permissions or the Teams workflow's identity is revoked. | Re-issue the webhook the same way as for `404`/`410`. Don't try to "fix" the credential on the URL itself -- Slack/Teams treat the URL as a single opaque secret. |
| `5xx` | Slack/Teams platform error. Usually transient. | Wait for the next daily tick; if it repeats, check the platform's status page. The page fingerprint dedupes repeated days into one issue, so the page won't get noisier if the platform has a multi-day outage. |
| `0` (curl-level failure) | DNS / TLS / network issue from the GitHub Actions runner. Almost always transient. | Wait for the next daily tick. If it repeats with a stable curl error code (visible in the page body's `curl_exit` field), and the platform's own status page is green, the URL may have moved hosts -- re-issue the webhook to be safe. |
| Anything else | Unexpected response. The page body's `response_body` extra is truncated to 512 bytes for the first half-kilobyte of context. | Hit the URL with `curl -i -X GET "$HEALTHZ_REHEARSAL_NOTIFY_WEBHOOK"` from a trusted shell to see the full response, then decide whether to re-issue the webhook or escalate to the platform. |

After fixing the webhook, trigger the workflow manually
(**Actions -> Probe rehearsal notify webhook (daily) -> Run
workflow**) to confirm it now reports green; that also resolves the
Sentry issue automatically on the next successful check-in.

If the page is the Sentry Cron monitor itself firing
(`probe-rehearsal-notify-webhook` *missed check-in*) rather than the
`rehearsal_notify_webhook_dead` issue, the workflow itself stopped
running -- check **Actions -> Probe rehearsal notify webhook (daily)**
to confirm the workflow isn't disabled, and look for GH Actions
incidents. This is the same shape of page as the
`check-healthz-degraded` cron-monitor failure described earlier in
this document.
