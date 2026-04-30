# ADR-0008: Analytics — ClickHouse + dbt, gated on first analytics use case

- **Status**: Accepted
- **Date**: 2026-04-30
- **Deciders**: Architecture WG, Data Eng (acting), Product

## Context

The v4.1 spec calls for ClickHouse for analytics and stream telemetry.
The current code base does not have a dedicated analytics warehouse;
ad-hoc queries run against Postgres read replicas. Pre-launch this is
acceptable: there is no analyst headcount, no scheduled BI workload,
and no live-stream telemetry volume.

ClickHouse has a non-trivial operational footprint (cluster, ZooKeeper
or ClickHouse Keeper for replication, tiered storage, ingestion
pipeline), and dbt requires a model repository and a CI orchestration
(Airflow/Dagster/Prefect) that are themselves projects.

## Decision

Adopt **ClickHouse + dbt** as the eventual analytics stack, gated on
*the first concrete analytics use case that Postgres cannot serve*.

Until the gate fires:

- Analytics queries run against a Postgres read replica.
- Event data lands in the DB outbox / Redpanda (per ADR-0006); no
  separate analytics ingestion is built.
- A `packages/analytics-events` library defines the shape of analytics
  events (Avro schemas) so the eventual ClickHouse ingester has a
  contract from day one.

When the gate fires:

- Deploy ClickHouse + ClickHouse Keeper via Helm in
  `infra/helm/clickhouse/`.
- Stand up a dbt project at `tools/dbt/`.
- Build an ingester (Redpanda → ClickHouse) deployed alongside
  `services/analytics-service`.
- BI / dashboard tool selection (Metabase / Superset / Grafana
  business-intel plugin) is deferred to that PR.

## Gate triggers (any one)

- Product hires its first analyst (workload concentrates on
  query-heavy exploration).
- A single Postgres analytics query exceeds **30 s** P95, twice
  consecutively, on the read replica.
- Live-stream telemetry exceeds **10k events/second** sustained
  (Postgres is the wrong shape for this workload at any volume).
- Compliance reporting (CBN, NDPC) demands a warehouse-grade audit
  trail.

## Consequences

**Easier**
- We avoid ClickHouse + dbt operational cost during the early phases.
- The `packages/analytics-events` schemas force event shape
  decisions early; ClickHouse table DDL is mechanical from the schemas
  when the time comes.
- Read-replica analytics is sufficient for early product decisions.

**Harder**
- When the gate fires, we are introducing two new runtime systems
  (ClickHouse, dbt) in parallel with the rest of the program.
- Dashboard tooling decision is deferred; the longer it is deferred,
  the more ad-hoc dashboards proliferate elsewhere (Looker Studio,
  spreadsheets) and become a migration burden.

## Alternatives considered

- **Snowflake / BigQuery** — rejected: SaaS, US-region, per-query
  cost punishing for high-event-rate workloads.
- **DuckDB + Parquet on object storage** — interesting for ad-hoc
  but does not solve the live-telemetry ingest problem.
- **Postgres + materialized views forever** — rejected once the
  gate fires; until it fires, this is exactly what we do.
- **Adopt ClickHouse from day one** — rejected because pre-launch
  there is no workload that justifies it.

## Re-evaluation triggers

- See *Gate triggers* above.
- If a managed ClickHouse offering (ClickHouse Cloud) becomes
  cost-competitive with self-hosted on Hetzner *and* offers an
  EU-resident region, revisit *self-hosted vs managed* — not the
  ClickHouse choice itself.
