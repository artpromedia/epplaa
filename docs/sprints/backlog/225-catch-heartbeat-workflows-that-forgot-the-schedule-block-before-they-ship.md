# #225 — Catch heartbeat workflows that forgot the schedule block before they ship

**Sprint:** Sprint 3 — CI/CD, Testing & DevOps Gates  
**Status:** Implemented  

## Problem Statement

Catch heartbeat workflows that forgot the schedule block before they ship. This task tracks the work required to implement, test, and deploy this capability as described in the sprint plan.

## Acceptance Criteria

- [ ] Tests are written and pass in CI
- [ ] Edge cases are covered
- [ ] CI gate blocks merges on failure

## Relevant Files

- `.github/workflows/ci.yml` — main CI workflow
- `scripts/src/checkSentryMonitorsInSync.ts` — Sentry drift check
