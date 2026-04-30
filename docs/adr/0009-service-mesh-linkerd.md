# ADR-0009: Service mesh — Linkerd

- **Status**: Accepted
- **Date**: 2026-04-30
- **Deciders**: Architecture WG, Platform Eng

## Context

Once the strangler-fig (ADR-0001) produces more than one or two
services on the Hetzner k3s cluster, we need consistent
service-to-service identity, mTLS, retries with timeouts, and golden
signals (latency, traffic, errors, saturation) without per-service
code changes. A service mesh provides these as a sidecar concern.

The two mainstream choices are Istio and Linkerd. Both meet the
functional bar; the operational profiles diverge significantly.

## Decision

Adopt **Linkerd** as the service mesh, deployed via Helm in
`infra/helm/linkerd/`. Mesh the namespaces hosting:

- `services/api-monolith` (first; validates the substrate).
- Each new service as it is extracted (Phase 4).

## Consequences

**Easier**
- Automatic mTLS between meshed pods — eliminates the per-service
  TLS bootstrap problem.
- Golden-signal metrics emitted to Prometheus without per-service
  instrumentation, providing a baseline before per-service OTel work
  is complete.
- Linkerd's Rust-based proxy has a smaller resource footprint and a
  smaller CVE surface than Envoy (Istio's data plane).
- Linkerd has documented stable upgrade paths and a small,
  well-defined feature surface — operators can understand the whole
  thing.

**Harder**
- Linkerd's traffic-management primitives (TrafficSplit, retries,
  timeouts) are less expressive than Istio's `VirtualService` /
  `DestinationRule`. For our launch use cases (canary deploys, basic
  retries) this is sufficient; for complex L7 routing we will use
  the gateway (Traefik / Cloudflare) tier instead.
- Linkerd does not natively support multi-cluster mesh on the open
  edition without Buoyant Cloud; for the FSN1↔HEL1 DR topology we
  treat each cluster as an independent mesh and federate at the
  gateway tier.

## Alternatives considered

- **Istio** — rejected: operational complexity, larger CVE surface,
  Envoy-proxy memory footprint, and a feature set we will not use at
  launch scale.
- **Cilium Service Mesh** — interesting and promising, especially as
  it shares the data plane with the CNI. Rejected for now because
  Linkerd is more mature in the production-incident-runbook sense and
  Cilium's mesh is still rapidly evolving.
- **No mesh, do mTLS in application code** — rejected: every service
  re-implements the same boilerplate; rotation, identity, and audit
  become per-service problems.
- **Cloudflare Tunnel + Cloudflare Access for everything** — rejected
  because it does not solve east-west traffic between services in the
  cluster, only the north-south boundary.

## Re-evaluation triggers

- A use case demands traffic-management primitives Linkerd does not
  expose (e.g., complex header-based routing for shadow tests at L7).
  Revisit Istio or evaluate adding Cilium specifically for those
  paths.
- Linkerd's roadmap stalls or its open-edition feature surface is
  materially restricted by the maintainer.
