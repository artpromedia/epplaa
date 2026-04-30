# #211 — Auto-page on the seven other production-secret warnings

**Sprint:** Sprint 2 — On-Call, Alerting & Incident Response  
**Status:** Backlog  

## Problem Statement

Auto-page on the seven other production-secret warnings. This task tracks the work required to implement, test, and deploy this capability as described in the sprint plan.

## Acceptance Criteria

- [ ] Alert fires within the defined threshold
- [ ] On-call receives the page via PagerDuty / Slack
- [ ] Runbook entry documents response steps

## Relevant Files

- `scripts/src/sentryMonitors.config.ts` — Sentry monitor config
