# #181 — Notify viewers when they're promoted to moderator

**Sprint:** Sprint 6 — Notifications & Messaging  
**Status:** Implemented  

## Problem Statement

Notify viewers when they're promoted to moderator. This task tracks the work required to implement, test, and deploy this capability as described in the sprint plan.

## Acceptance Criteria

- [ ] A push/in-app notification is sent to the viewer immediately upon moderator promotion
- [ ] The notification message clearly states the stream or channel for which they are now a moderator
- [ ] Notification delivery is covered by an integration test that verifies the correct recipient and content

## Relevant Files

- `services/api-monolith/src/lib/audit.ts` — audit logging
