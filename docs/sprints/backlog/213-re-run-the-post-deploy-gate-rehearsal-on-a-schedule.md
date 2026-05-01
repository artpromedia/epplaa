# #213 — Re-run the post-deploy gate rehearsal on a schedule

**Sprint:** Sprint 2 — On-Call, Alerting & Incident Response  
**Status:** Implemented  

## Problem Statement

Re-run the post-deploy gate rehearsal on a schedule. This task tracks the work required to implement, test, and deploy this capability as described in the sprint plan.

## Acceptance Criteria

- [ ] Implementation matches the acceptance criteria
- [ ] Existing tests continue to pass
- [ ] Code is reviewed and merged to main

## Relevant Files

- `scripts/src/checkSentryMonitorsInSync.ts` — Sentry drift check
- `.github/workflows/ci.yml` — main CI workflow
