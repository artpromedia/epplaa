# #149 — Catch contract drift across all API responses, not just MFA

**Sprint:** Sprint 11 — API Contracts & Code Generation  
**Status:** Implemented  

## Problem Statement

Catch contract drift across all API responses, not just MFA. This task tracks the work required to implement, test, and deploy this capability as described in the sprint plan.

## Acceptance Criteria

- [ ] Tests are written and pass in CI
- [ ] Edge cases are covered
- [ ] CI gate blocks merges on failure

## Relevant Files

- `lib/api-spec/openapi.yaml` — OpenAPI spec
- `lib/api-zod/` — generated Zod schemas
- `lib/api-client-react/` — generated React Query hooks
