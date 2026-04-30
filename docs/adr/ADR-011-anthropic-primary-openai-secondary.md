# ADR-011: LLM Providers — Anthropic Primary, OpenAI Secondary, Multi-Provider via LiteLLM

- **Status**: Accepted
- **Date**: 2026-04-30
- **Deciders**: Architecture WG, AI Platform Eng

## Context

The AI Backbone (Part 14) requires one or more LLM providers. Key requirements:

1. High accuracy for tool-call generation (fraud, compliance, returns).
2. Competitive cost for high-volume buyer FAQ queries.
3. No single-provider lock-in — the Nigerian market has intermittent connectivity and provider outages must degrade gracefully.
4. NDPC compliance: prompt content containing user data must be governed by a DPA with each provider.

## Decision

- **Primary provider**: Anthropic (claude-3-5-sonnet for reasoning tasks; claude-3-haiku for high-volume/cost-sensitive tasks).
- **Secondary provider**: OpenAI (gpt-4o for fallback; gpt-4o-mini for cost-optimised paths).
- **Gateway**: LiteLLM proxy self-hosted at FSN1. All agent traffic flows through LiteLLM; no service calls Anthropic or OpenAI directly.

LiteLLM provides:
- Provider-agnostic call semantics (same request format regardless of backend).
- Per-model rate limiting and budget caps.
- Automatic failover from primary to secondary on 5xx.
- Unified spend logging for per-agent budget enforcement.

## Consequences

**Easier**
- Swapping the primary or secondary provider is a LiteLLM config change, not a code change.
- Per-agent budget enforcement is centralised in LiteLLM's spend tracking.
- A new provider (e.g., a future African-hosted LLM) is added as a LiteLLM backend without touching agent code.

**Harder**
- LiteLLM proxy is a new operational dependency; its availability affects all agents.
- Provider DPAs (Anthropic, OpenAI) must be in place before processing Nigerian user PII.

## Alternatives considered

- **Single-provider (Anthropic only)** — rejected: single point of failure; OpenAI fallback is essential for availability.
- **Direct provider SDK calls** — rejected: would require per-provider failover logic in every agent; no centralised budget tracking.
- **AWS Bedrock** — rejected: introduces US-cloud dependency for Nigerian-resident data paths; adds latency vs. direct Anthropic API from FSN1.

## Re-evaluation triggers

- A GDPR-equivalent Nigerian regulation requires provider data processing to be in-country (current stance: DPAs with Anthropic/OpenAI are the mitigation).
- LiteLLM proxy proves operationally expensive; a lighter-weight alternative becomes available.
- Anthropic or OpenAI pricing changes materially shift the cost calculus.

## Cross-references

- ADR-010 (agent runtime)
- ADR-015 (African-language vendors — separate LiteLLM backends for ASR/TTS)
- §14.5 (model gateway)
