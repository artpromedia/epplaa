# Backlog Triage — Production Readiness

This document is the **authoritative implementation plan** for the production-readiness backlog. The per-ticket stub files in this directory were generated from a template and previously pointed at file paths (`artifacts/api-server/...`, `artifacts/admin-console/...`, etc.) that do not exist in this monorepo. Those references have been bulk-corrected to the real paths:

| Old (broken) reference | Real path in this repo |
|---|---|
| `artifacts/api-server/` | `services/api-monolith/` |
| `artifacts/admin-console/` | `apps/admin/` |
| `artifacts/manufacturer-portal/` | `apps/partner/` |
| `lib/api-client-react/` | `packages/api-client-react/` |

Stub acceptance criteria were also generic ("tests are written and pass in CI"). Concrete criteria for each ticket are below, grouped by wave and sprint.

The Wave-1 ordering matches the production-readiness plan: nothing ships without these.

---

## Wave 1 — Production Gate (9 tasks)

### #178 — Provision shared Redis for multi-instance chat / rate limiting
**Sprint 12.** Touches: `infra/helm/redis/`, `infra/terraform/modules/`, `services/api-monolith/src/lib/socket.ts`, `services/api-monolith/src/lib/chat.ts`, `services/api-monolith/src/middlewares/apiRateLimit.ts`, `docs/runbooks/rate-limit-store.md`.

Concrete criteria:
- A Helm values file under `infra/helm/redis/` provisions a Redis instance reachable from the `api-monolith` pod via `REDIS_URL`.
- `services/api-monolith/src/lib/socket.ts` is wired through `@socket.io/redis-adapter` so two replicas broadcast to the same chat room.
- `services/api-monolith/src/middlewares/apiRateLimit.ts` consults the same Redis for rate-limit counters; existing `apiRateLimit.test.ts` extended with a "two-instance" scenario.
- `docs/runbooks/rate-limit-store.md` documents the connection envvars, failover behavior, and the smoke test.

### #179 — Keep chat working when Redis blips
**Sprint 12.** Touches: `services/api-monolith/src/lib/chat.ts`, `services/api-monolith/src/lib/socket.ts`, new `services/api-monolith/src/lib/socket.cluster.test.ts` extension.

Concrete criteria:
- When the Redis adapter loses its connection, chat falls back to the in-process broadcaster instead of silently dropping messages, and emits a structured `chat.redis_degraded` log.
- A `subsystemHealth` entry surfaces the Redis chat-adapter status so it's visible in `/healthz`.
- Reconnect path is covered by `socket.cluster.test.ts` using `ioredis-mock`.

### #163 — Lock in payout rules for split orders end-to-end
**Sprint 5.** Touches: `services/api-monolith/src/lib/payments.ts`, `services/api-monolith/src/lib/manufacturerPayouts.ts`, `services/api-monolith/src/routes/payments.ts`, `services/api-monolith/src/routes/orders.ts`, existing `payments.payoutSplit.int.test.ts`.

Concrete criteria:
- For an order with N items spanning M sellers, payout entries sum to (gross − fees − refunds) per seller; rounding remainders never drift > 1 minor unit.
- VAT, FX, platform fee, and refund partial-amount cases are each covered in `payments.payoutSplit.int.test.ts`.
- A regression test pins the sum invariant: total payouts + platform fee + tax + refunds == buyer-charged amount.

### #171 — Pay sellers their share when buyers choose pay-on-collection (COD)
**Sprint 5.** Touches: `services/api-monolith/src/routes/orders.cod.int.test.ts`, `services/api-monolith/src/routes/orders.ts`, `services/api-monolith/src/lib/manufacturerPayouts.ts`.

Concrete criteria:
- When a COD order is marked delivered, a payout row is generated for each seller with the same split arithmetic as #163, gated on a `delivered` confirmation.
- Idempotency: a duplicate delivery webhook does not create duplicate payouts.
- `orders.cod.int.test.ts` covers happy path, partial delivery, and refund-after-delivery.

### #203 — Test that sanctions-flagged manufacturers cannot be paid
**Sprint 5.** Touches: `services/api-monolith/src/lib/sanctions.ts`, `services/api-monolith/src/lib/manufacturerPayouts.ts`, new test alongside `payments.payoutSplit.int.test.ts`.

Concrete criteria:
- A sanctions hit on a manufacturer blocks payout creation **and** payout release; the order's payment can still settle but the seller's share is held in a `payout_blocked_sanctions` state.
- An audit log entry (`sanctions.payout_blocked`) is written including the manufacturer id and screening reference.
- Test asserts that lifting the flag does not retroactively release without an admin action.

### #204 — Cover the partial bonded-warehouse release scenario in tests
**Sprint 5.** Touches: `services/api-monolith/src/lib/customs.ts`, `services/api-monolith/src/lib/landedCost.ts`, `services/api-monolith/src/routes/wholesale.e2e.test.ts`.

Concrete criteria:
- Test simulates a bonded shipment where only part of the SKUs are released to the buyer; remaining inventory stays in bonded status and is not double-charged duty.
- Landed-cost recomputation matches the actually-released subset.
- Audit trail captures the partial release event.

### #205 — Prove the payment-provider boot warning matches sandbox-fallback logic
**Sprint 5.** Touches: `services/api-monolith/src/lib/payments.ts`, `services/api-monolith/src/lib/payments.health.test.ts`, `services/api-monolith/src/index.boot.test.ts`, `services/api-monolith/src/lib/payments.gatewaySelection.test.ts`.

Concrete criteria:
- The boot-time warning that "payment provider X falling back to sandbox" is emitted iff the runtime gateway-selection logic actually selects sandbox for that provider.
- Test feeds the same env permutations to both code paths and asserts the warning↔selection invariant.

### #164 — Catch payment-flow regressions automatically on every change
**Sprint 5 / Sprint 3.** Touches: `.github/workflows/ci.yml`, new dedicated payment-regression workflow, `services/api-monolith/src/lib/payments.*.test.ts`.

Concrete criteria:
- A CI job runs the full payment integration test suite (`payments.payoutSplit.int.test.ts`, `webhooks.concurrency.int.test.ts`, `orders.cod.int.test.ts`) and is a required check on PRs touching any of: `services/api-monolith/src/lib/payments*`, `services/api-monolith/src/routes/payments.ts`, `services/api-monolith/src/routes/webhooks.ts`, `packages/payments/`.
- Failure blocks merge.

### #202 — Prove rate limits and MFA hold up under two live API servers
**Sprint 1.** Touches: `services/api-monolith/src/middlewares/apiRateLimit.test.ts`, `services/api-monolith/src/lib/mfa.int.test.ts`, new `services/api-monolith/src/middlewares/apiRateLimit.cluster.int.test.ts`.

Concrete criteria:
- Spin up two `app` instances against the same `ioredis-mock` (or shared real Redis when available); 100 requests split across them must hit the same limit ceiling as 100 to one instance.
- MFA challenge state issued on instance A is honored on instance B via the shared store.
- Both behaviors fail loudly when Redis is misconfigured to be per-instance.

### Vault bootstrap runbook
Execute `docs/runbooks/vault-bootstrap.md` to migrate secrets off env-vars. This is operational, not code. Track in your Vault project.

---

## Wave 2 — Operational Stability (35 tasks)

### Sprint 2 — On-Call Alerting (21 tasks)

#### #144 — Notify on-call when rate-limit store is degraded too long
Files: `services/api-monolith/src/lib/rate-limit/incidentNotifier.ts`, `services/api-monolith/src/middlewares/apiRateLimit.ts`, `scripts/src/sentryMonitors.config.ts`, `docs/runbooks/rate-limit-store.md`.
- A monitor in `sentryMonitors.config.ts` pages when `rate_limit_store_degraded` has been continuously true for >5 min.
- `incidentNotifier.ts` emits the metric used by the monitor.
- Runbook entry covers triage steps.

#### #238 — Tell on-call about a stuck rate-limit Redis the same way as payment providers
Files: `services/api-monolith/src/lib/alerts/gatewayHealthAlerts.ts`, `services/api-monolith/src/lib/rate-limit/incidentNotifier.ts`.
- The alert payload schema for stuck rate-limit Redis matches the gateway-health alert schema (provider, host, last-success-at, severity).
- A unit test asserts the two payloads are structurally compatible.

#### #145 — Retire the old hostname-only on-call probe once the broader probe is proven
Files: `services/api-monolith/src/scripts/checkProductionHostnamePattern.ts`, `services/api-monolith/src/scripts/checkReadyzDependencyProbeWireShape.ts`, `.github/workflows/check-production-hostname-pattern.yml`.
- Add a feature-flag retirement: when broader readyz-dependency-probe has been green for N consecutive runs, the old hostname-only probe is removed.
- One-shot PR that deletes the legacy workflow file once retirement gate is met.

#### #146 — Block deploys when production env vars are misconfigured *(may already be Implemented — verify status header)*
Files: `services/api-monolith/src/lib/productionSignals.ts`, `services/api-monolith/src/index.boot.test.ts`.

#### #147 — Automated guard against raw SQL timestamp pitfall *(may already be Implemented)*
Files: `scripts/src/checkRawSqlTimestamps.ts`, `services/api-monolith/src/lib/dbTimestamps.ts`.

#### #148 — Page on-call when Sentry release tagging silently stops running
Files: `scripts/src/sentryMonitors.config.ts`, `scripts/src/syncSentryMonitors.ts`, `.github/workflows/release.yml`.
- A heartbeat monitor named `sentry_release_tagging` is registered; the release workflow pings it on success.
- Alert fires after >2 missed expected runs.

#### #149 — Catch contract drift across all API responses, not just MFA *(Sprint 11; may be Implemented)*
Files: `packages/api-spec/`, `packages/api-zod/`, `services/api-monolith/src/lib/responseSchema.ts`.

#### #150 — Fail CI if OpenAPI spec drifts from generated client/zod files
Files: `apis/openapi/`, `packages/api-client-react/`, `packages/api-zod/`, `.github/workflows/check-openapi-drift.yml`.
- The drift-check workflow regenerates client + zod from the spec and fails on any diff.

#### #151 — Page on-call when database or audit pipeline subsystems go degraded too
Files: `services/api-monolith/src/lib/subsystemHealth.ts`, `services/api-monolith/src/lib/dbLatencyProbe.ts`, `services/api-monolith/src/lib/auditDlqMonitor.ts`, `scripts/src/sentryMonitors.config.ts`.
- Each subsystem (`database`, `audit_pipeline`) has a Sentry monitor mirroring the rate-limit-store one.
- A unit test asserts every key in `SUBSYSTEMS` has a corresponding Sentry monitor.

#### #152 — Document on-call setup for the new system-status alerts in the runbook
Files: `docs/runbooks/mfa-rate-limit-alerts.md`, new `docs/runbooks/system-status-alerts.md`.
- Runbook covers each alert: trigger, expected response time, escalation path, mitigation.

#### #155 — Alert operators when push or email delivery keeps failing
Files: `services/api-monolith/src/lib/notifications/push.ts`, `services/api-monolith/src/lib/notifications/postmark.ts`, `services/api-monolith/src/lib/notifications/sendgrid.ts`, `services/api-monolith/src/lib/queueDepth.ts`.
- A rolling-window failure-rate metric per provider; alert at >20% over 15 min.

#### #174 — Alert on-call when a notification worker crashes mid-send
Files: `services/api-monolith/src/lib/notifications/outbox.ts`, `services/api-monolith/src/lib/queueDepth.ts`.
- An exception escaping the outbox worker emits `notification.worker_crashed` and pages.

#### #211 — Auto-page on the seven other production-secret warnings
Files: `scripts/src/productionSecretAlerts.config.ts`, `scripts/src/sentryMonitors.config.ts`.
- Each of the 7 listed warnings has a corresponding Sentry alert; covered by `productionSecretAlerts.config.test.ts`.

#### #212 — Push log aggregator alerts automatically once a tool is chosen
Files: `scripts/src/printLogAggregatorAlerts.ts`, new `scripts/src/syncLogAggregatorAlerts.ts`.
- When `LOG_AGGREGATOR=loki|datadog|...` is set, alerts in `printLogAggregatorAlerts.ts` are pushed via the chosen provider's API.

#### #213 — Re-run the post-deploy gate rehearsal on a schedule
Files: `.github/workflows/rehearse-healthz-degraded.yml`, `.github/workflows/rehearse-production-hostname-pattern.yml`, new `.github/workflows/rehearse-post-deploy-gate.yml`.
- A scheduled workflow (`cron: '0 */6 * * *'`) runs the same probe set the deploy gate runs.

#### #214 — Share the post-deploy probe wrapper between production gate and rehearsal
Files: new `.github/scripts/post-deploy-probe.sh`, referenced from both `release.yml` and the rehearsal workflow.
- Both workflows call the same script; CI fails if either drifts.

#### #218 — Cover the on-call alert rule verifier with unit tests
Files: `scripts/src/syncSentryMonitors.ts`, `scripts/src/syncSentryMonitors.test.ts`.
- New unit tests cover: monitor missing, monitor exists with wrong threshold, monitor exists correct.

#### #219 — End-to-end verify the on-call alert rule check
Files: `scripts/src/syncSentryMonitors.integration.test.ts`.
- Test boots a mock Sentry API and asserts the verifier walks all configured monitors and reports drift correctly.

#### #228 — Rehearse that an ongoing outage re-announces in ops on the next workflow run
Files: `.github/workflows/probe-rehearsal-notify-webhook.yml`.
- If a probe is still failing on the next scheduled run, a follow-up Slack/PagerDuty notification fires (not just the first one).

#### #230 — Catch broken on-call message bodies before they ship
Files: `scripts/src/sentryMonitors.config.ts`, new `scripts/src/sentryMonitorMessageBody.test.ts`.
- A test asserts every monitor has a non-empty message body containing runbook URL and severity.

#### #231 — Catch a broken Sentry pager forwarder before the next outage
Files: `scripts/src/syncSentryMonitors.ts`, `scripts/src/sentryMonitors.config.ts`.
- A monitor's `actions` array is asserted to contain at least one PagerDuty integration; CI fails otherwise.

#### #237 — Show on-call which servers think a payment provider is down
Files: `services/api-monolith/src/lib/alerts/gatewayHealthAlerts.ts`, `apps/admin/src/pages/status.tsx`.
- The alert payload includes the originating server hostname; admin status page lists per-server provider health.

### Sprint 4 — Backup, Data Integrity & Audit Pipeline (12 tasks)

#### #156 — Auto-replay dead-lettered audit rows
Files: `services/api-monolith/src/lib/auditDlqMonitor.ts`, `services/api-monolith/src/lib/audit.ts`.
- A worker re-enqueues DLQ rows on a backoff; max retries before permanent failure.
- Existing `auditDlqMonitor.test.ts` extended with replay scenario.

#### #157 — Practice the audit DLQ page in the weekly rehearsal
Files: `.github/workflows/rehearse-healthz-degraded.yml` (or new `rehearse-audit-dlq.yml`), `services/api-monolith/src/lib/auditDlqMonitor.ts`.
- Synthetic DLQ row triggers the page; rehearsal workflow asserts the page fires.

#### #158 — Backup producer writes a counts manifest beside each dump
Files: `scripts/src/verifyBackup.ts`, new manifest-writer in the backup producer.
- Each dump has a `<dump>.manifest.json` with row counts per table; verifier consumes it.

#### #232 — Backup producer writes the SHA-256 sidecar this verifier needs
Files: `scripts/src/verifyBackup.ts`, backup producer.
- `<dump>.sha256` sidecar is written and consumed by `verifyBackup.ts`.

#### #233 — Promote sidecar check to a hard failure once producers reliably emit them
Files: `scripts/src/verifyBackup.ts`, `.github/workflows/backup-verify.yml`.
- Switch from soft-warn to hard-fail when sidecar missing; gated behind a `BACKUP_SIDECAR_REQUIRED=1` flag with clear deprecation date.

#### #159 — Notify the team in Slack when a backup is stale
Files: `scripts/src/verifyBackup.ts`, `.github/workflows/backup-verify-nightly.yml`.
- If newest backup > 26h old, post Slack message via webhook env.

#### #160 — Cover the live counts comparison end-to-end in CI
Files: `scripts/src/verifyBackup.test.ts`, new `.github/workflows/backup-verify.yml` step.
- E2E test produces a dump from a seeded DB and runs verifier; CI step exercises the full path.

#### #190 — Send the audit log to long-term storage so it survives database resets
Files: `services/api-monolith/src/lib/audit.ts`, new `services/api-monolith/src/lib/auditArchive.ts`.
- Audit rows older than N days are streamed to cold storage (S3-compatible); retrieval helper documented.

#### #216 — Make the new week-over-week backup check actually work in production
Files: `scripts/src/verifyBackup.ts`, `.github/workflows/backup-verify-nightly.yml`.
- The current week-over-week comparison reads real production manifests instead of test fixtures.

#### #217 — Show the backup row-count trend on the admin status panel
Files: `apps/admin/src/pages/status.tsx`, new admin API route in `services/api-monolith/src/routes/adminConsole.ts`.
- Status panel renders a 7-day sparkline of audit-row counts.

#### #220 — Detect chain tampering within minutes by sharding the verifier
Files: `services/api-monolith/src/lib/auditChainVerifier.ts`, `services/api-monolith/src/lib/auditChainVerifier.test.ts`.
- Verifier runs in parallel shards (by table-key range); end-to-end runtime budget < 5 min.

#### #221 — End-to-end test that proves the tamper detector pages correctly
Files: `services/api-monolith/src/lib/auditChainVerifier.test.ts`.
- Inject a row mismatch; assert verifier raises and emits a paging alert.

#### #234 — Catch checksum flow regressions with end-to-end tests
Files: `scripts/src/verifyBackup.test.ts`.
- Full pipeline test: dump → sidecar → verify; mutate one byte → verifier fails.

### Sprint 3 remaining (6 tasks)

#### #160 (also covers Sprint 4) — see above.
#### #168 — Cover new rescreen-on-edit behavior with an integration test
Files: `services/api-monolith/src/routes/seller.ts`, `services/api-monolith/src/lib/sanctions.ts`, new `services/api-monolith/src/routes/seller.rescreen.int.test.ts`.

#### #227 — Catch missing user-id foreign keys before they reach production
Files: `packages/db/`, new `scripts/src/checkUserFkCoverage.ts`.
- Static check walks schema for tables with a `user_*` column lacking FK; fails CI.

#### #229 — Warn when the same rate-limit opt-out keeps getting its sunset extended
Files: `scripts/src/checkRateLimitOptOutSunsets.ts`, `scripts/src/checkRateLimitOptOutSunsets.test.ts`.
- Track extension count per opt-out; warn at >2 extensions.

#### #235 — Catch the same opt-out paperwork gap when ops set the env var by hand
Files: `scripts/src/checkRateLimitOptOutPrInventory.ts`.
- Verifier inspects deployed env vs. PR inventory and flags drift.

#### #223 — Show the proposed Sentry filter change in PR comments when the inventory drifts
Files: `scripts/src/syncSentryOptOutAuditFilter.ts`, `.github/workflows/sync-sentry-opt-out-audit-filter.yml`.
- Workflow posts a PR comment with the diff when inventory drift detected.

---

## Wave 3 — Feature Completeness (38 tasks)

### Sprint 6 — Notifications (7 tasks)

#### #172 — De-duplicate "on the way" locker messages
Files: `services/api-monolith/src/lib/notifications/outbox.ts`, `services/api-monolith/src/lib/pudo/delivery.ts`.
- Idempotency key `(orderId, lockerId, 'on_the_way')`; second send is a no-op.

#### #173 — No-double-fire push on retries
Files: `services/api-monolith/src/lib/notifications/push.ts`, `services/api-monolith/src/lib/notifications/outbox.ts`.
- Exactly-once semantics via outbox `delivered_at`; existing `push.test.ts` extended.

#### #174 — Already covered in Sprint 2.

#### #177 — PUDO partner recovery email
Files: `services/api-monolith/src/lib/pudo/delivery.ts`, `services/api-monolith/src/lib/notifications/emailTemplate.ts`.
- When a previously-failing partner recovers, send a one-time recovery email.

#### #206 — Notification history inbox for buyers/sellers
Files: new route in `services/api-monolith/src/routes/notificationPrefs.ts` (or new `notifications.ts`), DB schema in `packages/db/`, UI in `apps/web-buyer-spa/src/`.

#### #207 — Automated tests for takedown notification + appeal flow
Files: `services/api-monolith/src/routes/safety.ts`, `services/api-monolith/src/routes/adminTrustSafety.ts`.

#### #208 — Track and rate-limit repeated takedown appeals per seller
Files: `services/api-monolith/src/routes/safety.ts`, `services/api-monolith/src/middlewares/apiRateLimit.ts`.

### Sprint 7 — Shipping & PUDO (6 tasks)

#### #169 — Full payment-to-dispatch E2E test
Files: extends existing `services/api-monolith/src/routes/fulfillment.e2e.test.ts`.

#### #170 — Carrier webhook signature enforcement
Files: `services/api-monolith/src/routes/fulfillmentWebhooks.ts`, new `fulfillmentWebhooks.signature.test.ts`.

#### #175 — PUDO admin configure UI
Files: `apps/admin/src/pages/` (new page), `services/api-monolith/src/routes/pudo.ts`.

#### #176 — Full PUDO integration test against real DB
Files: `services/api-monolith/src/lib/pudo/delivery.test.ts` (extend) + new `.int.test.ts`.

#### #209 — Disabled carriers stop returning fake quotes
Files: `services/api-monolith/src/lib/fulfillment/registry.ts`, `services/api-monolith/src/lib/fulfillment/dispatch.ts`.

#### #210 — Carrier credential warnings in audit table
Files: `services/api-monolith/src/lib/fulfillment/bootGuard.ts`, `services/api-monolith/src/lib/audit.ts`.

### Sprint 8 — Live Streaming (5 tasks)

#### #180 — Moderator flow automated tests
Files: `services/api-monolith/src/lib/streamModerators.ts`, `services/api-monolith/src/routes/streams.ts`.

#### #181 — Viewer promoted-to-moderator notification
Files: `services/api-monolith/src/lib/streamModerators.ts`, `services/api-monolith/src/lib/notifications/outbox.ts`.

#### #182 — Moderator audit history in admin console
Files: `apps/admin/src/pages/audit.tsx`, `services/api-monolith/src/routes/adminConsole.ts`.

#### #194 — Broadcast-ready seller notification
Files: `services/api-monolith/src/lib/streaming.ts`, `services/api-monolith/src/lib/notifications/outbox.ts`.

#### #195 / #196 — Recording status UI + replay E2E
Files: `services/api-monolith/src/routes/replays.ts`, `apps/web-buyer-spa/src/`, `apps/studio/src/`.

### Sprint 9 — Seller & Shopper Experience (7 tasks)

#### #161 — Surface unresolvable legacy streams to ops
Files: `apps/admin/src/pages/`, `services/api-monolith/src/routes/streams.ts`.

#### #162 — Block stream creation without an owner
Files: `services/api-monolith/src/routes/streamLifecycle.ts`, `services/api-monolith/src/lib/streaming.ts`.

#### #183 / #184 / #185 — Recently-viewed shelf
Files: existing `services/api-monolith/src/routes/discovery.recentlyViewed.int.test.ts`, `services/api-monolith/src/lib/recommender.ts`, `apps/web-buyer-spa/src/`.

#### #186 / #187 — Real-time viewer counts
Files: `services/api-monolith/src/lib/streaming.ts`, `services/api-monolith/src/lib/socket.ts`, `apps/web-buyer-spa/src/`.

#### #197 — Free shipping toggle per listing
Files: `services/api-monolith/src/routes/products.ts`, `packages/db/`, `apps/studio/src/`.

### Sprint 10 — Admin Console (9 tasks)

#### #165 — Fix broken Status page tests in admin console
Files: `apps/admin/src/pages/status.test.tsx`.

#### #166 — Slowdown banner on admin console
Files: `apps/admin/src/components/admin-shell.tsx`, `apps/admin/src/components/rate-limit-store-alerts.tsx`.

#### #167 / #168 — Seller re-screen on country change + integration test
Files: `services/api-monolith/src/routes/seller.ts`, `services/api-monolith/src/lib/sanctions.ts`.

#### #188 — NDPR request approve/reject
Files: `apps/admin/src/pages/ndpr.tsx`, `services/api-monolith/src/routes/ndpr.ts`, `services/api-monolith/src/lib/ndpr.ts`.

#### #189 — Full-size KYC document images
Files: `apps/admin/src/pages/kyc.tsx`, `services/api-monolith/src/routes/kyc.ts`.

#### #191 — Moderation E2E with mock provider
Files: `services/api-monolith/src/lib/moderation.ts`, `services/api-monolith/src/lib/moderation.test.ts`.

#### #192 — Cache/rate-limit boot-time provider probe
Files: `services/api-monolith/src/lib/dependencyProbes.ts`, `services/api-monolith/src/index.ts`.

#### #193 — Moderation degraded banner in site notice
Files: `apps/admin/src/components/admin-shell.tsx`, `apps/web-buyer-spa/src/`, `services/api-monolith/src/lib/moderation.ts`.

### Sprint 13 remaining (2 tasks)

#### #226 — Lock down the rest of the user-linked tables
Files: `packages/db/`, new migration; cross-check with `scripts/src/checkUserFkCoverage.ts` (#227).

#### #199 — Audit log entry every time an admin request is blocked for missing MFA *(may be Implemented; verify)*
Files: `services/api-monolith/src/middlewares/clerkProxyMiddleware.ts`, `services/api-monolith/src/lib/audit.ts`.

---

## Wave 4 — Scale & AI (post-beta)

Out of scope for this triage. Tracked in `docs/sprints/ai-sprints.md` and `docs/sprints/sprint-plan/`.

---

## Implementation order

The Wave 1 ordering in this document also defines commit order. Each ticket should land as one or more focused commits referencing the ticket number in the message (`#178 — provision shared Redis ...`). When a ticket creates a CI gate, that gate is added in the same PR that introduces the gated code.
