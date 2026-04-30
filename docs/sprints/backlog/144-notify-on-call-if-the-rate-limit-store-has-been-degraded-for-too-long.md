# #144 — Notify on-call if the rate-limit store has been degraded for too long

**Sprint:** Sprint 2 — On-Call, Alerting & Incident Response  
**Status:** Backlog  

## Problem Statement

Notify on-call if the rate-limit store has been degraded for too long. This task tracks the work required to implement, test, and deploy this capability as described in the sprint plan.

## Acceptance Criteria

- [ ] Alert fires within the defined threshold
- [ ] On-call receives the page via PagerDuty / Slack
- [ ] Runbook entry documents response steps

## Relevant Files

- `scripts/src/checkRateLimitOptOutPrInventory.ts` — rate limit opt-out inventory
