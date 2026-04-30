# #151 — Page on-call when database or audit-pipeline subsystems go degraded too

**Sprint:** Sprint 2 — On-Call, Alerting & Incident Response  
**Status:** Backlog  

## Problem Statement

Page on-call when database or audit-pipeline subsystems go degraded too. This task tracks the work required to implement, test, and deploy this capability as described in the sprint plan.

## Acceptance Criteria

- [ ] Alert fires within the defined threshold
- [ ] On-call receives the page via PagerDuty / Slack
- [ ] Runbook entry documents response steps

## Relevant Files

- `artifacts/api-server/src/lib/audit.ts` — audit logging
