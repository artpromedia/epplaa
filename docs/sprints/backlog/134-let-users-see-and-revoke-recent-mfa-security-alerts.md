# #134 — Let users see and revoke recent MFA security alerts

**Sprint:** Sprint 1 — Security, MFA & Auth  
**Status:** Implemented  

## Problem Statement

Let users see and revoke recent MFA security alerts. This task tracks the work required to implement, test, and deploy this capability as described in the sprint plan.

## Acceptance Criteria

- [ ] Alert fires within the defined threshold
- [ ] On-call receives the page via PagerDuty / Slack
- [ ] Runbook entry documents response steps

## Relevant Files

- `artifacts/api-server/src/routes/mfa.ts` — MFA route handlers
- `artifacts/api-server/src/lib/mfa.ts` — MFA business logic
- `artifacts/api-server/src/lib/auth.ts` — auth helpers
