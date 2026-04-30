# Sprint Backlog

This document is the authoritative sprint plan for the epplaa project.  
It contains **13 sprints** covering **97 unique tasks** (98 task assignments — #164 "Catch payment-flow regressions automatically on every change" appears in both Sprint 3 and Sprint 5: Sprint 3 owns the CI gate implementation, Sprint 5 gates the payment regression suite on it).

## Sprint Execution Order

| Sprint | Name | # Tasks | Key Theme |
|--------|------|---------|-----------|
| [Sprint 1](./Sprint01.md) | Security, MFA & Auth | 5 | Let users see and revoke recent MFA security alerts… |
| [Sprint 2](./Sprint02.md) | On-Call, Alerting & Incident Response | 21 | Notify on-call if the rate-limit store has been degraded for… |
| [Sprint 3](./Sprint03.md) | CI/CD, Testing & DevOps Gates | 10 | Block deploys when production env vars are misconfigured… |
| [Sprint 4](./Sprint04.md) | Backup, Data Integrity & Audit Pipeline | 12 | Automatically replay dead-lettered audit rows so the backlog… |
| [Sprint 5](./Sprint05.md) | Payments & Payouts | 6 | Lock in payout rules for split orders end-to-end… |
| [Sprint 6](./Sprint06.md) | Notifications & Messaging | 7 | Stop sending a duplicate 'on the way' message for locker pic… |
| [Sprint 7](./Sprint07.md) | Shipping, Carriers & PUDO Delivery | 6 | Test the full payment-to-dispatch order flow… |
| [Sprint 8](./Sprint08.md) | Live Streaming & Recordings | 5 | Add automated tests for the new live-stream moderator flow… |
| [Sprint 9](./Sprint09.md) | Seller & Shopper Experience | 7 | Surface unresolvable legacy streams to ops in the admin cons… |
| [Sprint 10](./Sprint10.md) | Admin Console & Moderation | 9 | Fix the broken Status page tests in the admin console… |
| [Sprint 11](./Sprint11.md) | API Contracts & Code Generation | 3 | Catch contract drift across all API responses, not just MFA… |
| [Sprint 12](./Sprint12.md) | Chat & Real-time Infrastructure | 2 | Provision the shared Redis the multi-instance chat actually … |
| [Sprint 13](./Sprint13.md) | Ops Tooling & Monitoring Infrastructure | 5 | Wire OpenTelemetry metrics export so retention gauges actual… |

## Sprint Files

- [Sprint 1 — Security, MFA & Auth](./Sprint01.md)
- [Sprint 2 — On-Call, Alerting & Incident Response](./Sprint02.md)
- [Sprint 3 — CI/CD, Testing & DevOps Gates](./Sprint03.md)
- [Sprint 4 — Backup, Data Integrity & Audit Pipeline](./Sprint04.md)
- [Sprint 5 — Payments & Payouts](./Sprint05.md)
- [Sprint 6 — Notifications & Messaging](./Sprint06.md)
- [Sprint 7 — Shipping, Carriers & PUDO Delivery](./Sprint07.md)
- [Sprint 8 — Live Streaming & Recordings](./Sprint08.md)
- [Sprint 9 — Seller & Shopper Experience](./Sprint09.md)
- [Sprint 10 — Admin Console & Moderation](./Sprint10.md)
- [Sprint 11 — API Contracts & Code Generation](./Sprint11.md)
- [Sprint 12 — Chat & Real-time Infrastructure](./Sprint12.md)
- [Sprint 13 — Ops Tooling & Monitoring Infrastructure](./Sprint13.md)

---

> Tasks marked ✅ Implemented were shipped in the current PR.  
> All other tasks are 📋 Backlog and have stub files in [backlog/](./backlog/).
