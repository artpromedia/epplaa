# #158 — Have the backup producer write a counts manifest beside each dump

**Sprint:** Sprint 4 — Backup, Data Integrity & Audit Pipeline  
**Status:** Backlog  

## Problem Statement

Have the backup producer write a counts manifest beside each dump. This task tracks the work required to implement, test, and deploy this capability as described in the sprint plan.

## Acceptance Criteria

- [ ] Backup artefact is produced on schedule
- [ ] Verification script passes against the new artefact
- [ ] Stale-backup alert fires when artefact is overdue

## Relevant Files

- `scripts/src/verifyBackup.ts` — backup verification
