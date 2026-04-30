# ADR-0007: Search — OpenSearch, gated on catalog size

- **Status**: Accepted
- **Date**: 2026-04-30
- **Deciders**: Architecture WG, Backend Eng

## Context

The v4.1 spec names OpenSearch as the product- and stream-search
engine. The current code base searches via PostgreSQL `tsvector`
full-text search and trigram indexes. At the current catalog size
(< ~50k SKUs in pre-launch), Postgres FTS is comfortably under our
P95 latency budget and supports the discovery features that exist.

OpenSearch carries non-trivial operational cost: a dedicated
Kubernetes-native cluster (3+ data nodes for HA), an indexer pipeline
(CDC from Postgres or batch reindex), schema-evolution care, and a
parallel search code path that must remain in sync with Postgres
ground truth.

## Decision

Adopt **OpenSearch** as the eventual search engine, but gate its
introduction on catalog scale and feature need.

Until the gate fires:

- All search continues to use PostgreSQL FTS.
- A `packages/search` abstraction is introduced in Phase 3 that
  exposes a search interface (`searchProducts(query, filters)` etc.).
  The Postgres implementation is the only backend.

When the gate fires:

- OpenSearch is deployed via the Helm chart in
  `infra/helm/opensearch/`.
- Indexes are populated either by Debezium CDC against Postgres or by
  a scheduled batch reindex (decision deferred to the implementation
  PR).
- The `packages/search` abstraction grows an OpenSearch implementation
  selected by feature flag, per index.
- A dual-read window verifies parity with Postgres ground truth
  before cutover.

## Gate triggers (any one)

- Active product catalog exceeds **250k SKUs**.
- P95 search latency on the buyer app exceeds **300 ms** for two
  consecutive weeks.
- A search feature lands that Postgres FTS cannot serve cleanly
  (typo-tolerance with phonetic Nigerian-English/Yoruba/Igbo/Hausa
  language packs; vector-search on product embeddings; live-stream
  full-text plus facet search at high write rate).

## Consequences

**Easier**
- We avoid OpenSearch operational cost during the early phases.
- The `packages/search` interface forces us to design search
  *capability-first* rather than *backend-first*; this makes the
  swap cleaner when it fires.
- Postgres FTS already supports the multilingual roadmap with
  language-specific dictionaries.

**Harder**
- When the gate fires, we are doing the OpenSearch introduction in
  parallel with whatever else is on the program board.
- The `packages/search` abstraction must be expressive enough to
  cover both backends without leaking either.

## Alternatives considered

- **Elasticsearch** — rejected: Elastic license terms are incompatible
  with our open-source-first stance; OpenSearch is the AWS-led fork
  and has equivalent capability for our use.
- **Typesense** — rejected: smaller community, less obvious path for
  vector search at scale.
- **Algolia** — rejected: SaaS, US/EU residency, recurring per-search
  cost incompatible with high-volume Nigerian buyer traffic.
- **Adopt OpenSearch from day one** — rejected because Postgres FTS
  meets the current load and adding an OpenSearch dependency now is
  pure carry cost.

## Re-evaluation triggers

- See *Gate triggers* above.
- If at any point we adopt vector search for recommendations, the
  decision between OpenSearch's `knn` and a dedicated vector DB
  (e.g., pgvector, Qdrant) is revisited in a successor ADR.
