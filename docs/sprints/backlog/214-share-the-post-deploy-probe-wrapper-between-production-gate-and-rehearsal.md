# #214 — Share the post-deploy probe wrapper between production gate and rehearsal

**Sprint:** Sprint 2 — On-Call, Alerting & Incident Response  
**Status:** Backlog  

## Problem Statement

Share the post-deploy probe wrapper between production gate and rehearsal. This task tracks the work required to implement, test, and deploy this capability as described in the sprint plan.

## Acceptance Criteria

- [ ] Backup artefact is produced on schedule
- [ ] Verification script passes against the new artefact
- [ ] Stale-backup alert fires when artefact is overdue

## Relevant Files

- `scripts/src/checkSentryMonitorsInSync.ts` — Sentry drift check
