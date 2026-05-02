# notification-service

Phase 4 strangler-fig extraction of the notification outbox/worker out of `services/api-monolith`.

## Strangler-fig migration plan

This service is being introduced incrementally:

1. **Bootstrap (this commit):** Service directory, Dockerfile, Helm chart, ArgoCD app, HTTP healthz/metrics. No outbox draining. The api-monolith continues to own writes and drains the outbox.
2. **Read-side cutover:** notification-service drains the outbox using a separate worker identity. Worker leases use a non-overlapping ID range so api-monolith and notification-service can run concurrently for verification.
3. **Cutover gate:** When the notification-service has drained 100% of new rows for 7 consecutive days with parity to the monolith's previous metrics, the monolith's `outboxDrain` cron is disabled.
4. **Write-side migration:** New `enqueueNotification` callers call this service via HTTP/gRPC. Old monolith call sites migrate one event type at a time (security alerts → order updates → marketing).
5. **Decommission:** Remove `lib/notifications/` from the monolith.

## Database

This service shares the `@workspace/db` package with the monolith. It does NOT own a separate Postgres instance during the migration window — both processes connect to the same DB. Once the monolith's notification call sites have all migrated, the `notification_outbox` table can move to a dedicated database under a future Phase 4.5 effort.

## Endpoints

- `GET /healthz` — liveness
- `GET /metrics` — prom-client
- `POST /v1/notifications/enqueue` — phase 4 step 4: HTTP write entrypoint (planned)

## Status

🚧 Skeleton only. Tracked as Wave 4 in [docs/sprints/backlog/TRIAGE.md](../../docs/sprints/backlog/TRIAGE.md).
