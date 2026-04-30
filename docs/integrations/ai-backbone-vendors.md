# Integration Directory — AI Backbone Vendors (v4.2 Part 14)

- **Status**: Active
- **Date**: 2026-04-30
- **Owner**: AI Platform Eng
- **Parent**: `docs/` (general integration directory)

This document lists all AI-related vendor integrations introduced in v4.2 Part 14. Tier definitions follow the main integration policy:

- **Tier 1**: Direct vendor relationship; SLA; DPA in place; on-call escalation path.
- **Tier 2**: Managed through a gateway or proxy; no direct SLA; fallback available.
- **Tier 3**: Community/open-source; no vendor SLA; used via self-hosted deployment.

---

## Tier 1 Vendors

### Anthropic

| Property | Value |
| :--- | :--- |
| Product | Claude API (claude-3-5-sonnet, claude-3-haiku) |
| Purpose | Primary LLM provider for all agents |
| Integration path | LiteLLM proxy → Anthropic API |
| ADR | [ADR-011](../adr/ADR-011-anthropic-primary-openai-secondary.md) |
| DPA | Required before processing user PII |
| Fallback | OpenAI (ADR-011 failover policy) |

### OpenAI

| Property | Value |
| :--- | :--- |
| Product | OpenAI API (gpt-4o, gpt-4o-mini) |
| Purpose | Secondary LLM provider; fallback for all agents |
| Integration path | LiteLLM proxy → OpenAI API |
| ADR | [ADR-011](../adr/ADR-011-anthropic-primary-openai-secondary.md) |
| DPA | Required before processing user PII |
| Fallback | Scripted safe response (no further fallback) |

### Intron Technologies — Sahara v2

| Property | Value |
| :--- | :--- |
| Product | Sahara v2 ASR + TTS |
| Purpose | Tier B African-language ASR (Yoruba, Hausa, Igbo) and TTS |
| Integration path | Direct REST/WebSocket API from `services/agent-service` |
| ADR | [ADR-015](../adr/ADR-015-intron-lelapa-tier-1-vendors.md) |
| DPA | African-region data processing; in place |
| Fallback | Text-only mode on outage (R-AI-005) |

### Lelapa AI — Vulavula

| Property | Value |
| :--- | :--- |
| Product | Vulavula NLU + translation |
| Purpose | Translation pivot for Tier B languages (ADR-012) |
| Integration path | Direct REST API from `services/agent-service` |
| ADR | [ADR-015](../adr/ADR-015-intron-lelapa-tier-1-vendors.md) |
| DPA | African-region data processing; in place |
| Fallback | English-only mode on outage |

### Deepgram

| Property | Value |
| :--- | :--- |
| Product | Deepgram Nova ASR |
| Purpose | Real-time English ASR for voice pipeline |
| Integration path | LiveKit Agents plugin → Deepgram streaming API |
| ADR | [ADR-013](../adr/ADR-013-voice-on-livekit-agents.md) |
| DPA | Required for voice transcript data |
| Fallback | Intron Sahara v2 (if Deepgram English degrades) |

### Langfuse

| Property | Value |
| :--- | :--- |
| Product | Langfuse (self-hosted or cloud) |
| Purpose | LLM observability — traces, evals, prompt management |
| Integration path | `@langfuse/sdk` in `services/agent-service` |
| §14 reference | §14.10 |
| DPA | Required (traces may contain prompt content) |
| Fallback | OpenTelemetry span only (degraded observability) |

---

## Tier 2 Vendors

### Cartesia

| Property | Value |
| :--- | :--- |
| Product | Cartesia Sonic TTS |
| Purpose | English TTS for voice pipeline (primary) |
| Integration path | LiveKit Agents plugin → Cartesia API |
| ADR | [ADR-013](../adr/ADR-013-voice-on-livekit-agents.md) |
| Fallback | ElevenLabs (Tier 2 fallback) |

### ElevenLabs

| Property | Value |
| :--- | :--- |
| Product | ElevenLabs TTS |
| Purpose | English TTS fallback for voice pipeline |
| Integration path | LiveKit Agents plugin → ElevenLabs API |
| ADR | [ADR-013](../adr/ADR-013-voice-on-livekit-agents.md) |
| Fallback | Text-only mode |

### Braintrust

| Property | Value |
| :--- | :--- |
| Product | Braintrust eval platform |
| Purpose | Nightly LLM eval jobs; quality drift detection (R-AI-004) |
| Integration path | Braintrust SDK in CI eval jobs |
| §14 reference | §14.10 |
| Fallback | Manual eval if Braintrust unavailable |

### LiteLLM

| Property | Value |
| :--- | :--- |
| Product | LiteLLM proxy (self-hosted) |
| Purpose | Multi-provider LLM gateway; budget enforcement; failover |
| Integration path | All agent LLM calls routed through LiteLLM on FSN1 |
| ADR | [ADR-011](../adr/ADR-011-anthropic-primary-openai-secondary.md) |
| Fallback | Agents fall back to scripted response on LiteLLM outage |

### Twilio

| Property | Value |
| :--- | :--- |
| Product | Twilio Voice + SMS |
| Purpose | PSTN voice channel and SMS notifications for agent escalations |
| Integration path | REST API from `services/agent-service` (tools that send external communications) |
| ADR | ADR-014 (all Twilio-backed tools require `single-human` approval) |
| Fallback | In-app notification only |

### WhatsApp Cloud API

| Property | Value |
| :--- | :--- |
| Product | WhatsApp Business Cloud API (Meta) |
| Purpose | WhatsApp channel for buyer/vendor agent interactions |
| Integration path | Webhook → `services/agent-service`; outbound via WhatsApp Cloud API |
| ADR | ADR-014 (all WhatsApp-backed tools require `single-human` approval) |
| Fallback | Web/app channel only |

---

## Tier 3 (Self-hosted / Open-source)

### OpenAI Whisper

| Property | Value |
| :--- | :--- |
| Product | Whisper (open-source ASR) |
| Purpose | Batch transcription for voice quality evaluation and training data generation |
| Integration path | Self-hosted inference job (not in real-time path) |
| ADR | [ADR-013](../adr/ADR-013-voice-on-livekit-agents.md) (not primary real-time ASR) |
| Fallback | Deepgram (for real-time) |

### pgvector

| Property | Value |
| :--- | :--- |
| Product | pgvector (Postgres extension) |
| Purpose | Long-term semantic memory for agents (§14.8) |
| Integration path | Postgres extension in existing cluster; accessed via `services/agent-service` `LongTermMemory` module |
| §14 reference | §14.8 |
| Fallback | Search disabled; agents operate on short-term memory only |

### LiveKit Agents

| Property | Value |
| :--- | :--- |
| Product | LiveKit Agents framework (open-source) |
| Purpose | Voice agent worker framework; connects to existing LiveKit SFU |
| Integration path | LiveKit Agent worker process; part of `services/agent-service` |
| ADR | [ADR-013](../adr/ADR-013-voice-on-livekit-agents.md) |
| Fallback | Text-only mode if LiveKit Agents unavailable |

### Pydantic AI (TypeScript analogue)

| Property | Value |
| :--- | :--- |
| Product | Pydantic AI (conceptual reference; TypeScript analogue in-house) |
| Purpose | Reference framework; Epplaa implements the TypeScript analogue in `services/agent-service/src/runtime/` |
| Integration path | In-house code; no vendor dependency |
| ADR | [ADR-010](../adr/ADR-010-agent-runtime-pydantic-ai.md) |
| Fallback | N/A (in-house code) |
