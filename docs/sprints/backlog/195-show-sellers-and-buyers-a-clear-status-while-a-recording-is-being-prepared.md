# #195 — Show sellers and buyers a clear status while a recording is being prepared

**Sprint:** Sprint 6 — Notifications & Messaging  
**Status:** Implemented  

## Problem Statement

Show sellers and buyers a clear status while a recording is being prepared. This task tracks the work required to implement, test, and deploy this capability as described in the sprint plan.

## Acceptance Criteria

- [ ] Audit entry is written on every relevant event
- [ ] Entry includes actor, timestamp, and resource id
- [ ] Entries are queryable in the admin console

## Relevant Files

- `services/api-monolith/src/lib/audit.ts` — audit logging
