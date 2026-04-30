# Risk Register — Epplaa Platform

- **Status**: Initial draft (Phase 0 of v4.2 amendment)
- **Owner**: Architecture WG
- **Cadence**: Reviewed at the start of every sprint; risks added,
  closed, or re-scored as the program evolves.

Risks are scored on **Likelihood × Impact** (1–5 each, 1 = lowest).
The score column is the product. Status is one of: open, mitigating,
accepted, closed.

## Program risks

| ID | Risk | L | I | Score | Owner | Mitigation | Status |
| :--- | :--- | :---: | :---: | :---: | :--- | :--- | :--- |
| R-001 | Strangler-fig extraction takes longer than 12 sprints; monolith never empties | 3 | 4 | 12 | Arch WG | Sprint review forces re-evaluation if 3 consecutive extractions slip; Phase 4 order is reorderable | Open |
| R-002 | Gateway / observability substrate (Phase 2/3) lands later than first extraction needs | 4 | 5 | 20 | Platform | Phase 2 must merge before Phase 4 step 1; ADR-0001 explicitly orders this | Open |
| R-003 | Vault rollout breaks production reads of secrets during cutover | 2 | 5 | 10 | Platform | Phased migration (ADR-0010), one secret group at a time, dual-read window per group | Open |
| R-004 | Clerk vendor lock-in deepens; migration cost grows past trigger threshold | 3 | 3 | 9 | Security | Identity boundary owned by `services/identity-service`; one-service swap | Mitigating |
| R-005 | RN performance regresses on Nigerian mid-tier Android | 3 | 4 | 12 | Mobile | Per-build perf budgets in CI (Phase 9); device-lab pre-launch | Open |
| R-006 | Lagos edge ingest tier latency exceeds 250 ms p95 budget | 3 | 4 | 12 | Streaming | Multi-PoP fallback in Phase 5; transcoding offload to FSN1 if edge saturates | Open |
| R-007 | NDPC ruling forces relocation of session storage from Clerk US region | 2 | 5 | 10 | Security / Legal | ADR-0003 trigger; identity-service abstraction makes swap viable | Open |
| R-008 | Paystack or Flutterwave outage during launch peak | 4 | 4 | 16 | Payments | Dual-rail design (one provider out → automatic re-route at gateway level); idempotency keys in payment-service | Mitigating |
| R-009 | DR drill (FSN1 → HEL1) fails to meet RPO/RTO; we discover post-launch | 3 | 5 | 15 | Platform | DR drill in Phase 10 is a hard gate before launch; runbook signed | Open |
| R-010 | OpenSearch / ClickHouse gates fire simultaneously and overload Phase 3 capacity | 2 | 3 | 6 | Backend | Gates are independently triggered; if both fire, Postgres FTS can absorb extra load for 1 sprint | Open |
| R-011 | OPA policy bug locks admins out of the cluster | 2 | 4 | 8 | Platform | Break-glass admin ServiceAccount that bypasses OPA; rotation policy | Open |
| R-012 | Replit dev environment drifts from production runtime (Node 24 vs Replit's default) | 2 | 2 | 4 | Platform | `.nvmrc` pin (this PR); CI runs Node 24; devcontainer for parity in a follow-up PR | Mitigating |
| R-013 | Service-extraction ordering creates a circular dependency (e.g., catalog needs cart needs catalog) | 3 | 4 | 12 | Backend | Order in v4.2 amendment §Phase 4 is dependency-respecting; cross-service calls use events, not sync RPC, where possible | Open |
| R-014 | Studio carve-out (Phase 8) breaks seller workflows mid-campaign | 3 | 3 | 9 | Frontend | Studio app launched at `studio.epplaa.com` and run in parallel with the SPA pages until parity, then SPA pages redirect | Open |
| R-015 | Test coverage gate (Phase 9, 80%/90%) regresses CI time materially | 3 | 2 | 6 | QE | Selective per-package coverage; coverage exclusions for generated code | Open |
| R-016 | CodeQL / Trivy / Semgrep flag-volume blocks PRs (alert fatigue) | 4 | 2 | 8 | Security | Curated rule sets; baseline existing findings; only new findings block | Open |
| R-017 | Storefront SEO regresses during Vite SPA → Next.js cutover | 3 | 4 | 12 | Frontend | Run both at separate domains; redirect at gateway only when parity verified | Open |
| R-018 | Compliance docs (PCI CDF, NDPR data inventory) lag launch readiness | 3 | 5 | 15 | Security / DPO | Phase 10 hard gates; weekly review starting at Phase 7 | Open |
| R-019 | Schema-first event design (`packages/events`) under-specifies, leading to consumer breakage at Redpanda cutover | 3 | 3 | 9 | Backend | Avro compatibility rules enforced from day one; consumer contract tests in CI | Open |
| R-020 | Single Architecture WG bottleneck blocks ADR review velocity | 3 | 3 | 9 | Arch WG | ADR review is async with a 5-business-day SLA; rotating chair | Open |

## How to use this register

- Adding a risk: open a PR amending this file; an Architecture WG
  member must approve.
- Closing a risk: link the closing PR / runbook in the row and set
  status to `closed`. Closed rows are kept for audit.
- Re-scoring: change L and I in the same PR that explains why.
