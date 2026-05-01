# #135 — Send the same security alert when MFA is disabled

**Sprint:** Sprint 1 — Security, MFA & Auth  
**Status:** Implemented  

## Problem Statement

Send the same security alert when MFA is disabled. This task tracks the work required to implement, test, and deploy this capability as described in the sprint plan.

## Acceptance Criteria

- [ ] Alert fires within the defined threshold
- [ ] On-call receives the page via PagerDuty / Slack
- [ ] Runbook entry documents response steps

## Relevant Files

- `services/api-monolith/src/routes/mfa.ts` — MFA route handlers
- `services/api-monolith/src/lib/mfa.ts` — MFA business logic
