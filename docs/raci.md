# RACI — Epplaa Platform v4.2 program

- **R**esponsible — does the work.
- **A**ccountable — owns the outcome (one and only one per row).
- **C**onsulted — two-way input before the work is final.
- **I**nformed — kept up to date one-way.

Roles in this matrix:

- **Arch WG** — Architecture Working Group (chair, two senior eng).
- **CTO** — Chief Technology Officer.
- **Sec** — Security Engineering.
- **SRE / Plat** — Site Reliability / Platform Engineering.
- **Backend** — Backend Engineering.
- **Frontend** — Frontend Engineering (web).
- **Mobile** — Mobile Engineering.
- **QE** — Quality Engineering.
- **Prod** — Product.
- **DPO** — Data Protection Officer.
- **Fin** — Finance / Compliance.

## Phase-level RACI

| Item | Arch WG | CTO | Sec | SRE/Plat | Backend | Frontend | Mobile | QE | Prod | DPO | Fin |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| ADRs (Phase 0) | A/R | C | C | C | C | C | C | I | I | C | I |
| v4.2 amendment signoff | R | A | C | C | I | I | I | I | C | C | C |
| Repository restructure (Phase 1) | A | I | I | C | R | R | R | I | I | I | I |
| IaC foundation: Terraform / k3s / Helm (Phase 2) | C | I | C | A/R | I | I | I | I | I | I | I |
| First Helm cutover of api-monolith | C | I | I | A/R | C | I | I | I | I | I | I |
| Vault rollout (Phase 3) | C | I | A | R | C | I | I | I | I | C | I |
| OpenTelemetry wiring (Phase 3) | C | I | I | A/R | C | C | C | C | I | I | I |
| Linkerd install + monolith mesh (Phase 3) | C | I | C | A/R | I | I | I | I | I | I | I |
| `packages/events` introduction (Phase 3) | C | I | I | C | A/R | I | I | C | I | I | I |
| Service extraction template (Phase 4 sprint 0) | A | I | C | C | R | I | I | C | I | I | I |
| notification-service extraction | C | I | I | C | A/R | I | I | C | I | I | I |
| identity-service extraction | C | I | A | C | R | C | C | C | I | C | I |
| catalog-service extraction | C | I | I | C | A/R | C | C | C | C | I | I |
| manufacturer-service extraction | C | I | I | C | A/R | C | I | C | C | I | I |
| cart-service extraction | C | I | I | C | A/R | C | C | C | C | I | I |
| payment-service extraction | A | C | A | C | R | I | I | C | C | C | C |
| order-service extraction | C | I | I | C | A/R | C | C | C | C | I | I |
| fulfillment-service extraction | C | I | I | C | A/R | C | I | C | C | I | I |
| discovery-service extraction | C | I | I | C | A/R | C | C | C | C | I | I |
| stream-service extraction | C | C | C | C | A/R | C | C | C | C | I | I |
| admin-service extraction | C | I | C | C | A/R | C | I | C | C | I | I |
| analytics-service extraction | C | I | I | C | A/R | I | I | C | C | C | I |
| Live-streaming pipeline (Phase 5) | C | C | C | R | A | C | C | C | C | I | I |
| Buyer Next.js migration (Phase 6) | C | I | I | C | C | A/R | I | C | C | I | I |
| Mobile RN buildout (Phase 7) | C | I | C | C | C | I | A/R | C | C | I | I |
| Operator/studio/partner apps (Phase 8) | C | I | I | I | C | A/R | I | C | C | I | I |
| Quality engineering rollout (Phase 9) | C | I | C | C | C | C | C | A/R | I | I | I |
| Compliance — PCI CDF | C | I | A | I | C | I | I | I | I | C | R |
| Compliance — NDPR data inventory | C | I | A | I | C | C | C | I | C | R | I |
| DR drill (Phase 10) | C | I | I | A/R | C | I | I | C | I | I | I |
| Beta cohort + feature flags | C | I | I | C | C | C | C | C | A/R | I | I |
| Launch checklist signoff | A | A | A | A | A | A | A | A | A | A | A |

(The launch row is intentionally "A" across the table — every named
role must approve.)

## Reading notes

- The strangler-fig extractions intentionally leave Backend
  accountable for everything except payment-service, where Sec/Arch
  WG share accountability because of PCI scope reduction.
- Frontend is C (consulted) on most service extractions because each
  extraction may change the API shape `apps/web` and `apps/web-buyer-spa`
  consume.
- Mobile is C on extractions that change API shape, A only when the
  primary work is in `apps/mobile`.
- DPO is C on extractions touching identifiable buyer data
  (identity, payment, analytics) and the compliance rows.
