# #222 — Stop duplicating the inventory hostname-union parser between two scripts

**Sprint:** Sprint 13 — Ops Tooling & Monitoring Infrastructure  
**Status:** Implemented  

## Problem Statement

Stop duplicating the inventory hostname-union parser between two scripts. This task tracks the work required to implement, test, and deploy this capability as described in the sprint plan.

## Acceptance Criteria

- [ ] Implementation matches the acceptance criteria
- [ ] Existing tests continue to pass
- [ ] Code is reviewed and merged to main

## Relevant Files

- `scripts/src/checkSentryMonitorsInSync.ts` — Sentry drift check
- `scripts/src/checkRateLimitOptOutPrInventory.ts` — rate limit opt-out inventory
