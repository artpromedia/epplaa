# #150 — Fail CI if the OpenAPI spec drifts from the generated client/zod files

**Sprint:** Sprint 3 — CI/CD, Testing & DevOps Gates  
**Status:** Implemented  

## Problem Statement

Fail CI if the OpenAPI spec drifts from the generated client/zod files. This task tracks the work required to implement, test, and deploy this capability as described in the sprint plan.

## Acceptance Criteria

- [ ] Implementation matches the acceptance criteria
- [ ] Existing tests continue to pass
- [ ] Code is reviewed and merged to main

## Relevant Files

- `lib/api-spec/openapi.yaml` — OpenAPI spec
- `lib/api-zod/` — generated Zod schemas
- `packages/api-client-react/` — generated React Query hooks
- `.github/workflows/ci.yml` — main CI workflow
