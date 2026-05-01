# #210 — Promote the carrier credential warnings into the audit table

**Sprint:** Sprint 7 — Shipping, Carriers & PUDO Delivery  
**Status:** Implemented  

## Problem Statement

Promote the carrier credential warnings into the audit table. This task tracks the work required to implement, test, and deploy this capability as described in the sprint plan.

## Acceptance Criteria

- [ ] Alert fires within the defined threshold
- [ ] On-call receives the page via PagerDuty / Slack
- [ ] Runbook entry documents response steps

## Relevant Files

- `services/api-monolith/src/lib/audit.ts` — audit logging
