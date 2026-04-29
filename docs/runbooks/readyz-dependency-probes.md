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

## Post-deploy wire-shape probe

The post-deploy verification step in `.github/workflows/release.yml`
runs `check-readyz-dependency-probe-wire-shape.yml` alongside the
existing `check-production-hostname-pattern.yml` and
`check-readyz-config.yml` gates. The probe polls the deployed
`/readyz` URL (`vars.READYZ_URL`, reused from the sibling config
gates) and asserts the per-probe wire-shape fields surfaced for
each of `clerk`, `paystack`, `flutterwave`:

| Observed `checks.<name>` | Required `failures.<name>` | Required `config.dependencyProbes.<name>.enabled` |
| ------------------------ | -------------------------- | ------------------------------------------------- |
| `"skipped"`              | absent                     | `false`                                           |
| `"ok"`                   | absent                     | `true`                                            |
| `"failed"`               | non-empty string           | `true`                                            |

For every probe the gate ALSO asserts that
`config.dependencyProbes.<name>` has shape
`{ enabled: boolean, url: string, timeoutMs: number }` — a missing
or wrong-typed field is a route-side regression and escalates to
`probe_error` (exit 1).

When `failures.<name>` claims a timeout (the string starts with
`http_probe_timeout_after_`), it MUST match the documented marker
shape `/^http_probe_timeout_after_\d+ms$/` — uniform with the
rate-limit redis probe so log-aggregator queries on the prefix
`*_timeout_after_*ms` work across probe types. A malformed marker
(e.g. ms suffix dropped) escalates to `probe_error` rather than
silently passing.

Exit codes (matches `check-readyz-config.yml`):

- `0` — every probe matches the documented wire shape.
- `1` — probe error: network failure, non-2xx body that won't parse,
  missing `config.dependencyProbes` block, or a probe field is in an
  unrecognised shape (response-shape regression — escalate rather
  than silently treating it as healthy).
- `2` — page on-call: at least one probe is in a wire-shape-
  regressed state. The structured stdout line lists every regressed
  probe with the observed value so the page body identifies the
  regression without the on-call having to re-run by hand.

The probe accepts both a `200 ready` and a `503 not_ready` body —
the per-probe blocks are emitted on both paths, so wire-shape
assertion continues to fire during a downstream outage (the
worst-possible time to lose the page).

### Maximising assertion coverage in staging

The gate passes when probes report `"skipped"` (the documented
state when the env flag is unset) — that's intentional, since
`"skipped"` is a real production state. To exercise every per-state
branch (skipped + ok + failed), configure your staging deploy to
**enable all three probes** with real third-party URLs:

```bash
READYZ_PROBE_CLERK=1
READYZ_PROBE_PAYSTACK=1
READYZ_PROBE_FLUTTERWAVE=1
# Use the actual third-party endpoints documented in the
# "Configuration" section above so the probe makes a real outbound
# request and the gate can observe both ok and failed outcomes.
```

With all three probes enabled, a route-side regression that
silently swapped `"ok"` for `"healthy"`, or stopped emitting the
config sub-block, will be caught on the very next run rather than
the next time a probe was enabled in production.

### Required CI configuration

| Name                                                              | Type   | Required | Purpose                                                                                                |
| ----------------------------------------------------------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------ |
| `vars.READYZ_DEPENDENCY_PROBE_WIRE_SHAPE_PROBE_ENABLED`           | var    | yes      | Set to `"1"` to opt in. Acts as a kill switch — set to anything else to silence the workflow.          |
| `vars.READYZ_URL`                                                 | var    | yes      | Full URL to `/api/readyz` on the production deployment. Reused from the sibling config gates.          |
| `vars.READYZ_PROBE_TIMEOUT_MS`                                    | var    | no       | Per-request fetch timeout. Defaults to 5000ms.                                                         |
| `vars.SENTRY_ORG` / `vars.SENTRY_PROJECT`                         | vars   | no       | Sentry destination. Reused from the release workflow.                                                  |
| `secrets.READYZ_DEPENDENCY_PROBE_WIRE_SHAPE_SENTRY_DSN`           | secret | no       | DSN used by sentry-cli to post the page event AND send Sentry Cron monitor check-ins. When unset, the workflow falls back to the GitHub failed-workflow notification. |

### Re-run triggers

Re-run manually via the `workflow_dispatch` entry on the
`Readyz dependency-probe wire-shape (post-deploy + cron)` workflow
after editing:

- `artifacts/api-server/src/lib/dependencyProbes.ts` — the probe
  source (assertion logic the gate reads on the deployed surface).
- `artifacts/api-server/src/routes/health.ts` — the probe assembly
  block. A change to how `checks.<name>` / `failures.<name>` /
  `config.dependencyProbes.<name>` are populated would surface
  here.
- `artifacts/api-server/src/scripts/checkReadyzDependencyProbeWireShape.ts`
  — the gate itself. Re-run to confirm the new logic still passes
  on staging before the next deploy.

A 15-minute cron (`*/15 * * * *`) backstops a deploy that bypassed
the post-deploy gate (e.g. emergency rollback via the platform UI),
or a wire-shape regression introduced by a dependency upgrade that
re-shaped the response without changing the route source. The
Sentry Cron monitor `check-readyz-dependency-probe-wire-shape`
(configured in the Sentry UI) pages on missed check-ins, so a
disabled or stuck workflow surfaces independently of the in-loop
`send-event` path.

### Adding a new dependency probe

When adding a new dependency probe (a fourth name beyond
`clerk` / `paystack` / `flutterwave`), extend the `PROBES` export
in `checkReadyzDependencyProbeWireShape.ts`. Its sibling test pins
the closed set, so a new probe MUST be added to both before this
gate will pass — the test is intentionally a documentation lock so
a new probe lands in the runbook, the gate, and the route in
lockstep.

## Related runbooks

- [`rate-limit-store.md`](./rate-limit-store.md) — the always-on Redis
  rate-limit store probe; the same `/healthz` `subsystems` map and
  `/readyz` checks/failures shape live there.
- [`production-secrets.md`](./production-secrets.md) — production
  secret presence checks (including
  `payment_provider_missing_for_production`) that fire at boot, not
  per-probe.
