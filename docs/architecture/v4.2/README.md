# Epplaa Architecture v4.2 — What Changed from v4.1

- **Status**: Active
- **Date**: 2026-04-30
- **Supersedes**: `docs/architecture/v4.2-amendment.md` (which covered v4.1 → v4.2 non-AI amendments)

## Summary

v4.2 introduces **Part 14 — Agentic AI Backbone** as a self-contained AI architecture pillar layered onto the v4.1 platform. All prior v4.1 and v4.2-amendment decisions remain binding; this document extends them.

## New in v4.2 (compared with v4.2-amendment.md)

### Part 14 — Agentic AI Backbone

A dedicated runtime (`services/agent-service/`) hosts five v1 AI agents:

| Agent | Purpose |
| :--- | :--- |
| Vendor Onboarding | Guides new vendors through listing creation and compliance checks |
| Seller Copilot | Assists sellers with catalog management, pricing, and fulfillment |
| Buyer Concierge | Answers buyer questions, handles order status, and facilitates returns |
| Fraud & Counterfeit | Flags suspicious listings and initiates takedown workflows |
| Ops On-Call | Surfaces runbook guidance and escalation paths for operations engineers |

### Architecture Decision Records (ADR-010 – ADR-015)

| ADR | Decision |
| :--- | :--- |
| [ADR-010](../../adr/ADR-010-agent-runtime-pydantic-ai.md) | Agent runtime: Pydantic AI + thin in-house orchestration (TypeScript analogue) |
| [ADR-011](../../adr/ADR-011-anthropic-primary-openai-secondary.md) | LLM providers: Anthropic primary, OpenAI secondary, multi-provider via LiteLLM |
| [ADR-012](../../adr/ADR-012-three-tier-language-stack.md) | Three-tier language stack with translation pivot for Tier B |
| [ADR-013](../../adr/ADR-013-voice-on-livekit-agents.md) | Voice interface: LiveKit Agents reusing the existing LiveKit deployment |
| [ADR-014](../../adr/ADR-014-single-human-approval-autonomy-ceiling.md) | Autonomy ceiling: single human approval for all money/account/external-messaging actions |
| [ADR-015](../../adr/ADR-015-intron-lelapa-tier-1-vendors.md) | African-language vendors: Intron Sahara v2 + Lelapa Vulavula as Tier 1 |

### Six new risk-register entries (Appendix H)

See [`docs/risk-register/ai-backbone-risks.md`](../../risk-register/ai-backbone-risks.md):
prompt injection, AI cost runaway, code-switching UX failure, eval quality drift, Intron vendor concentration, AI ROI gate failure.

### Twelve new integration-directory entries (Appendix I)

See [`docs/integrations/ai-backbone-vendors.md`](../../integrations/ai-backbone-vendors.md):
Anthropic, OpenAI, Intron, Lelapa, Deepgram, Cartesia, ElevenLabs, Whisper, LiteLLM, Langfuse, Braintrust, Pydantic AI, LiveKit Agents, Twilio, WhatsApp Cloud API, pgvector.

### Ten AI Sprints (§14.14)

See [`docs/sprint-plan/ai-sprints.md`](../../sprint-plan/ai-sprints.md): AI 0 through AI 9, covering runtime scaffolding through multi-modal voice and ROI gate.

### Month-6 ROI Gate

The AI backbone ships with a hard gate at month 6 post-launch: if three of the five headline KPIs (vendor onboarding time, buyer resolution rate, fraud detection precision, ops MTTR, net-promoter delta) do not meet target, AI Sprint 7 (autonomous act-without-approval expansion) is blocked pending Architecture WG review.

## Authoritative document

The full v4.2 spec lives at [`Epplaa_Architecture_Sprint_Plan_v4.2.md`](./Epplaa_Architecture_Sprint_Plan_v4.2.md).
