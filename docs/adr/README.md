# Architectural Decision Records (ADRs)

This directory holds the architectural decision records for the Epplaa
platform. ADRs document **why** a decision was made, **what
alternatives were rejected**, and **what triggers a re-evaluation**.

Format follows a lightweight Michael Nygard / MADR hybrid:

- **Status** — Proposed | Accepted | Superseded | Deprecated
- **Context** — what forces are at play
- **Decision** — what we are doing
- **Consequences** — what becomes easier and harder
- **Alternatives considered** — what we rejected, and why
- **Re-evaluation triggers** — what would make us revisit this

ADRs are numbered sequentially and never renumbered. When an ADR is
superseded, its status changes and a link to the superseding ADR is
added; the original is preserved as historical record.

## Index

| # | Title | Status |
| :--- | :--- | :--- |
| [0001](./0001-strangler-fig-migration.md) | Strangler-fig migration from monolith to microservices | Accepted |
| [0002](./0002-repository-layout.md) | Repository layout (apps/, services/, packages/, infra/) | Accepted |
| [0003](./0003-identity-clerk-vs-keycloak.md) | Identity provider — Clerk retained, Keycloak deferred | Accepted |
| [0004](./0004-web-framework-split.md) | Web framework split — Next.js 15 for buyer; Vite + React for operator surfaces | Accepted |
| [0005](./0005-mobile-react-native-vs-flutter.md) | Mobile framework — React Native + Expo (supersedes spec ADR-007) | Accepted |
| [0006](./0006-event-backbone-redpanda.md) | Event backbone — Redpanda, phased introduction | Accepted |
| [0007](./0007-search-opensearch.md) | Search — OpenSearch, gated on catalog size | Accepted |
| [0008](./0008-analytics-clickhouse-dbt.md) | Analytics — ClickHouse + dbt, gated on first analytics use case | Accepted |
| [0009](./0009-service-mesh-linkerd.md) | Service mesh — Linkerd | Accepted |
| [0010](./0010-secrets-vault.md) | Secrets — Vault replaces environment variables | Accepted |
| [ADR-010](./ADR-010-agent-runtime-pydantic-ai.md) | Agent runtime — Pydantic AI TypeScript analogue + in-house orchestration | Accepted |
| [ADR-011](./ADR-011-anthropic-primary-openai-secondary.md) | LLM providers — Anthropic primary, OpenAI secondary, multi-provider via LiteLLM | Accepted |
| [ADR-012](./ADR-012-three-tier-language-stack.md) | Three-tier language stack with translation pivot for Tier B | Accepted |
| [ADR-013](./ADR-013-voice-on-livekit-agents.md) | Voice interface — LiveKit Agents | Accepted |
| [ADR-014](./ADR-014-single-human-approval-autonomy-ceiling.md) | Autonomy ceiling — single human approval for v1 | Accepted |
| [ADR-015](./ADR-015-intron-lelapa-tier-1-vendors.md) | African-language vendors — Intron Sahara v2 + Lelapa Vulavula as Tier 1 | Accepted |

## Relationship to the v4.1 architecture spec

The v4.1 architecture spec under `attached_assets/` is the *target*
end-state. The ADRs in this directory record the *path* from the
current code base to that end-state, and the deliberate deviations
where the code is deemed correct and the spec is updated to follow.
The composite v4.2 amendment lives at
[`docs/architecture/v4.2-amendment.md`](../architecture/v4.2-amendment.md)
and the v4.2 Agentic AI Backbone spec (Part 14, ADRs 010–015) lives at
[`docs/architecture/v4.2/`](../architecture/v4.2/).
