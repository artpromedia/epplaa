# #237 — Show on-call which servers think a payment provider is down

**Sprint:** Sprint 2 — On-Call, Alerting & Incident Response  
**Status:** Implemented  

## Problem Statement

Show on-call which servers think a payment provider is down. This task tracks the work required to implement, test, and deploy this capability as described in the sprint plan.

## Acceptance Criteria

- [ ] Feature is visible in the admin console UI
- [ ] Appropriate permission checks are enforced
- [ ] UI renders correctly in the existing test suite

## Relevant Files

- `services/api-monolith/src/lib/audit.ts` — audit logging
