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
