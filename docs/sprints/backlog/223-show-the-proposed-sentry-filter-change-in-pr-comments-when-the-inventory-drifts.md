# #223 — Show the proposed Sentry filter change in PR comments when the inventory drifts

**Sprint:** Sprint 13 — Ops Tooling & Monitoring Infrastructure  
**Status:** Backlog  

## Problem Statement

Show the proposed Sentry filter change in PR comments when the inventory drifts. This task tracks the work required to implement, test, and deploy this capability as described in the sprint plan.

## Acceptance Criteria

- [ ] CI script detects drift between the live Sentry filter inventory and the repo-managed config
- [ ] A formatted diff of the proposed Sentry filter change is posted as a PR comment automatically
- [ ] The check runs on every PR that touches the Sentry monitor config or inventory script

## Relevant Files

- `scripts/src/checkSentryMonitorsInSync.ts` — Sentry drift check
