# #178 — Provision the shared Redis the multi-instance chat actually needs

**Sprint:** Sprint 12 — Chat & Real-time Infrastructure  
**Status:** Backlog  

## Problem Statement

Provision the shared Redis the multi-instance chat actually needs. This task tracks the work required to implement, test, and deploy this capability as described in the sprint plan.

## Acceptance Criteria

- [ ] Backup artefact is produced on schedule
- [ ] Verification script passes against the new artefact
- [ ] Stale-backup alert fires when artefact is overdue

## Relevant Files

- `artifacts/api-server/src/lib/audit.ts` — audit logging
