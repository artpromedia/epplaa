# ADR-013: Voice Interface on LiveKit Agents

- **Status**: Accepted
- **Date**: 2026-04-30
- **Deciders**: Architecture WG, Streaming Eng

## Context

The AI Backbone (Part 14) includes a voice interface for buyer and vendor interactions. Requirements:

1. Reuse the existing LiveKit deployment (established in the v4.1 streaming architecture) rather than introducing a second real-time media stack.
2. Support Nigerian-language ASR and TTS (Tier B languages per ADR-012).
3. Low end-to-end latency: < 1 s ASR-to-first-token.

## Decision

Build the voice pipeline on **LiveKit Agents**, the official LiveKit framework for agent workers:

- **ASR**: Deepgram (English, Tier A); Intron Sahara v2 (Yoruba/Hausa/Igbo, Tier B).
- **TTS**: Cartesia (English, primary); Intron Sahara v2 (Yoruba/Hausa/Igbo); ElevenLabs (English fallback).
- **Architecture**: LiveKit Agent worker connects to the existing LiveKit SFU; receives audio track from the user; streams transcript chunks to `AgentRuntime.handle()` as text; streams TTS audio back.
- **Session management**: LiveKit session maps 1:1 to an AgentRuntime session (same `sessionId`).

## Consequences

**Easier**
- No new WebRTC infrastructure; the existing LiveKit SFU handles media transport.
- Nigerian-language voice (Intron ASR/TTS) plugs in as a LiveKit Agent plugin, same integration pattern as Deepgram.
- Voice sessions share the same memory context as text sessions (same `sessionId` in Redis short-term memory).

**Harder**
- LiveKit Agents is a relatively new framework; its API surface may change before GA.
- Intron Sahara v2 ASR streaming mode must be validated for latency; offline batch mode is not acceptable for real-time voice.

## Alternatives considered

- **Twilio Voice + Twilio ConversationRelay** — considered; Twilio is listed as a Tier 2 vendor in the integration directory for WhatsApp/PSTN, but using it for voice AI would duplicate the LiveKit media path.
- **Whisper (OpenAI) for ASR** — considered for English; Deepgram is preferred for streaming/real-time use; Whisper is better suited for batch transcription.
- **A separate Asterisk/Freeswitch media server** — rejected: significantly higher operational complexity.

## Re-evaluation triggers

- LiveKit Agents API changes incompatibly in a major release.
- Intron Sahara v2 streaming ASR latency exceeds the 300 ms budget on the Nigerian network path.

## Cross-references

- ADR-012 (three-tier language stack)
- ADR-015 (Intron + Lelapa as Tier 1 vendors)
- §14.13 (voice architecture)
