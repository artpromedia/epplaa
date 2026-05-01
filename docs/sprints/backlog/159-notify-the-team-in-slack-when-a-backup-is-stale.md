# #159 — Notify the team in Slack when a backup is stale

**Sprint:** Sprint 4 — Backup, Data Integrity & Audit Pipeline  
**Status:** Implemented  

## Problem Statement

Notify the team in Slack when a backup is stale. This task tracks the work required to implement, test, and deploy this capability as described in the sprint plan.

## Acceptance Criteria

- [ ] Alert fires within the defined threshold
- [ ] On-call receives the page via PagerDuty / Slack
- [ ] Runbook entry documents response steps

## Relevant Files

- `scripts/src/verifyBackup.ts` — backup verification
