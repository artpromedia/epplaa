# #217 — Show the backup row-count trend on the admin status panel

**Sprint:** Sprint 4 — Backup, Data Integrity & Audit Pipeline  
**Status:** Backlog  

## Problem Statement

Show the backup row-count trend on the admin status panel. This task tracks the work required to implement, test, and deploy this capability as described in the sprint plan.

## Acceptance Criteria

- [ ] Backup artefact is produced on schedule
- [ ] Verification script passes against the new artefact
- [ ] Stale-backup alert fires when artefact is overdue

## Relevant Files

- `scripts/src/verifyBackup.ts` — backup verification
- `artifacts/admin-console/src/` — admin console React app
