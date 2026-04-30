# ADR-0001: Strangler-fig migration from monolith to microservices

- **Status**: Accepted
- **Date**: 2026-04-30
- **Deciders**: Architecture WG

## Context

The v4.1 architecture spec describes a polyglot microservices topology
across roughly twelve domain services (notification, identity, catalog,
manufacturer, cart, payment, order, fulfillment, discovery, stream,
admin, analytics). The current code base is a single Express monolith
at `artifacts/api-server` with real domain logic, real tests, and
production traffic patterns already validated against it.

A "big-bang" rewrite — building the twelve services in parallel and
cutting over in one release — would discard hundreds of person-weeks
of validated domain logic, force every team to coordinate on a single
release boundary, and accept all the risk in one window. We have seen
this pattern fail in similar-stage companies; we will not repeat it.

## Decision

We will migrate from the monolith to the v4.1 service topology using
the **strangler-fig pattern** (Fowler). Concretely:

1. The monolith is renamed (Phase 1) to `services/api-monolith` and
   continues to serve all routes by default.
2. An API gateway (Cloudflare in front of an internal Traefik ingress)
   sits between clients and the monolith. From day one, every route
   is reachable via the gateway; nothing is bypassing it.
3. New services are extracted from the monolith one at a time, in the
   order specified in [v4.2 amendment §Phase 4]. For each extracted
   service:
   a. The new service is deployed alongside the monolith.
   b. The gateway begins shadowing requests to it (read-only diff).
   c. Once the diff is clean for one week, the gateway cuts over.
   d. The migrated code is deleted from the monolith.
4. When the monolith has no remaining routes it is deleted.

## Consequences

**Easier**
- Every extraction is independently revertable at the gateway level.
- The monolith's existing tests stay green throughout, providing a
  regression net for the routes still living there.
- Teams can extract services in parallel only when the dependency
  graph permits (notification before identity, catalog before cart,
  etc.) — coordination cost is bounded.
- Production risk is bounded to one service per extraction window.

**Harder**
- We must operate a hybrid monolith-plus-services topology for
  ~12 sprints. This requires the gateway, observability, and
  service-mesh substrate (Phase 2/3) to be in place before the *first*
  extraction, not after.
- Some database tables are co-owned by multiple soon-to-be services
  during the transition; we accept temporary cross-service SQL access
  via the monolith and remove it as the last step of each extraction.

## Alternatives considered

- **Big-bang rewrite** — rejected for the reasons in *Context*.
- **Branch-by-abstraction inside the monolith** — useful as a
  *technique* during an extraction but not as a *strategy* on its own,
  because it never produces independently deployable services.
- **Build new services and keep the monolith forever** — rejected
  because it permanently retains the monolith's blast radius and
  release-cadence coupling.

## Re-evaluation triggers

- If after the first three extractions (notification, identity,
  catalog) we find the gateway / observability substrate is the
  bottleneck rather than service code, pause extractions and invest
  further in Phase 2/3 capabilities.
- If a regulatory event (e.g., NDPC audit, PCI re-scoping) demands
  faster isolation of a specific domain (most likely payment), that
  service jumps the queue — the strangler-fig pattern is robust to
  re-ordering.
