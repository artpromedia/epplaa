# ADR-012: Three-Tier Language Stack with Translation Pivot for Tier B

- **Status**: Accepted
- **Date**: 2026-04-30
- **Deciders**: Architecture WG, Product (Localisation)

## Context

Epplaa targets Nigerian users whose primary languages span English, Yoruba, Hausa, Igbo, and Nigerian Pidgin. LLMs (Anthropic Claude, OpenAI GPT-4o) have strong English capability but inconsistent performance in Nigerian languages.

Two options exist for supporting Nigerian languages:
1. Use a multilingual LLM capable of generating high-quality Yoruba/Hausa/Igbo responses natively.
2. Use a translation pivot: translate user input to English → run LLM in English → translate response back.

## Decision

Adopt a **three-tier language stack** with a translation pivot for Tier B:

| Tier | Languages | Approach |
| :--- | :--- | :--- |
| Tier A | English | Native LLM (no translation) |
| Tier B | Yoruba, Hausa, Igbo | Translation pivot via Intron Sahara v2 + Lelapa Vulavula (ADR-015) |
| Tier C | Nigerian Pidgin | Lightweight translation via a Pidgin-aware prompt prefix |

Translation latency budget: ≤ 300 ms round-trip (Intron + Lelapa are low-latency APIs on FSN1 co-location).

The pivot is implemented in `AgentRuntime.hydrateMemory()` and `AgentRuntime.handle()` as a transparent pre/post-processing step.

## Consequences

**Easier**
- LLM quality for Tier B is the same as Tier A (both processed in English internally).
- Language support can be extended (e.g., French for Francophone diaspora) by adding a Tier B translation pair without changing the agent loop.

**Harder**
- Translation introduces ≤ 300 ms of additional latency per turn.
- Translation quality errors can degrade the user experience; the Intron/Lelapa SLAs and human-evaluation cadence must be maintained.
- Named entities (product names, vendor names) must be preserved untranslated; the pivot implementation must handle this.

## Alternatives considered

- **Native multilingual LLM** — rejected: current SOTA multilingual LLMs have lower accuracy for Yoruba/Hausa/Igbo than English; translation pivot achieves better results at acceptable latency.
- **Separate fine-tuned models per language** — rejected: training and serving cost is prohibitive for v1; revisit when Epplaa has sufficient labeled data.

## Re-evaluation triggers

- A publicly available LLM reaches parity with the translation-pivot approach for Yoruba/Hausa/Igbo (measured by our Braintrust eval set).
- Intron/Lelapa translation quality drops below a threshold measured in nightly evals.

## Cross-references

- ADR-015 (Intron + Lelapa as Tier 1 vendors)
- ADR-013 (voice — ASR/TTS also follow the three-tier stack)
- §14.12 (language stack details)
