# #214 — Share the post-deploy probe wrapper between production gate and rehearsal

**Sprint:** Sprint 2 — On-Call, Alerting & Incident Response  
**Status:** Implemented  

## Problem Statement

Share the post-deploy probe wrapper between production gate and rehearsal. This task tracks the work required to implement, test, and deploy this capability as described in the sprint plan.

## Acceptance Criteria

- [ ] A single shared probe-wrapper module is used by both the production gate and the rehearsal workflow
- [ ] Duplicate code is removed from both call sites
- [ ] Both workflows continue to pass in CI after the refactor

## Relevant Files

- `scripts/src/checkSentryMonitorsInSync.ts` — Sentry drift check
