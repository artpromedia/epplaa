# Sprint 3 — CI/CD, Testing & DevOps Gates

Harden the CI pipeline so that misconfigured env vars, spec drift, SQL pitfalls, and missing safeguards are caught automatically before they reach production.

## Tasks

| Ref | Title | Status | Notes |
|-----|-------|--------|-------|
| [#146](./backlog/146-block-deploys-when-production-env-vars-are-misconfigured.md) | Block deploys when production env vars are misconfigured | ✅ Implemented | Code implemented in this PR |
| [#147](./backlog/147-add-automated-guard-against-raw-sql-timestamp-pitfall.md) | Add automated guard against raw-SQL timestamp pitfall | ✅ Implemented | Code implemented in this PR |
| [#150](./backlog/150-fail-ci-if-the-openapi-spec-drifts-from-the-generated-client-zod-files.md) | Fail CI if the OpenAPI spec drifts from the generated client/zod files | ✅ Implemented | Code implemented in this PR |
| [#160](./backlog/160-cover-the-live-counts-comparison-end-to-end-in-ci.md) | Cover the live-counts comparison end-to-end in CI | 📋 Backlog | Stub: [docs/sprints/backlog/160-cover-the-live-counts-comparison-end-to-end-in-ci.md](./backlog/160-cover-the-live-counts-comparison-end-to-end-in-ci.md) |
| [#164](./backlog/164-catch-payment-flow-regressions-automatically-on-every-change.md) | Catch payment-flow regressions automatically on every change | 📋 Backlog | Stub: [docs/sprints/backlog/164-catch-payment-flow-regressions-automatically-on-every-change.md](./backlog/164-catch-payment-flow-regressions-automatically-on-every-change.md) |
| [#168](./backlog/168-cover-the-new-rescreen-on-edit-behavior-with-an-integration-test.md) | Cover the new rescreen-on-edit behavior with an integration test | 📋 Backlog | Stub: [docs/sprints/backlog/168-cover-the-new-rescreen-on-edit-behavior-with-an-integration-test.md](./backlog/168-cover-the-new-rescreen-on-edit-behavior-with-an-integration-test.md) |
| [#225](./backlog/225-catch-heartbeat-workflows-that-forgot-the-schedule-block-before-they-ship.md) | Catch heartbeat workflows that forgot the schedule block before they ship | ✅ Implemented | Code implemented in this PR |
| [#227](./backlog/227-catch-missing-user-id-foreign-keys-before-they-reach-production.md) | Catch missing user-id foreign keys before they reach production | 📋 Backlog | Stub: [docs/sprints/backlog/227-catch-missing-user-id-foreign-keys-before-they-reach-production.md](./backlog/227-catch-missing-user-id-foreign-keys-before-they-reach-production.md) |
| [#229](./backlog/229-warn-when-the-same-rate-limit-opt-out-keeps-getting-its-sunset-extended.md) | Warn when the same rate-limit opt-out keeps getting its sunset extended | 📋 Backlog | Stub: [docs/sprints/backlog/229-warn-when-the-same-rate-limit-opt-out-keeps-getting-its-sunset-extended.md](./backlog/229-warn-when-the-same-rate-limit-opt-out-keeps-getting-its-sunset-extended.md) |
| [#235](./backlog/235-catch-the-same-opt-out-paperwork-gap-when-ops-set-the-env-var-by-hand.md) | Catch the same opt-out paperwork gap when ops set the env var by hand | 📋 Backlog | Stub: [docs/sprints/backlog/235-catch-the-same-opt-out-paperwork-gap-when-ops-set-the-env-var-by-hand.md](./backlog/235-catch-the-same-opt-out-paperwork-gap-when-ops-set-the-env-var-by-hand.md) |
