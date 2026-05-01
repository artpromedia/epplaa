# #199 — Record an audit-log entry every time an admin request is blocked for missing MFA

**Sprint:** Sprint 1 — Security, MFA & Auth  
**Status:** Implemented  

## Problem Statement

Record an audit-log entry every time an admin request is blocked for missing MFA. This task tracks the work required to implement, test, and deploy this capability as described in the sprint plan.

## Acceptance Criteria

- [ ] Audit entry is written on every relevant event
- [ ] Entry includes actor, timestamp, and resource id
- [ ] Entries are queryable in the admin console

## Relevant Files

- `services/api-monolith/src/lib/audit.ts` — audit logging
- `services/api-monolith/src/lib/auth.ts` — auth helpers
- `services/api-monolith/src/routes/mfa.ts` — MFA route handlers
