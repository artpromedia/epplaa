# AI Sprint Plan — v4.2 Agentic AI Backbone

- **Status**: Active
- **Date**: 2026-04-30
- **Owner**: AI Platform Eng + Architecture WG
- **Source**: §14.14 of `docs/architecture/v4.2/Epplaa_Architecture_Sprint_Plan_v4.2.md`

Ten AI Sprints (AI 0 – AI 9) are layered onto the main sprint plan. They are numbered independently but have hard dependencies on main sprints 5, 9, and 12.

---

## AI Sprint 0 — Scaffolding

**Theme**: Establish the foundational `services/agent-service/` skeleton so that all subsequent AI sprints have a compilable, testable base.

**Exit criteria**:
- `tsc --noEmit` passes for `services/agent-service/`.
- Smoke test (`AgentRuntime.test.ts`) passes in CI.
- `services/agent-service` CI workflow (`.github/workflows/agent-service.yml`) is green.
- All ADRs (010–015) committed and cross-referenced.
- Risk register and integration directory entries committed.
- Prompt Registry interface defined (in-memory stub; DB-backed in AI Sprint 1).
- Tool Registry defined with all §14.7.2 sample tools and ADR-014 approval defaults enforced.

**Language coverage**: None (no LLM calls in Sprint 0).

---

## AI Sprint 1 — Runtime Core + Vendor Onboarding Agent

**Theme**: Wire up the full AgentRuntime lifecycle, DB-backed Prompt Registry, and deploy the Vendor Onboarding Agent.

**Exit criteria**:
- Vendor Onboarding Agent handles 10 golden test cases with ≥ 70% resolution rate.
- Prompt Registry migrated from in-memory stub to database-backed storage.
- LiteLLM gateway deployed to FSN1; Anthropic + OpenAI backends configured.
- Langfuse traces visible for all LLM calls.
- Per-agent budget cap enforced in LiteLLM.
- Short-term Redis memory wired up; 30-minute TTL confirmed.

**Language coverage**: English only.

**Dependencies**: Main Sprint 5 (catalog service extracted; `catalog.search` and `catalog.create_draft` APIs available).

---

## AI Sprint 2 — Buyer Concierge + Seller Copilot Agents

**Theme**: Deploy the two highest-volume customer-facing agents.

**Exit criteria**:
- Buyer Concierge handles 10 golden test cases (order status, returns, FAQ) with p95 < 2 s.
- Seller Copilot handles 10 golden test cases (catalog management, pricing) with p95 < 2 s.
- Approval Bus (Redpanda `agent.proposed_action`) integration tested: `order.return_request` and `payment.refund_request` require human approval before execution.
- Ops UI shows pending approval queue.

**Language coverage**: English only.

**Dependencies**: Main Sprint 9 (order and payment services extracted; `order.read`, `order.return_request`, `payment.refund_request` APIs available).

---

## AI Sprint 3 — Fraud & Counterfeit Agent

**Theme**: Deploy the Trust & Safety agent with auto-takedown capability.

**Exit criteria**:
- Fraud & Counterfeit Agent achieves precision ≥ 90% and false-positive rate < 5% on eval set.
- `listing.auto_takedown` requires human approval; approval event round-trip tested.
- `listing.flag_for_review` routes to Trust & Safety queue.
- Long-term memory (pgvector) wired up; fraud pattern embeddings seeded.

**Language coverage**: English only.

**Dependencies**: AI Sprint 1 (runtime core stable).

---

## AI Sprint 4 — Ops On-Call Agent

**Theme**: Deploy the internal agent for on-call engineers.

**Exit criteria**:
- Ops On-Call Agent achieves p95 runbook retrieval < 1.5 s.
- `runbook.search` returns relevant results for 20 golden incident prompts.
- `escalation.handoff_to_human` tested; PagerDuty integration confirmed.
- Ops agents do NOT require `single-human` approval for read-only tools.

**Language coverage**: English only.

**Dependencies**: AI Sprint 2 (approval bus stable).

---

## AI Sprint 5 — Voice Pipeline

**Theme**: Add voice input/output to all five agents.

**Exit criteria**:
- LiveKit Agents worker deployed; connects to existing LiveKit SFU.
- Deepgram English ASR: e2e ASR-to-first-token < 1 s p95.
- Cartesia English TTS: first audio chunk < 500 ms p95.
- All five agents reachable via voice.
- Nigerian Pidgin voice tested for Buyer Concierge.

**Language coverage**: English + Nigerian Pidgin.

**Dependencies**: Main Sprint 12 (LiveKit streaming infrastructure stable).

---

## AI Sprint 6 — Tier B African Languages

**Theme**: Enable Yoruba, Hausa, and Igbo for the Buyer Concierge (highest-volume agent).

**Exit criteria**:
- Intron Sahara v2 ASR integration: Yoruba, Hausa, Igbo ASR latency ≤ 300 ms p95.
- Lelapa Vulavula translation pivot: BLEU score ≥ 0.65 on nightly eval.
- Buyer Concierge tested end-to-end in all three Tier B languages.
- Braintrust Tier B eval suite established.
- R-AI-003 and R-AI-005 trip-wire monitoring active.

**Language coverage**: All Tiers (A, B, C).

**Dependencies**: AI Sprint 5 (voice pipeline stable).

---

## AI Sprint 7 — Autonomy Review (ROI Gate)

**Theme**: Evaluate month-6 ROI gate; if passed, propose autonomy ceiling expansion via new ADR.

**Exit criteria**:
- KPI dashboard shows ≥ 3/5 headline targets met:
  1. Vendor onboarding time reduced ≥ 30% vs. baseline.
  2. Buyer resolution rate ≥ 70% without human escalation.
  3. Fraud detection precision ≥ 90%.
  4. Ops MTTR reduced ≥ 20% vs. baseline.
  5. Net-promoter delta ≥ +5 points for AI-assisted interactions.
- If gate passes: new ADR drafted proposing specific act-without-approval tools; Architecture WG vote.
- If gate fails: AI Sprint 7 marked blocked; findings presented to Architecture WG and board.

**Language coverage**: All tiers (assessment only; no new language work).

**Dependencies**: AI Sprint 4 (all five agents in production for ≥ 6 months before ROI gate evaluation).

---

## AI Sprint 8 — Eval & Hardening

**Theme**: Comprehensive evaluation, security hardening, and PII audit.

**Exit criteria**:
- Braintrust nightly evals green for all five agents (all eval targets met).
- Prompt injection red-team passed: no successful injection in 200 adversarial test cases.
- PII audit passed: no Nigerian PII (phone numbers, BVN, NIN fragments) found in Langfuse trace logs.
- Multi-model voting hook implemented for `listing.auto_takedown` and `payment.refund_request`.
- SeamlessM4T self-hosted prototype evaluated (feasibility assessment only).

**Language coverage**: All tiers.

**Dependencies**: AI Sprint 6 (full language stack stable).

---

## AI Sprint 9 — GA Readiness

**Theme**: Load testing, SLO validation, and security sign-off.

**Exit criteria**:
- Load test: 500 concurrent sessions sustained for 30 minutes; all agent p95 SLOs met.
- All five agents: p95 response within declared SLOs (§14.2).
- Security review signed off by Security Eng.
- Operational runbooks written and reviewed for all five agents.
- Monitoring dashboards (Grafana) live for all agent SLOs and risk trip-wires.
- DR drill: agent service failover FSN1 → HEL1 within RTO.

**Language coverage**: All tiers.

**Dependencies**: AI Sprint 8 (hardening complete).

---

## Dependency map: AI Sprints ↔ Main Sprints

| AI Sprint | Depends on main sprint | Reason |
| :--- | :--- | :--- |
| AI 1 | Sprint 5 | Catalog service extracted; `catalog.search` API available |
| AI 2 | Sprint 9 | Order + payment services extracted; `order.*` and `payment.*` APIs available |
| AI 5 | Sprint 12 | LiveKit streaming infrastructure stable; LiveKit Agents worker can connect |

All other AI Sprints depend only on earlier AI Sprints (no main-sprint dependency).
