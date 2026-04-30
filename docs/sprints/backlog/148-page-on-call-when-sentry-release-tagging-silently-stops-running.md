# #148 — Page on-call when Sentry release tagging silently stops running

**Sprint:** Sprint 2 — On-Call, Alerting & Incident Response  
**Status:** Backlog  

## Problem Statement

Page on-call when Sentry release tagging silently stops running. This task tracks the work required to implement, test, and deploy this capability as described in the sprint plan.

## Acceptance Criteria

- [ ] Alert fires within the defined threshold
- [ ] On-call receives the page via PagerDuty / Slack
- [ ] Runbook entry documents response steps

## Relevant Files

- `scripts/src/sentryMonitors.config.ts` — Sentry monitor config
- `scripts/src/checkSentryMonitorsInSync.ts` — Sentry drift check
