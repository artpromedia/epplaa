# ADR-0006: Event backbone — Redpanda, phased introduction

- **Status**: Accepted
- **Date**: 2026-04-30
- **Deciders**: Architecture WG, Backend Eng

## Context

The v4.1 spec names Kafka (Redpanda implementation) as the event
backbone. The current code base has a database-backed outbox at
`lib/notifications/outbox.ts` that publishes notification events to
exactly one consumer (the notification dispatcher). There is no
broker.

Adopting a broker is a non-trivial operational commitment: schema
registry, consumer-group lag monitoring, retention policy decisions,
DLQ design, dual-write/CDC tooling, on-call rotation. Doing this work
when there is exactly one event type and one consumer is overhead
without payoff.

## Decision

Adopt **Redpanda** as the event backbone, with phased introduction:

1. **Phase 0–3 (now)** — keep the DB-backed outbox. Refactor the
   outbox into a `packages/events` library that exposes a
   broker-agnostic `publish(topic, payload)` API. The DB-backed
   implementation is the only one used.
2. **Phase 3 trigger** — the moment a *second* consumer wants to
   receive an event from the outbox, deploy Redpanda + Schema
   Registry via the Helm chart in `infra/helm/redpanda/`. The
   `publish()` API gains a Redpanda-backed implementation chosen by
   feature flag.
3. **Dual-write** — for one release window, every event is written
   to *both* the DB outbox and Redpanda. Consumer parity is verified
   via a reconciliation job.
4. **Cutover** — the DB-backed implementation becomes append-only
   (audit trail) and consumers read exclusively from Redpanda.

Redpanda is chosen over Apache Kafka because it ships as a single
Go binary (no JVM, no ZooKeeper/KRaft tuning), has a smaller
operational surface, and is wire-compatible with the Kafka protocol
so we retain the option to migrate without a client rewrite.

## Consequences

**Easier**
- We avoid carrying broker operational cost during the early
  strangler-fig phases when most events have one consumer.
- The `packages/events` abstraction means the Redpanda swap is a
  single-package change, not a workspace-wide change.
- Schema-first event design: every event has an Avro schema in
  `packages/events/schemas/` from day one, even with the DB-backed
  implementation.

**Harder**
- A second outbox implementation must be built and validated when the
  trigger fires; this is real work that will land mid-program.
- The DB-backed outbox does not scale to high-fanout / high-volume
  events; before it becomes the bottleneck (currently it is not), the
  Redpanda swap must complete.

## Alternatives considered

- **Apache Kafka** — rejected: ZooKeeper/KRaft + JVM operational
  weight without a meaningful feature delta over Redpanda for our
  scale.
- **NATS JetStream** — rejected: smaller community in Nigeria, and
  Kafka wire-compat is strategically valuable for vendor optionality.
- **AWS MSK / Confluent Cloud** — rejected: introduces a new cloud
  vendor and US/EU egress costs against a primarily Hetzner-resident
  workload.
- **PostgreSQL LISTEN/NOTIFY as primary** — rejected: insufficient
  durability and fanout characteristics for stream-chat and
  analytics-grade events; acceptable only for low-volume notification.
- **Adopt Redpanda from day one** — rejected because it adds
  operational burden before any single-consumer event needs a broker.

## Re-evaluation triggers

- A second consumer for any event type appears (Phase 3 trigger).
- Any event type's daily volume exceeds 100k records (DB outbox
  becomes a write hotspot).
- A regulated requirement (CBN, NDPC) demands broker-grade durability
  guarantees for a specific event class.
