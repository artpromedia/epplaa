# #223 — Show the proposed Sentry filter change in PR comments when the inventory drifts

**Sprint:** Sprint 13 — Ops Tooling & Monitoring Infrastructure  
**Status:** Backlog  

## Problem Statement

Show the proposed Sentry filter change in PR comments when the inventory drifts. This task tracks the work required to implement, test, and deploy this capability as described in the sprint plan.

## Acceptance Criteria

- [ ] Feature is visible in the admin console UI
- [ ] Appropriate permission checks are enforced
- [ ] UI renders correctly in the existing test suite

## Relevant Files

- `scripts/src/checkSentryMonitorsInSync.ts` — Sentry drift check
