# Runbook: System-status subsystem alerts

This runbook covers the on-call setup for the durations-based pages
fired by `scripts/checkHealthzDegraded.ts` against the `/healthz`
`subsystems` map. Each subsystem has its own watcher in
`services/api-monolith/src/lib/subsystemHealth.ts`; the probe walks
them all on every scheduled run and pages once any one has been
stuck `degraded` for longer than its duration threshold.

## Subsystem inventory

| Subsystem key | Source watcher | Healthy when | Page after |
|---|---|---|---|
| `rateLimitStore` | `RedisFailureWatcher` (`middlewares/apiRateLimit.ts`) | Lua bump + PING round-trips succeed | `RATE_LIMIT_DEGRADED_DURATION_PAGE_MS` (default 10 min) |
| `database` | `dbHealthWatcher` (`lib/subsystemHealth.ts`) | `/readyz` DB probe succeeds | duration via `checkHealthzDegraded` config (default 10 min) |
| `auditChain` | `auditHealthWatcher` (`lib/subsystemHealth.ts`) | Every `recordAudit` chain-extend succeeds | duration via `checkHealthzDegraded` |
| `auditDlq` | `auditDlqHealthWatcher` (`lib/auditDlqMonitor.ts`) | `audit_failures` unreplayed count ≤ `AUDIT_DLQ_BACKLOG_THRESHOLD` (default 100) | duration via `checkHealthzDegraded` |
| `paymentGateway<Provider>` | per-gateway `SubsystemFailureWatcher` (`lib/subsystemHealth.ts`) | Gateway charge/verify/payout succeeds | duration via `checkHealthzDegraded` |

The standard payload shape (visible in `/healthz`):

```json
{
  "state": "degraded",
  "failureCount": 7,
  "firstFailureAt": 1714771200000,
  "lastRecoveredAt": 1714770000000
}
```

## How a page reaches you

Two paths converge on PagerDuty:

1. **Edge-driven incidents** (`rateLimitStore`, `database`) page on
   every healthy↔degraded transition via the
   `WebhookIncidentNotifier` configured by `INCIDENT_WEBHOOK_URL`.
   These match the in-app banner: if the operator sees a banner,
   on-call sees a page. Dedup keys:
   - `rate-limit-store-degraded:<source>`
   - `db-degraded:<source>`
2. **Duration-driven incidents** (any subsystem) fire from
   `scripts/checkHealthzDegraded.ts`, which the
   `.github/workflows/check-healthz-degraded.yml` Sentry-monitored
   workflow runs on schedule. The probe exits non-zero when any
   subsystem has been `degraded` longer than its configured
   threshold; the GH Actions workflow's `sentry-cli monitors run`
   raises a Sentry issue, which the project's Sentry alert rule
   forwards to PagerDuty.

The probe rehearsal (`probe-rehearsal-notify-webhook.yml`) injects
synthetic streaks via `routes/healthzRehearsal.ts` weekly so on-call
sees a real (and clearly-labeled) page that exercises the entire
chain end-to-end without breaking real Redis.

## On-call response matrix

### `rateLimitStore`
1. Open the rate-limit dashboard. Confirm `state=degraded` is current
   (not a stale page).
2. `kubectl get pods -l app=redis-platform` and check the master is
   healthy. If the failover is still in progress, wait 30s — the
   sentinel quorum auto-recovers.
3. If Redis is reachable, look for `rate_limit_redis_bump_failed` in
   the api-monolith logs to identify whether errors are timeouts
   (network) or PERMISSION denials (auth rotated).
4. Mitigation: if Redis is genuinely unreachable, the rate limiter
   degrades open. Confirm 4xx rate is normal; rotate to a known-good
   Redis snapshot or scale Redis vertically if memory-pressured.
5. Resolution: a clean PING + bump round-trip closes the streak via
   `recordSuccess` and emits the paired
   `rate_limit_store_recovered` Sentry signal.

### `database`
1. Check `/readyz` JSON for `subsystems.database.firstFailureAt` —
   confirms when this streak began.
2. Run `kubectl exec` into one api-monolith pod and try `psql
   $DATABASE_URL -c 'SELECT 1'`. If it hangs, the DB primary has
   stalled (likely vacuum / replication lag / disk).
3. Open the Postgres operator dashboard. Look for failover events.
4. Mitigation: if read replicas are healthy but the primary is
   gone, trigger primary failover (`patroni switchover`). Order
   placement and audit writes will continue to fail until then.

### `auditChain`
1. The `recordAudit` write path is failing. Causes are almost always
   either DB pressure (correlate with `database` watcher) or the
   audit table's append-only trigger blocking due to a schema drift.
2. Check Sentry for stack traces tagged `subsystem=audit_chain`.
3. Mitigation: failing writes are dead-lettered into
   `audit_failures`, so user requests do NOT fail. The compliance
   gap is real but bounded; if the streak has been > 30 min, post
   in #compliance and tag the on-call DPO so they can size the
   reporting impact while the fix is being applied.

### `auditDlq`
1. The forensic DLQ has > 100 unreplayed rows. The
   `auditDlqMonitor` polls every 60s; if this triggered, replay
   was either disabled or is itself failing.
2. Check `auditDlqMonitor` logs for replay errors. The
   `replayDeadLetteredAuditRows` worker has a backoff; if the
   underlying chain insert keeps failing, the DLQ won't drain.
3. Mitigation: same as `auditChain` — likely a DB or schema issue
   blocking writes.

### `paymentGateway<Paystack|Flutterwave|...>`
1. Charges / verifies / payouts to this gateway are stuck failing.
   `lib/payments.ts` keeps the circuit breaker open on the
   in-DB `gateway_health` table while this watcher is degraded.
2. `kubectl logs` for `gateway_health.degraded` entries to confirm
   which operation is failing (charge / verify / payout).
3. Check the gateway's status page. If it's an upstream outage,
   the platform is silently routing to the configured fallback
   gateway; new orders continue to settle.
4. Mitigation: nothing to do code-side beyond confirming the
   fallback is healthy. Once the upstream recovers, the next
   successful op closes the streak via `recordSuccess`.

## Adding a new subsystem

1. Create or reuse a `SubsystemFailureWatcher` in `subsystemHealth.ts`.
2. Wire `record()` / `recordSuccess()` from the relevant operation.
3. Surface it in `/healthz` `subsystems.<key>` with the standard
   `SubsystemSnapshot` shape.
4. Add the subsystem to this runbook with its triage steps.
5. If the subsystem deserves an edge-driven page (i.e. on every
   healthy↔degraded transition rather than only after a duration
   threshold), wire the `WebhookIncidentNotifier` in the watcher
   subclass like `DbHealthWatcher` does.

## Related runbooks

- `docs/runbooks/rate-limit-store.md` — Redis-backed rate limiter
  details, including the `RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION`
  opt-out semantics.
- `docs/runbooks/backup-verify.md` — backup integrity probe.
- `docs/runbooks/mfa-rate-limit-alerts.md` — MFA-specific abuse
  alerts that fire alongside the per-tier rate-limit 429s.
