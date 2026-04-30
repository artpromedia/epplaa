# #178 — Provision the shared Redis the multi-instance chat actually needs

**Sprint:** Sprint 12 — Chat & Real-time Infrastructure  
**Status:** Backlog  

## Problem Statement

Provision the shared Redis the multi-instance chat actually needs. This task tracks the work required to implement, test, and deploy this capability as described in the sprint plan.

## Acceptance Criteria

- [ ] A shared Redis instance is provisioned and reachable by all API server replicas
- [ ] Chat messages are correctly brokered across multiple server instances via the shared Redis
- [ ] Provisioning steps and connection config are documented in the runbook

## Relevant Files

- `artifacts/api-server/src/lib/audit.ts` — audit logging
