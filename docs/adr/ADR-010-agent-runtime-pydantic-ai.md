# ADR-010: Agent Runtime — Pydantic AI + Thin In-House Orchestration

- **Status**: Accepted
- **Date**: 2026-04-30
- **Deciders**: Architecture WG, AI Platform Eng

## Context

The v4.2 Agentic AI Backbone (Part 14) requires a runtime that:

1. Enforces typed tool call schemas at the application layer (not just at the LLM API boundary).
2. Supports a clear separation between prompt definitions, tool definitions, and the orchestration loop.
3. Keeps the autonomy ceiling (ADR-014) mechanically enforced — the framework must not let the LLM bypass approval gates.
4. Stays within the TypeScript monorepo without introducing a Python service boundary.

The Python reference implementation (Pydantic AI) is the closest public framework to our requirements: typed tool schemas, structured output validation, and a clean agent-loop abstraction. However, it is Python-only and the repository is 98.5% TypeScript.

## Decision

Build a **thin TypeScript orchestration layer** in `services/agent-service/` that is the TypeScript analogue of Pydantic AI:

- **Tool descriptors** use Zod schemas for input and output validation (same pattern as Pydantic's field validators).
- **Structured output** is validated via Zod before being returned to the caller.
- **Agent loop** is explicit TypeScript code in `AgentRuntime.ts`, not a black-box framework loop.
- **No LangChain or LangGraph**: these frameworks add implicit state machines, opaque retry logic, and serialisation formats that would make the approval-bus suspension pattern in §14.7.3 fragile.

LiteLLM is used as the provider gateway (ADR-011) rather than calling Anthropic/OpenAI directly, giving provider-agnostic call semantics.

## Consequences

**Easier**
- The approval-gate check in `AgentRuntime.dispatchTool()` is a plain TypeScript `if` statement — reviewers can read and audit it without understanding framework internals.
- Zod schemas for tool I/O are the same pattern used elsewhere in the monorepo (`packages/api-zod`), so the convention is already established.
- No second language runtime (Python) in the service tier.

**Harder**
- We maintain the orchestration loop ourselves; upstream Pydantic AI improvements do not automatically flow in.
- Tool-calling patterns must be hand-written for new tool types rather than generated from Python type hints.

## Alternatives considered

- **LangChain.js / LangGraph.js** — rejected: opaque retry loops, complex state serialisation, and the framework's agent primitives would obscure the approval-bus suspension pattern required by ADR-014.
- **Pydantic AI (Python microservice)** — rejected: introduces a Python runtime boundary into a TypeScript monorepo, creating a deployment and observability split.
- **Vercel AI SDK** — rejected: primarily a React/Next.js streaming abstraction; lacks the typed tool-call validation and approval-bus integration points we need.

## Re-evaluation triggers

- A TypeScript-native framework emerges that provides typed tool schemas + explicit approval-gate hooks + LiteLLM integration out of the box.
- The in-house loop accumulates > 500 lines of non-domain logic, suggesting the framework abstraction is warranted.

## Cross-references

- ADR-011 (LiteLLM gateway)
- ADR-014 (approval ceiling)
- §14.3 (request lifecycle)
- §14.7 (tool registry)
