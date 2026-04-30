# Epplaa Architecture & Sprint Plan v4.2

- **Status**: Active
- **Date**: 2026-04-30
- **Supersedes**: v4.1 spec (`attached_assets/`) + v4.2 amendment (`docs/architecture/v4.2-amendment.md`)

---

## Part 1 – Executive Summary

Epplaa is a Nigerian-first live-commerce and social-marketplace platform. v4.2 extends the v4.1 platform with a self-contained **Agentic AI Backbone** (Part 14) while retaining all prior architectural commitments.

The AI Backbone is delivered via ten AI Sprints (AI 0–AI 9) layered onto the main sprint plan. It introduces five v1 AI agents, a shared agent-service runtime, a multi-provider LLM gateway, short- and long-term memory tiers, a human-approval bus, and a safety layer enforcing a hard autonomy ceiling (ADR-014).

---

## Part 2 – Retained from v4.1

All decisions in the v4.1 spec and the v4.2 amendment remain binding:

- Target SLOs (p95 API < 200 ms; p99 < 500 ms; availability ≥ 99.9%)
- NDPC data-residency posture (Nigerian PII stays in NG-resident storage)
- PCI SAQ-A scoping (no card data touches Epplaa servers)
- Lagos edge ingest tier for live-commerce streams
- Hetzner FSN1 / HEL1 dual-region topology
- Dual-payment-rail strategy (Paystack + Flutterwave)
- Epplaa Boxes fulfilment
- Observability stack (OpenTelemetry → Grafana / Loki / Tempo)
- Sprint mandate (sprints 1–13 unchanged)

---

## Part 3 – v4.2 Deviations from v4.1

See `docs/architecture/v4.2-amendment.md` for the full list. The AI Backbone adds no further deviations from v4.1 non-AI decisions.

---

## Part 4 – Technology Stack (v4.2 additions)

| Layer | Technology | ADR |
| :--- | :--- | :--- |
| Agent runtime | TypeScript + Zod schemas (Pydantic AI TypeScript analogue) | ADR-010 |
| Primary LLM | Anthropic Claude (claude-3-5-sonnet) | ADR-011 |
| Secondary LLM | OpenAI GPT-4o | ADR-011 |
| LLM gateway | LiteLLM proxy (self-hosted, FSN1) | ADR-011 |
| African languages | Intron Sahara v2 (ASR/TTS) + Lelapa Vulavula (NLU) | ADR-015 |
| Voice pipeline | LiveKit Agents | ADR-013 |
| Memory – short-term | Redis (TTL-bounded conversation context) | §14.8 |
| Memory – long-term | pgvector (semantic retrieval, Postgres extension) | §14.8 |
| Approval bus | Redpanda topic `agent.proposed_action` | §14.7.3 |
| Observability | Langfuse (LLM traces) + Braintrust (eval) | §14.10 |
| Autonomy ceiling | Single human approval for all money/account/messaging tools | ADR-014 |

---

## Part 5 – Service Catalogue (v4.2 additions)

### §5.1 New: `services/agent-service`

| Property | Value |
| :--- | :--- |
| Name | `@workspace/agent-service` |
| Language | TypeScript (strict) |
| Runtime | Node 24 |
| Transport | HTTP (Fastify) for health/admin; Redpanda for async events |
| Databases | Redis (short-term memory), Postgres/pgvector (long-term memory) |
| Secrets | Vault (ADR-010) |
| Trace | OpenTelemetry → Langfuse |

---

## Part 14 – Agentic AI Backbone

### §14.1 Design Principles

1. **Safety-first**: Every tool that touches money, accounts, or external messaging defaults to `approval: 'single-human'` (ADR-014). This ceiling cannot be relaxed without a new ADR.
2. **Observability-first**: Every LLM call emits a Langfuse trace with model, tokens, latency, and structured tool calls. No silent calls.
3. **Fail-safe**: On gateway timeout or budget exhaustion, agents fall back to a scripted response and hand off to human support — they never retry indefinitely.
4. **Minimal footprint**: Agents read from the existing platform APIs (catalog, order, payment, etc.) rather than holding their own copy of business data.
5. **Language-inclusive**: Agents support English, Yoruba, Hausa, Igbo, and Pidgin from v1; voice support for all tiers by AI Sprint 5.

### §14.2 Agent Definitions (v1)

#### Vendor Onboarding Agent

- **Purpose**: Guide new vendors through listing creation, KYC compliance checks, and first-sale readiness.
- **Prompt reference**: `prompts/vendor-onboarding/v1`
- **Tool-set**: `catalog.search`, `catalog.create_draft`, `runbook.search`, `escalation.handoff_to_human`
- **Memory profile**: Short-term (session context); long-term (vendor profile embeddings)
- **Model routing**: Anthropic Claude primary; OpenAI GPT-4o fallback
- **SLO**: p95 response < 3 s; resolution rate ≥ 70% without escalation

#### Seller Copilot Agent

- **Purpose**: Assist active sellers with catalog management, pricing suggestions, inventory alerts, and fulfilment status.
- **Prompt reference**: `prompts/seller-copilot/v1`
- **Tool-set**: `catalog.search`, `catalog.create_draft`, `order.read`, `order.create_draft`, `runbook.search`, `escalation.handoff_to_human`
- **Memory profile**: Short-term; long-term (seller behaviour patterns)
- **Model routing**: Anthropic Claude primary
- **SLO**: p95 response < 2 s

#### Buyer Concierge Agent

- **Purpose**: Answer buyer questions, provide order status, handle return requests, and facilitate dispute escalation.
- **Prompt reference**: `prompts/buyer-concierge/v1`
- **Tool-set**: `catalog.search`, `order.read`, `order.return_request`, `payment.refund_request`, `escalation.handoff_to_human`
- **Memory profile**: Short-term (conversation); long-term (order history embeddings)
- **Model routing**: Anthropic Claude primary; cost-optimised tier for FAQ queries
- **SLO**: p95 response < 2 s; CSAT ≥ 4.2/5

#### Fraud & Counterfeit Agent

- **Purpose**: Flag suspicious listings, initiate takedown workflows, and surface fraud signals to the Trust & Safety team.
- **Prompt reference**: `prompts/fraud-counterfeit/v1`
- **Tool-set**: `listing.flag_for_review`, `listing.auto_takedown`, `escalation.handoff_to_human`
- **Memory profile**: Long-term only (pattern memory; no per-session context needed)
- **Model routing**: Anthropic Claude primary (high accuracy required)
- **SLO**: precision ≥ 90%; false-positive rate < 5%

#### Ops On-Call Agent

- **Purpose**: Surface runbook guidance, incident context, and escalation paths for on-call engineers.
- **Prompt reference**: `prompts/ops-oncall/v1`
- **Tool-set**: `runbook.search`, `escalation.handoff_to_human`, `stream.suggest_pin`
- **Memory profile**: Short-term (incident session)
- **Model routing**: Anthropic Claude primary (low latency required for incidents)
- **SLO**: p95 response < 1.5 s

### §14.3 Request Lifecycle

#### §14.3.1 Overview

```
User message → AgentRuntime.handle()
  → load agent config (PromptRegistry + ToolRegistry)
  → hydrate ShortTermMemory (Redis TTL window)
  → call ModelGateway (LiteLLM → Anthropic/OpenAI)
  → validate tool calls (Zod schema + scope check)
  → for each tool call:
      if tool.approvalThreshold === 'single-human':
        → publish to ApprovalBus (Redpanda agent.proposed_action)
        → suspend and await approval event
      else:
        → dispatch tool directly
  → emit LLM trace (Langfuse)
  → return structured response
```

#### §14.3.2 Lifecycle method reference

| Step | Method | §14 reference |
| :--- | :--- | :--- |
| Load config | `AgentRuntime.loadConfig()` | §14.6 |
| Hydrate memory | `AgentRuntime.hydrateMemory()` | §14.8 |
| Call gateway | `AgentRuntime.callGateway()` | §14.5 |
| Validate tool calls | `AgentRuntime.validateToolCalls()` | §14.7.1 |
| Dispatch tool | `AgentRuntime.dispatchTool()` | §14.7.2 |
| Wait for approval | `AgentRuntime.waitForApproval()` | §14.7.3 |
| Emit trace | `AgentRuntime.emitTrace()` | §14.10 |

### §14.4 Agent Configuration Schema

Each agent is defined by a config object with the following fields:

- `id`: unique agent identifier
- `displayName`: human-readable name
- `promptRef`: versioned prompt key (resolved by PromptRegistry)
- `tools`: list of tool names from ToolRegistry
- `memoryProfile`: `{ shortTerm: boolean; longTerm: boolean }`
- `modelPolicy`: `{ primary: string; fallback?: string; maxTokens: number; temperature: number }`
- `budgetPolicy`: `{ dailyUsdCap: number; alertThresholdUsd: number }`
- `slo`: `{ p95ResponseMs: number; description: string }`

### §14.5 Model Gateway

The LiteLLM proxy is the single egress point for all LLM calls. No agent calls a model provider directly.

- **Provider routing**: Primary → Anthropic; fallback → OpenAI (configurable per agent via `modelPolicy`)
- **Budget enforcement**: Per-agent daily USD cap tracked in Redis; gateway rejects calls when cap is breached
- **Failover policy**: On 5xx from primary, retry once; then fall back to secondary; then return a scripted safe response
- **Observability**: Every call tagged with `agent_id`, `session_id`, `tool_context` for Langfuse

### §14.6 Prompt Registry

Prompts are versioned and loaded from the registry at runtime. No prompt content is hardcoded in the service code. New prompt versions go through PR review before being activated.

- **Storage**: Database-backed in production (migrated from in-memory stub in AI Sprint 1)
- **Versioning**: Semantic version strings (e.g., `vendor-onboarding/v1`, `vendor-onboarding/v1.1`)
- **Rollback**: Decrement the active version pointer; old versions are retained

### §14.7 Tool Registry

#### §14.7.1 Tool descriptor fields

| Field | Type | Description |
| :--- | :--- | :--- |
| `name` | string | Unique tool identifier |
| `version` | string | Semver |
| `description` | string | Human-readable description for the LLM |
| `inputSchema` | Zod schema | Validated before dispatch |
| `outputSchema` | Zod schema | Validated after dispatch |
| `authorizationScope` | string | OAuth/RBAC scope required |
| `idempotent` | boolean | Whether the tool is safe to retry |
| `approvalThreshold` | `'none' \| 'single-human'` | ADR-014 ceiling |
| `auditLogPolicy` | `'always' \| 'on-approval' \| 'never'` | Audit trail |
| `rateLimit` | `{ maxPerMinute: number }` | Per-agent rate limit |

#### §14.7.2 High-traffic tool subset (v1)

| Tool | Approval | Idempotent |
| :--- | :--- | :--- |
| `catalog.search` | none | true |
| `catalog.create_draft` | none | true |
| `order.read` | none | true |
| `order.create_draft` | none | true |
| `order.return_request` | single-human | false |
| `payment.refund_request` | single-human | false |
| `listing.flag_for_review` | single-human | false |
| `listing.auto_takedown` | single-human | false |
| `stream.suggest_pin` | none | true |
| `runbook.search` | none | true |
| `escalation.handoff_to_human` | none | false |

#### §14.7.3 Approval Bus

Tools with `approvalThreshold === 'single-human'` publish a proposed-action event to the Redpanda topic `agent.proposed_action` before execution:

```json
{
  "eventId": "<uuid>",
  "agentId": "<agent-id>",
  "sessionId": "<session-id>",
  "tool": "<tool-name>",
  "args": { ... },
  "requestedAt": "<ISO-8601>",
  "expiresAt": "<ISO-8601 + 15 min>"
}
```

A human operator approves or rejects via the Ops UI. The agent awaits the `agent.action_approved` or `agent.action_rejected` event (max 15 minutes; on timeout → auto-reject → scripted safe response).

### §14.8 Memory Architecture

| Tier | Technology | TTL | Use |
| :--- | :--- | :--- | :--- |
| Short-term | Redis | 30 min (session TTL) | Conversation context, tool-call history |
| Long-term | Postgres + pgvector | No TTL (retention per NDPC) | Semantic retrieval, vendor/buyer profiles |

Short-term context is serialised as a JSON array of message objects. Long-term retrieval uses cosine similarity search on embeddings generated by the primary LLM provider's embedding endpoint.

### §14.9 Safety Layer

#### §14.9.1 Prompt Injection Defense

Layered defenses in `PromptInjectionDefense`:

1. **Structural delimiters**: User content is always wrapped in `<user_input>...</user_input>` XML tags; system prompt uses `<system>...</system>`.
2. **Output schema validation**: Agent responses are validated against Zod schemas; any response that does not conform is rejected.
3. **Scope enforcement**: Tool calls are checked against the agent's declared tool-set; out-of-scope tool calls are rejected without being executed.
4. **Untrusted-content classifier hook**: A fast classifier model (pluggable; Claude Haiku by default) scores user input for injection patterns.
5. **Behavioural monitoring hook**: Langfuse eval job watches for tool-call sequences inconsistent with the agent's declared purpose.
6. **Multi-model voting hook**: For high-stakes decisions (payment, takedown), a second model independently evaluates the tool call before dispatch.

#### §14.9.2 PII Redaction

Before any user content is sent to an LLM provider, `PIIRedaction` applies:

- Regex-based scrubbing for Nigerian phone numbers, BVN fragments, and NIN fragments.
- Named-entity recognition hook (pluggable; run locally by default) for names and addresses.
- Redacted content is logged with a `[REDACTED:<type>]` placeholder; the original is never sent to the provider.

### §14.10 Observability

Every LLM call emits:

- **Langfuse trace**: model, provider, tokens (prompt + completion), latency, session ID, agent ID, tool calls
- **OpenTelemetry span**: correlated with the HTTP request trace
- **Structured log**: pino log entry with `agent_id`, `session_id`, `tool_name`, `outcome`

Eval jobs run nightly in Braintrust against a held-out set of golden examples per agent. Eval quality drift (>5% regression in 7-day rolling average) triggers alert R-AI-004 (see risk register).

### §14.11 Autonomy Ceiling (ADR-014)

**v1 ceiling**: No agent may execute an action that touches money, modifies an account, or sends external communications without a human approval event (§14.7.3).

This ceiling is enforced at two levels:
1. **ToolRegistry**: Every tool in the high-traffic set that touches money/account/messaging has `approvalThreshold: 'single-human'` hardcoded.
2. **AgentRuntime**: The dispatch path checks `approvalThreshold` before executing any tool; this check cannot be bypassed via the LLM output.

Raising the ceiling (to autonomous act-without-approval) requires a new ADR superseding ADR-014 and an Architecture WG vote.

### §14.12 Language Stack (ADR-012)

| Tier | Languages | Service |
| :--- | :--- | :--- |
| Tier A | English | Native LLM capability |
| Tier B | Yoruba, Hausa, Igbo | Translation pivot via Intron Sahara v2 + Lelapa Vulavula |
| Tier C | Nigerian Pidgin | Lightweight translation; Pidgin-specific prompts |

The translation pivot: Tier B user input is translated to English before the LLM call; the English response is translated back to the user's language before delivery. Latency budget for translation: ≤ 300 ms round-trip.

### §14.13 Voice Architecture (ADR-013)

Voice input/output is handled by LiveKit Agents, reusing the existing LiveKit deployment:

- **ASR**: Deepgram (English), Intron Sahara v2 (Yoruba/Hausa/Igbo)
- **TTS**: Cartesia (English), Intron Sahara v2 (Yoruba/Hausa/Igbo)
- **Fallback TTS**: ElevenLabs (English only)
- **Transcript to agent**: WebSocket via LiveKit Agent worker; transcript handed to AgentRuntime as a text message

### §14.14 AI Sprint Plan

#### §14.14.1 AI Sprint definitions

| Sprint | Theme | Exit criteria | Language coverage |
| :--- | :--- | :--- | :--- |
| AI 0 | Scaffolding | `tsc --noEmit` green; smoke test passes; `services/agent-service` in CI | None |
| AI 1 | Runtime core | Vendor Onboarding agent handles 10 golden test cases; prompt registry DB-backed | English only |
| AI 2 | Buyer & Seller agents | Buyer Concierge + Seller Copilot golden tests pass; approval bus integration tested | English only |
| AI 3 | Fraud agent | Fraud & Counterfeit agent: precision ≥ 90% on eval set; auto-takedown with approval bus | English only |
| AI 4 | Ops On-Call agent | Ops On-Call agent: runbook retrieval p95 < 1.5 s; escalation tested | English only |
| AI 5 | Voice pipeline | LiveKit Agents integration; Deepgram ASR; Cartesia TTS; voice tested for all 5 agents | English + Pidgin |
| AI 6 | Tier B languages | Intron + Lelapa integration; Yoruba/Hausa/Igbo tested for Buyer Concierge | Tier B |
| AI 7 | Autonomy review | Month-6 ROI gate evaluated; if 3/5 KPIs met → expand act-without-approval candidates via new ADR | All tiers |
| AI 8 | Eval & hardening | Braintrust nightly evals green; prompt injection red-team passed; PII audit passed | All tiers |
| AI 9 | GA readiness | Load test: 500 concurrent sessions; p95 < 3 s; all SLOs met; security review signed off | All tiers |

#### §14.14.2 Dependencies on main sprint plan

| AI Sprint | Depends on main sprint |
| :--- | :--- |
| AI 1 | Sprint 5 (catalog service extracted; catalog APIs available) |
| AI 2 | Sprint 9 (order service extracted; order + payment APIs available) |
| AI 5 | Sprint 12 (LiveKit streaming infrastructure stable) |

---

## Appendix G — Architecture Decision Records (ADR-010 – ADR-015)

See individual files in `docs/adr/`:

- [ADR-010](../../adr/ADR-010-agent-runtime-pydantic-ai.md)
- [ADR-011](../../adr/ADR-011-anthropic-primary-openai-secondary.md)
- [ADR-012](../../adr/ADR-012-three-tier-language-stack.md)
- [ADR-013](../../adr/ADR-013-voice-on-livekit-agents.md)
- [ADR-014](../../adr/ADR-014-single-human-approval-autonomy-ceiling.md)
- [ADR-015](../../adr/ADR-015-intron-lelapa-tier-1-vendors.md)

---

## Appendix H — Risk Register (AI Backbone Additions)

See [`docs/risk-register/ai-backbone-risks.md`](../../risk-register/ai-backbone-risks.md).

---

## Appendix I — Integration Directory (AI Backbone Additions)

See [`docs/integrations/ai-backbone-vendors.md`](../../integrations/ai-backbone-vendors.md).
