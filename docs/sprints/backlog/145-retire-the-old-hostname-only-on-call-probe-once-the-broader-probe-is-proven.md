# #145 — Retire the old hostname-only on-call probe once the broader probe is proven

**Sprint:** Sprint 2 — On-Call, Alerting & Incident Response  
**Status:** Backlog  

## Problem Statement

Retire the old hostname-only on-call probe once the broader probe is proven. This task tracks the work required to implement, test, and deploy this capability as described in the sprint plan.

## Acceptance Criteria

- [ ] Tests are written and pass in CI
- [ ] Edge cases are covered
- [ ] CI gate blocks merges on failure

## Relevant Files

- `scripts/src/checkSentryMonitorsInSync.ts` — Sentry drift check
