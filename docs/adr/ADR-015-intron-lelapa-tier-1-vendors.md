# ADR-015: Intron Sahara v2 + Lelapa Vulavula as Tier 1 African-Language Vendors

- **Status**: Accepted
- **Date**: 2026-04-30
- **Deciders**: Architecture WG, Product (Localisation)

## Context

The three-tier language stack (ADR-012) requires ASR, TTS, and NLU vendors capable of high-quality Nigerian language processing for Yoruba, Hausa, and Igbo. Options evaluated:

1. **Intron Technologies (South Africa)** — Sahara v2: ASR + TTS for 10+ African languages including Yoruba, Hausa, Igbo. Streaming-capable. Low-latency API.
2. **Lelapa AI (South Africa)** — Vulavula: NLU + translation for African languages. Yoruba, Zulu, Sotho support; Hausa and Igbo in roadmap.
3. **Meta SeamlessM4T** — open model; requires self-hosting and GPU inference, which is not in the Phase 0 scope.
4. **Microsoft Azure AI Speech** — supports Yoruba; no Hausa/Igbo ASR; US-cloud dependency.

## Decision

Adopt **Intron Sahara v2** (ASR + TTS) and **Lelapa Vulavula** (NLU + translation) as Tier 1 African-language vendors:

- **Tier 1 designation**: Epplaa has a direct vendor relationship, SLA, and DPA with each. They are listed in the integration directory (Appendix I).
- **Intron** handles real-time ASR (voice-to-text) and TTS (text-to-voice) for Yoruba, Hausa, and Igbo.
- **Lelapa** handles translation pivot (Tier B language ↔ English) per ADR-012.
- Both vendors are African-headquartered and processing agreements are structured to keep Nigerian PII in the Africa region.

## Consequences

**Easier**
- Native African-language ASR/TTS without US-cloud data residency.
- Streaming ASR from Intron meets the ≤ 300 ms latency budget for the translation pivot.
- Both vendors have roadmap commitments to expand language coverage (Hausa, Igbo for Lelapa).

**Harder**
- Vendor concentration risk: both are relatively young companies; outage of either degrades Tier B language quality. See risk register entry R-AI-005.
- DPAs and SLAs must be actively maintained; a contract lapse would require immediate fallback.

**Fallback plan**: On Intron outage, Tier B voice degrades to text-only (Lelapa translation still works). On Lelapa outage, Tier B text agents fall back to English-only mode with a user-facing notice.

## Alternatives considered

- **Meta SeamlessM4T self-hosted** — deferred: requires GPU inference infrastructure not in Phase 0 scope; revisit for AI Sprint 8.
- **Google Cloud Speech-to-Text** — rejected: limited Yoruba/Hausa/Igbo support; US-cloud dependency.
- **Microsoft Azure AI Speech** — rejected: no Hausa/Igbo ASR; US-cloud dependency.

## Re-evaluation triggers

- SeamlessM4T or a successor reaches production-quality streaming ASR for all three languages and can be self-hosted within the Hetzner cluster budget.
- Intron or Lelapa experience an SLA breach or the vendor relationship is disrupted.

## Cross-references

- ADR-012 (three-tier language stack)
- ADR-013 (voice pipeline — Intron used for ASR/TTS)
- §14.12 (language stack)
- §14.13 (voice architecture)
- R-AI-005 (Intron vendor concentration risk)
