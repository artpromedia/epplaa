# #194 — Send sellers a notification when their recorded broadcast is ready

**Sprint:** Sprint 6 — Notifications & Messaging  
**Status:** Implemented  

## Problem Statement

Send sellers a notification when their recorded broadcast is ready. This task tracks the work required to implement, test, and deploy this capability as described in the sprint plan.

## Acceptance Criteria

- [ ] Audit entry is written on every relevant event
- [ ] Entry includes actor, timestamp, and resource id
- [ ] Entries are queryable in the admin console

## Relevant Files

- `services/api-monolith/src/lib/audit.ts` — audit logging
