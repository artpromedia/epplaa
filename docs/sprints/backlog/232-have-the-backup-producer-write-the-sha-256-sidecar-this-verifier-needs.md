# #232 — Have the backup producer write the SHA-256 sidecar this verifier needs

**Sprint:** Sprint 4 — Backup, Data Integrity & Audit Pipeline  
**Status:** Implemented  

## Problem Statement

Have the backup producer write the SHA-256 sidecar this verifier needs. This task tracks the work required to implement, test, and deploy this capability as described in the sprint plan.

## Acceptance Criteria

- [ ] Backup artefact is produced on schedule
- [ ] Verification script passes against the new artefact
- [ ] Stale-backup alert fires when artefact is overdue

## Relevant Files

- `scripts/src/verifyBackup.ts` — backup verification
