# #176 — Add an integration test that runs the full PUDO push against a real database

**Sprint:** Sprint 7 — Shipping, Carriers & PUDO Delivery  
**Status:** Implemented  

## Problem Statement

Add an integration test that runs the full PUDO push against a real database. This task tracks the work required to implement, test, and deploy this capability as described in the sprint plan.

## Acceptance Criteria

- [ ] Tests are written and pass in CI
- [ ] Edge cases are covered
- [ ] CI gate blocks merges on failure

## Relevant Files

- `services/api-monolith/src/lib/audit.ts` — audit logging
