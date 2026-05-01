# #202 — Prove rate limits and MFA actually hold up under two live API servers

**Sprint:** Sprint 1 — Security, MFA & Auth  
**Status:** Backlog  

## Problem Statement

Prove rate limits and MFA actually hold up under two live API servers. This task tracks the work required to implement, test, and deploy this capability as described in the sprint plan.

## Acceptance Criteria

- [ ] Tests are written and pass in CI
- [ ] Edge cases are covered
- [ ] CI gate blocks merges on failure

## Relevant Files

- `services/api-monolith/src/routes/mfa.ts` — MFA route handlers
- `services/api-monolith/src/lib/mfa.ts` — MFA business logic
- `services/api-monolith/src/lib/auth.ts` — auth helpers
