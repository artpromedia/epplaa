# #234 — Catch checksum-flow regressions with end-to-end tests

**Sprint:** Sprint 4 — Backup, Data Integrity & Audit Pipeline  
**Status:** Implemented  

## Problem Statement

Catch checksum-flow regressions with end-to-end tests. This task tracks the work required to implement, test, and deploy this capability as described in the sprint plan.

## Acceptance Criteria

- [ ] Tests are written and pass in CI
- [ ] Edge cases are covered
- [ ] CI gate blocks merges on failure

## Relevant Files

- `scripts/src/verifyBackup.ts` — backup verification
