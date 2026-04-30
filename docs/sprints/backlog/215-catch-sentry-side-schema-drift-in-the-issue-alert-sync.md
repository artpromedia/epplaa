# #215 — Catch Sentry-side schema drift in the issue-alert sync

**Sprint:** Sprint 2 — On-Call, Alerting & Incident Response  
**Status:** Backlog  

## Problem Statement

Catch Sentry-side schema drift in the issue-alert sync. This task tracks the work required to implement, test, and deploy this capability as described in the sprint plan.

## Acceptance Criteria

- [ ] Tests are written and pass in CI
- [ ] Edge cases are covered
- [ ] CI gate blocks merges on failure

## Relevant Files

- `scripts/src/checkSentryMonitorsInSync.ts` — Sentry drift check
