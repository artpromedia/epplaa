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

- `services/api-monolith/src/routes/mfa.ts` — MFA route handlers
- `services/api-monolith/src/lib/mfa.ts` — MFA business logic
- `services/api-monolith/src/lib/auth.ts` — auth helpers
