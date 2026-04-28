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

## Step 1 — Verify the bucket store kind on a running replica

The `/healthz` endpoint reports the backend the live replica is using:

```sh
curl -s "$REPL_API_URL/api/healthz" | jq .
# { "status": "ok", "rateLimitStore": "redis" }
```

For each replica behind the load balancer, hit `/healthz` until you
have seen all of them respond. Any replica reporting `"memory"` while
the rest report `"redis"` is misconfigured — its `RATE_LIMIT_STORE`
env var was not set, so it has its own per-process bucket and is
trivially bypassable by sending traffic only to that replica.

If you have container shell access:

```sh
echo "RATE_LIMIT_STORE=$RATE_LIMIT_STORE  REDIS_URL=${REDIS_URL:0:24}…"
```

(`REDIS_URL` is truncated so credentials never end up in chat or
ticket bodies.)

## Step 2 — Confirm Redis reachability

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
