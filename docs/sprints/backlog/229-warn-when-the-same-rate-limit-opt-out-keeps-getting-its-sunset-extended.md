# #229 — Warn when the same rate-limit opt-out keeps getting its sunset extended

**Sprint:** Sprint 3 — CI/CD, Testing & DevOps Gates  
**Status:** Backlog  

## Problem Statement

Warn when the same rate-limit opt-out keeps getting its sunset extended. This task tracks the work required to implement, test, and deploy this capability as described in the sprint plan.

## Acceptance Criteria

- [ ] Alert fires within the defined threshold
- [ ] On-call receives the page via PagerDuty / Slack
- [ ] Runbook entry documents response steps

## Relevant Files

- `scripts/src/checkRateLimitOptOutPrInventory.ts` — rate limit opt-out inventory
