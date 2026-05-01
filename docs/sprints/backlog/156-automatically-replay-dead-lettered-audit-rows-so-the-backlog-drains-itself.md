# #156 — Automatically replay dead-lettered audit rows so the backlog drains itself

**Sprint:** Sprint 4 — Backup, Data Integrity & Audit Pipeline  
**Status:** Implemented  

## Problem Statement

Automatically replay dead-lettered audit rows so the backlog drains itself. This task tracks the work required to implement, test, and deploy this capability as described in the sprint plan.

## Acceptance Criteria

- [ ] Audit entry is written on every relevant event
- [ ] Entry includes actor, timestamp, and resource id
- [ ] Entries are queryable in the admin console

## Relevant Files

- `services/api-monolith/src/lib/audit.ts` — audit logging
