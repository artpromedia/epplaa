# #153 — Wire OpenTelemetry metrics export so retention gauges actually leave the box

**Sprint:** Sprint 13 — Ops Tooling & Monitoring Infrastructure  
**Status:** Implemented  

## Problem Statement

Wire OpenTelemetry metrics export so retention gauges actually leave the box. This task tracks the work required to implement, test, and deploy this capability as described in the sprint plan.

## Acceptance Criteria

- [ ] Implementation matches the acceptance criteria
- [ ] Existing tests continue to pass
- [ ] Code is reviewed and merged to main

## Relevant Files

- `artifacts/api-server/src/lib/otel.ts` — OpenTelemetry setup
- `artifacts/api-server/src/lib/retention.ts` — retention logic
