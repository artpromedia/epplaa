# #231 — Catch a broken Sentry pager forwarder before the next outage

**Sprint:** Sprint 2 — On-Call, Alerting & Incident Response  
**Status:** Implemented  

## Problem Statement

Catch a broken Sentry pager forwarder before the next outage. This task tracks the work required to implement, test, and deploy this capability as described in the sprint plan.

## Acceptance Criteria

- [ ] Tests are written and pass in CI
- [ ] Edge cases are covered
- [ ] CI gate blocks merges on failure

## Relevant Files

- `scripts/src/checkSentryMonitorsInSync.ts` — Sentry drift check
- `scripts/src/sentryMonitors.config.ts` — Sentry monitor config
