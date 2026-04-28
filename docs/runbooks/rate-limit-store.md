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
| Backstop | Even with `HEALTHZ_PROBE_SENTRY_DSN` unset, the workflow itself exits non-zero on any failing iteration, which triggers the standard GitHub "Failed workflow run" notification to repo watchers. |

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
| Synthetic injector | The api-server exposes guarded `/api/_rehearsal/inject-stuck-degraded` and `/api/_rehearsal/clear-stuck-degraded` endpoints that flip `RedisFailureWatcher` (or `dbHealthWatcher`) into a synthetic `degraded` state with a caller-supplied `firstFailureAt`. Source: `artifacts/api-server/src/routes/healthzRehearsal.ts`. The endpoints return 404 unless `HEALTHZ_REHEARSAL_ENABLED=1` is set on the staging api-server, and additionally require an `X-Rehearsal-Token` header that timing-safely matches `HEALTHZ_REHEARSAL_TOKEN`. **Enable both env vars on staging only - never production.** |
| Probe invocation | The same `pnpm --filter @workspace/api-server run check-healthz-degraded` CLI used in production, pointed at staging via `HEALTHZ_URL`. Asserts exit code is exactly `2` and the JSON line contains `subsystem: rateLimitStore`, `outcome: page`, and `durationMs > threshold`. |
| Sentry forward | Five `sentry-cli send-event` calls with the same fingerprint, tagged `rehearsal:1`, `rehearsal_run_id:<workflow-run-id>`, `alert:rate_limit_store_stuck_degraded`, `subsystem:rate_limit`. The events go to a dedicated `alerts-rehearsal` Sentry project (`HEALTHZ_REHEARSAL_SENTRY_DSN`) so the production Sentry project stays clean. |
| Sentry verification | Polls `https://sentry.io/api/0/organizations/<org>/events/?query=rehearsal_run_id:<id>` for up to 3 minutes and asserts (a) at least one event arrived for *this* run (the unique `rehearsal_run_id` tag is what makes that assertion safe across overlapping runs), (b) the alert / subsystem / rehearsal tags survived ingestion (so we'd notice if Sentry's PII scrubber started stripping them), and (c) the 5 sent events collapsed into exactly 1 issue (so we'd notice if the fingerprint deduplication broke). |
| Cleanup | A final `if: ${{ always() }}` step POSTs to `clear-stuck-degraded` so even a mid-run failure restores staging to healthy. If that cleanup itself fails, the job fails loudly so on-call resets the watcher manually instead of leaving staging stuck-degraded forever (which would otherwise cause the per-minute probe workflow above to start paging on-call for real). |
| Failure semantics | Any non-zero step exits the workflow non-zero, which triggers GitHub's standard "Failed workflow run" notification. That itself doubles as an end-to-end check that the failure-notification channel still reaches the right operators - if the rehearsal job is *failing* on a Monday morning and nobody noticed, the GitHub-failure path is broken and that's its own actionable signal. |

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

**Required staging api-server env vars** (set ONLY on staging, never production):

- `HEALTHZ_REHEARSAL_ENABLED=1`
- `HEALTHZ_REHEARSAL_TOKEN=<long random secret matching the GitHub secret above>`

### Interpreting a failed rehearsal run

When the rehearsal workflow fails, walk the steps top-down:

| Failing step | Likely cause | Where to look |
| --- | --- | --- |
| `Verify required config is present` | One of the GitHub vars/secrets above is missing or got wiped during a Sentry/Slack rotation. | Repo Settings -> Secrets and variables -> Actions. |
| `Inject synthetic stuck-degraded streak` | Staging api-server is down, or `HEALTHZ_REHEARSAL_ENABLED=1` is no longer set on staging, or the token rotated and the secret + env var drifted. A 404 means the kill switch is off (or staging redeployed without the env). A 401 means the token mismatch. A 503 means the env var is set but the token is missing on the server side. | Hit `/api/_rehearsal/inject-stuck-degraded` from your shell with the staging token to reproduce. |
| `Run probe and assert it pages` | The `/healthz` schema regressed (e.g. `subsystems` map removed), the probe binary in this branch is broken, or the inject didn't actually take effect (likely because staging restarted between inject and probe - the watcher is in-process). Check the printed probe JSON for the actual `subsystem` / `outcome` / `durationMs` values. | `artifacts/api-server/src/scripts/checkHealthzDegraded.ts` and `artifacts/api-server/src/routes/health.ts`. |
| `Forward 5 page events to the rehearsal Sentry project` | `HEALTHZ_REHEARSAL_SENTRY_DSN` is wrong/expired, or the rehearsal project was deleted/renamed. | Sentry dashboard -> alerts-rehearsal project settings -> Client Keys (DSN). |
| `Verify Sentry ingested the rehearsal events` | (a) Sentry is dropping/scrubbing events - check the Sentry stats page for the rehearsal project. (b) The `event:read` scope is missing on the auth token. (c) **Fingerprint dedup broken**: if the failure message says "expected ... 1 issue, saw 5", the fingerprint stopped collapsing iterations - verify nothing renamed `--fingerprint rate_limit_store_stuck_degraded_rehearsal` and that no new Sentry inbound filter or processor is forcing per-event grouping. (d) **Tag stripped**: if the failure says "ingested event tags mismatched", Sentry's PII scrubber or a new `Tag Filter` rule is dropping `alert` / `subsystem` / `rehearsal`. The on-call page body for production would also be missing those tags. (e) **probe_output stripped**: if the failure says "event ... has no probe_output extra", Sentry's PII scrubber or a project rule is stripping the `--extra probe_output` payload. The on-call page body is composed FROM that extra (the probe JSON line with subsystem / streak duration / threshold / firstFailureAt), so production pages would arrive with no actionable detail. | Sentry project settings -> Data Scrubbing AND Alerts -> Issue alerts in the rehearsal project. The matched event/issue ID is surfaced in the workflow run summary so you can open the offending event directly. |
| `Clear synthetic streak` | Staging is unreachable. Manually POST `clear-stuck-degraded` (see endpoint shape above) before leaving - otherwise the per-minute probe workflow against staging will start paging for real. The `if: always()` guard means this step runs even if everything before it failed; if **this** step is the failure, the synthetic streak is still live on staging. | Re-run with the same token from your shell. |
