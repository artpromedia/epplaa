# Runbook: optional `/readyz` dependency probes

The api-server's `/readyz` endpoint always probes the two dependencies
that are required to serve any request — Postgres (DB) and, when
configured, the rate-limit Redis. See
[`rate-limit-store.md`](./rate-limit-store.md) for those.

This runbook covers the **optional** per-dependency probes shipped in
task #91: Clerk (auth) and the configured payment gateway base URLs
(Paystack, Flutterwave). Each is gated behind its own env flag so they
default off — coupling readyz to a flaky third party would cause
cascading drains across all replicas the moment that third party
hiccupped, which is more disruptive than the marginal "drain on
unhealthy" benefit.

When a probe is enabled, its result surfaces under the same JSON shape
as the existing DB / Redis checks:

```json
{
  "status": "ready",
  "checks": {
    "db": "ok",
    "redis": "ok",
    "clerk": "ok",
    "paystack": "ok",
    "flutterwave": "skipped"
  },
  "rateLimitStore": "redis",
  "config": {
    "productionHostnamePattern": "configured",
    "dependencyProbes": {
      "clerk":       { "enabled": true,  "url": "https://api.clerk.com",       "timeoutMs": 2000 },
      "paystack":    { "enabled": true,  "url": "https://api.paystack.co",     "timeoutMs": 2000 },
      "flutterwave": { "enabled": false, "url": "https://api.flutterwave.com", "timeoutMs": 2000 }
    }
  }
}
```

When a probe fails, the route returns 503 with `failures.<name>` set to
the underlying network error (or `http_probe_timeout_after_<n>ms` when
the per-probe timeout fired) — the platform load balancer will drain
the replica until either the dependency recovers or the operator
disables the probe.

## Probe semantics

Each probe issues `GET <url>` with `redirect: "manual"` and
`cache: "no-store"` and returns:

| Outcome | What it means |
| --- | --- |
| `<name>: "ok"` | The HTTP request completed with **any** status code (200 / 401 / 404 are all "the gateway is reachable"). |
| `<name>: "failed"` | `fetch` threw (DNS, TCP refused, TLS error) or the per-probe timeout fired. The error message is in `failures.<name>`. |
| `<name>: "skipped"` | The probe is disabled — its `READYZ_PROBE_<NAME>` env flag is not set to the literal `"1"`. |

A probe is intentionally a connectivity check, not a contract check —
we don't pin against a specific status code or endpoint shape because
the providers' root paths return different things over time and we
don't want a docs-page redirect or a 401 from a hardened endpoint to
fail readyz.

## Configuration

Each probe has three env vars: a strict on/off flag, an optional URL
override, and an optional per-probe timeout (default 2000ms).

| Probe | Flag | URL override | Timeout (ms) |
| --- | --- | --- | --- |
| Clerk | `READYZ_PROBE_CLERK` | `READYZ_CLERK_URL` (default `https://api.clerk.com`) | `READYZ_CLERK_TIMEOUT_MS` |
| Paystack | `READYZ_PROBE_PAYSTACK` | `READYZ_PAYSTACK_URL` (default `https://api.paystack.co`) | `READYZ_PAYSTACK_TIMEOUT_MS` |
| Flutterwave | `READYZ_PROBE_FLUTTERWAVE` | `READYZ_FLUTTERWAVE_URL` (default `https://api.flutterwave.com`) | `READYZ_FLUTTERWAVE_TIMEOUT_MS` |

Strict matching: the flag is enabled **only** when set to the literal
`"1"`. Values like `"true"`, `"yes"`, `"01"`, or `" 1 "` are ignored
and the probe stays disabled — same strictness as
`REPLIT_DEPLOYMENT=1` and
`RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION=1` elsewhere in the boot
sequence so casing drift can't accidentally enable a probe an operator
didn't intend to.

Timeout sanitisation: a missing, non-numeric, zero, or negative value
falls back to the 2000ms default rather than producing a `NaN` timer
that would fire immediately and turn every probe into a 503. Same
sanitisation as `READYZ_DB_TIMEOUT_MS` and `READYZ_REDIS_TIMEOUT_MS`.

## When to enable

Enable a probe when:

- The dependency's outage manifests as broad request-level 5xx (Clerk
  down means almost every authenticated route returns 401/500;
  payment gateway down means checkout fails). In those cases draining
  the replica is the right call — the platform LB will route
  customers to a replica that's reachable, instead of every replica
  serving 5xx until the dependency recovers.
- You have multiple replicas. The probe only helps when the platform
  has somewhere else to route — on a single-replica deploy it just
  bounces traffic back to the same replica.
- The dependency has a **regional** failure mode. A probe lets the LB
  drain the replicas that lost connectivity to a regional outage
  without pulling down the ones that still reach a healthy region.

Don't enable a probe when:

- The dependency is genuinely critical-path for liveness — those
  belong in the always-on `db` / `redis` checks, not here.
- You've never tested it under load. A flaky probe whose own DNS or
  TCP RTT exceeds the timeout will drain the replica even when the
  dependency is fine — see the in-incident escape hatch below before
  enabling broadly.

## In-incident escape hatch (the "circuit breaker")

If a probe starts flapping during an incident — false positives
because the probe URL itself has a route problem, or the dependency is
slow but the request paths are still working — disable it without a
deploy by flipping the flag and restarting the api-server:

```sh
# Disable the Clerk probe. Any value other than "1" works; "0" is
# conventional and matches how the rate-limit opt-out is documented.
READYZ_PROBE_CLERK=0

# (or unset entirely — same effect)
unset READYZ_PROBE_CLERK
```

The next `/readyz` call will report `clerk: "skipped"` instead of
`clerk: "failed"`, the replica will return 200 again, and the LB will
route traffic back to it. Confirm with:

```sh
curl -s "$REPL_API_URL/api/readyz" | jq '.checks.clerk, .config.dependencyProbes.clerk.enabled'
# "skipped"
# false
```

The env-flag IS the breaker. We deliberately do **not** add an
in-process auto-trip breaker because:

- An auto-trip threshold that's too tight hides real outages.
- An auto-trip threshold that's too loose never recovers.
- In-process state isn't shared across replicas, so each replica would
  decide independently — defeating the point of a coordinated drain.

## Tuning the per-probe timeout

The default 2000ms is generous enough for any of the listed providers
under normal conditions but tight enough that a wedged TCP connect
won't pin the probe past the platform LB's readyz cadence. Lower it if
your network has unusually low latency to the provider; raise it only
if you're regularly seeing benign timeouts and have ruled out the
provider being slow.

```sh
READYZ_CLERK_TIMEOUT_MS=1500
READYZ_PAYSTACK_TIMEOUT_MS=3000
```

If you find yourself wanting to raise a probe timeout above 5000ms,
disable the probe instead — at that point the probe itself is at risk
of being slower than the platform's readyz cadence.

## Verification after a config change

```sh
curl -s "$REPL_API_URL/api/readyz" | jq '{
  status,
  checks,
  failures,
  enabled: .config.dependencyProbes
}'
```

A healthy enabled probe returns `<name>: "ok"`. A disabled probe
returns `<name>: "skipped"` AND
`config.dependencyProbes.<name>.enabled: false` — the latter is the
authoritative read of "is the flag actually wired" since the env var
might have been set on the wrong replica.

## On-call paging on a stuck probe

A repeated probe failure pages on-call out-of-band so operators don't
have to be tailing logs to notice. The notifier
(`lib/alerts/dependencyProbeAlerts.ts`) tracks consecutive failures
per probe and fires a Slack and/or PagerDuty alert once the threshold
is crossed; recovery (a single `ok` result, OR the operator flipping
the env-flag escape hatch above) emits the matching resolve so the
PagerDuty incident closes automatically.

The alert payload includes:

- The probe name (`clerk` / `paystack` / `flutterwave`) and a stable
  `dependency-probe:<name>` subsystem id so PagerDuty groups
  re-trips under the same incident.
- The freshest failure marker (e.g. `http_probe_timeout_after_2000ms`,
  `getaddrinfo ENOTFOUND api.clerk.com`) — the same string that
  appears under `failures.<name>` on `/readyz`.
- A direct link back to the [in-incident escape hatch](#in-incident-escape-hatch-the-circuit-breaker)
  section above so on-call can disable the probe without a deploy if
  the probe itself is the problem.

### Configuration

| Env var | Default | Notes |
| --- | --- | --- |
| `DEPENDENCY_PROBE_ALERT_THRESHOLD` | `3` | N consecutive failures before paging. Sanitised to >= 1 — `0` / negative / non-numeric values fall back to the default to prevent paging on every transient blip. |
| `DEPENDENCY_PROBE_ALERT_COOLDOWN_MS` | `60000` | Per-probe cooldown after a degraded → recovered transition. A flapping probe inside this window does NOT re-page. `0` is accepted as "no debounce". |
| `DEPENDENCY_PROBE_ALERT_RUNBOOK_URL` | this runbook anchor | Override to point at an internal wiki copy if you mirror runbooks. |
| `SUBSYSTEM_ALERT_SLACK_WEBHOOK_URL` | unset | Slack incoming webhook. Falls back to `RATE_LIMIT_INCIDENT_SLACK_WEBHOOK_URL` so an existing rate-limit channel automatically receives probe alerts. |
| `SUBSYSTEM_ALERT_PAGERDUTY_ROUTING_KEY` | unset | PagerDuty Events API v2 routing key. Falls back to `RATE_LIMIT_INCIDENT_PAGERDUTY_ROUTING_KEY`. |

When neither Slack nor PagerDuty is configured, the alerting is a
graceful no-op — dev / preview / CI deploys never try to page anyone.

### Debounce semantics

- A single 503 does NOT page. The threshold (default 3) exists to
  swallow single transient blips (TLS renegotiation, brief packet
  loss).
- We page exactly once per healthy → degraded transition. Subsequent
  failures within the same streak update the freshest failure marker
  but do not re-page.
- Recovery is paired with the trigger via PagerDuty's `dedup_key`, so
  a single `ok` result (or the operator disabling the probe via the
  env-flag escape hatch) auto-closes the incident.
- The cooldown gate prevents a flapping probe from re-paging within
  the cooldown window after a recovery — operator notes recovery,
  probe re-fails 5s later, the second trip is suppressed and a
  warning is logged (`dependency_probe_alert_degraded_suppressed_by_cooldown`).

### Tuning

If the threshold paging frequency is too noisy for your platform LB
cadence (e.g. a 1s cadence with the default threshold pages within
3s of a real outage), raise the threshold rather than disabling the
probe — the goal is "page on a real outage", not "page on the first
TCP handshake hiccup". Conversely, if you're missing legitimate
short-lived dependency outages, lower the threshold.

If you find yourself wanting to lower the threshold to `1`, double-
check that the probe URL itself isn't the problem (a flaky probe
endpoint will spam on-call if every blip pages). Disable the probe
via its env flag instead.

## Related runbooks

- [`rate-limit-store.md`](./rate-limit-store.md) — the always-on Redis
  rate-limit store probe; the same `/healthz` `subsystems` map and
  `/readyz` checks/failures shape live there.
- [`production-secrets.md`](./production-secrets.md) — production
  secret presence checks (including
  `payment_provider_missing_for_production`) that fire at boot, not
  per-probe.
