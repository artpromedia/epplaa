# #216 — Make the new week-over-week backup check actually work in production

**Sprint:** Sprint 4 — Backup, Data Integrity & Audit Pipeline  
**Status:** Implemented  

## Problem Statement

Make the new week-over-week backup check actually work in production. This task tracks the work required to implement, test, and deploy this capability as described in the sprint plan.

## Acceptance Criteria

- [ ] Backup artefact is produced on schedule
- [ ] Verification script passes against the new artefact
- [ ] Stale-backup alert fires when artefact is overdue

## Relevant Files

- `scripts/src/verifyBackup.ts` — backup verification
