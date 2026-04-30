# Glossary — Epplaa Platform

Acronyms, project-specific terms, and product vocabulary used across
the codebase, the architecture spec, and the v4.2 amendment. Terms
are alphabetical.

## A

- **ADR** — Architectural Decision Record. See `docs/adr/`.
- **App Router** — Next.js routing model used by `apps/web` (Phase 6).
- **Argo CD** — GitOps continuous delivery tool, deploys from
  `infra/argocd/applications/`.
- **Avro** — Schema format for events in `packages/events/schemas/`.

## B

- **Buyer** — Nigerian end-user purchasing through the web/mobile
  client.
- **Buyer SPA** — Existing Vite + React SPA at
  `artifacts/epplaa-app` → (Phase 1) `apps/web-buyer-spa`.

## C

- **CDC** — Change Data Capture (Debezium against Postgres).
- **CDF** — Cardholder Data Flow (PCI DSS terminology).
- **CDN** — Content Delivery Network (Cloudflare).
- **CI** — Continuous Integration (GitHub Actions, `.github/workflows/`).
- **Clerk** — Identity provider in use today; see ADR-0003.
- **ClickHouse** — Column-oriented analytics DB; gated per ADR-0008.
- **Cloudflare Stream** — Managed video distribution (LL-HLS + DVR).
- **CODEOWNERS** — `.github/CODEOWNERS`. Defines review routing.

## D

- **dbt** — Data Build Tool, transformations on top of ClickHouse.
- **Debezium** — Postgres CDC source connector.
- **Drizzle** — ORM used in `lib/db` (→ `packages/db`).
- **DR** — Disaster Recovery. Hetzner FSN1 → HEL1 failover.

## E

- **EAS** — Expo Application Services. EAS Build, EAS Update (OTA).
- **Epplaa Boxes** — Smart-locker first-mile fulfillment tier.
- **Expo** — React Native distribution + tooling. See ADR-0005.

## F

- **Fabric** — React Native New Architecture renderer.
- **Flutterwave** — One of two Nigerian payment rails.
- **FSN1** — Hetzner Falkenstein region (primary).

## G

- **Gateway** — API gateway tier (Cloudflare + Traefik).
- **GIG** — GIG Logistics, Nigerian 3PL partner.
- **GitOps** — Operational model where the cluster reflects Git.

## H

- **HEL1** — Hetzner Helsinki region (DR).
- **Helm** — Kubernetes package manager. Charts under `infra/helm/`.
- **Hermes** — JavaScript engine used by RN on Android/iOS.
- **HLS** — HTTP Live Streaming. **LL-HLS** = Low-Latency HLS.
- **Host** — Live-stream broadcaster (also "seller").

## I

- **Idempotency key** — Header carried on payment / order writes.
- **Impeller** — Flutter rendering pipeline (not in use here, see
  ADR-0005).
- **Ingress** — Cluster traffic entry point (Traefik or Cloudflared
  Tunnel).

## K

- **k3s** — Lightweight Kubernetes distribution; the production
  runtime under Hetzner.
- **K6** — Load-testing tool used in `tools/load/` (Phase 9).
- **KRaft** — Kafka in-process consensus (alternative to ZooKeeper).
  Not in use; we ship Redpanda.

## L

- **Lagos edge** — Lagos-resident PoP for live-stream ingest;
  defined in `infra/terraform/modules/lagos-edge/`.
- **Linkerd** — Service mesh, see ADR-0009.
- **Loki** — Grafana logs backend.

## M

- **MFA** — Multi-Factor Authentication. **MFA-elevated session** =
  short-lived session boost required by admin-class endpoints.
- **mediasoup** — SFU library used for low-latency interactive
  streaming.
- **Monolith** — `artifacts/api-server` → (Phase 1)
  `services/api-monolith`. Shrinks each Phase 4 sprint.

## N

- **NDPR / NDPC** — Nigeria Data Protection Regulation / Commission.
- **Next.js** — React framework for `apps/web` (Phase 6).

## O

- **OPA / Rego** — Open Policy Agent and its policy language.
- **OpenSearch** — Search engine, gated per ADR-0007.
- **OTel** — OpenTelemetry. SDK + Collector + traces/metrics/logs.

## P

- **Pact** — Consumer-driven contract test framework (Phase 9).
- **Paystack** — One of two Nigerian payment rails.
- **PCI DSS** — Payment Card Industry Data Security Standard.
- **PoP** — Point of Presence (Lagos edge).
- **PUDO** — Pickup / Drop-off, Tier-2 fulfillment (corner shops).

## Q

- **QSA** — Qualified Security Assessor (PCI DSS auditor role).

## R

- **RACI** — Responsible / Accountable / Consulted / Informed.
- **Redpanda** — Kafka-API-compatible event broker; see ADR-0006.
- **Replays** — Post-stream recordings stored via Cloudflare Stream
  with metadata in the existing `replays` Postgres table.
- **RN** — React Native. See ADR-0005.
- **Runbook** — Operational procedure, under `docs/runbooks/`.

## S

- **SAQ-A** — Lowest PCI DSS self-assessment tier; achievable when
  PAN never touches our infrastructure.
- **Schema Registry** — Avro schema service alongside Redpanda.
- **Seller** — Same as host; Nigerian merchant going live.
- **Shipbubble** — Nigerian shipping aggregator.
- **SFU** — Selective Forwarding Unit (mediasoup).
- **SLO / SLI** — Service Level Objective / Indicator.
- **SPA** — Single-Page Application (the existing buyer app).
- **SSR** — Server-Side Rendering (Next.js for buyer pages, Phase 6).
- **STRIDE** — Spoofing / Tampering / Repudiation / Information
  disclosure / Denial of service / Elevation of privilege. The threat
  modelling taxonomy used in `docs/threat-model.md`.

## T

- **T&S** — Trust & Safety (admin moderation surface).
- **TanStack Query** — Server-state data hook used on web and mobile.
- **TanStack Router** — Routing library used by operator SPAs.
- **Tempo** — Grafana traces backend.
- **Traefik** — Cluster ingress controller.
- **TurboModules** — RN New Architecture native-module bridge.

## V

- **Vault** — Secrets backbone, see ADR-0010.
- **Vite** — Build tool used by current SPA and operator surfaces.

## W

- **WAF** — Web Application Firewall (Cloudflare).
- **WebRTC** — Real-time communication standard for live streaming.
- **WHIP / WHEP** — WebRTC-HTTP Ingestion / Egress Protocol.

## Z

- **Zustand** — State container used on web and (per ADR-0005) mobile.
