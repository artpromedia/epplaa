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

- `artifacts/api-server/src/routes/mfa.ts` — MFA route handlers
- `artifacts/api-server/src/lib/mfa.ts` — MFA business logic
- `artifacts/api-server/src/lib/auth.ts` — auth helpers
