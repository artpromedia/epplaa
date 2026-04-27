**EPPLAA**

Social Commerce Platform

**Enterprise Architecture & Sprint Plan**

Version 4.1   |   April 2026

Launch Market: Nigeria   |   Manufacturers: Vietnam, China, Japan, Taiwan

*Self-contained successor to v1.0 / v2.0 / v3.0*

**CONFIDENTIAL — INTERNAL USE ONLY**

# **Document Control**

## **1\. Purpose & Scope**

This document defines the technical architecture, non-functional requirements, security and compliance posture, operational standards, and sprint-level delivery plan for the Epplaa social commerce platform. Version 4.0 supersedes versions 1.0, 2.0, and 3.0 in their entirety. It is the single authoritative source of truth for the engineering, infrastructure, security, and product teams.

This document is written to enterprise-readiness standards: every architectural decision carries an explicit rationale, every external dependency carries a version pin and an upgrade strategy, every cross-cutting concern (security, observability, reliability, compliance) is addressed as a first-class concern rather than an afterthought.

## **2\. Audience**

Primary audience: engineering leadership, platform engineers, security engineering, SRE, product management, and the technical steering committee. Secondary audience: external auditors (NDPC, CBN, FCCPC, PCI QSA), prospective enterprise partners, and prospective investors performing technical due diligence.

## **3\. Version History**

| Version | Date | Author | Changes |
| :---- | :---- | :---- | :---- |
| v1.0 | Jan 2026 | Architecture WG | Initial 14-sprint architecture and plan. |
| v2.0 | Feb 2026 | Architecture WG | Added Hetzner infrastructure, Flutter mobile, social media restream relay, multistreaming. |
| v3.0 | Apr 2026 | Architecture WG | Nigeria-first launch strategy, fulfillment & logistics architecture (Epplaa Boxes, 3PL aggregation), Paystack \+ Flutterwave payments, Node 24 LTS, ESLint 10 flat config, manufacturer origin countries (VN/CN/JP/TW), UI/UX design system summary. Issued as an addendum. |
| v4.0 | Apr 2026 | Architecture WG \+ Security \+ SRE | Self-contained replacement for v1.0–v3.0. Corrected infrastructure topology (Hetzner has no African region; introduced Lagos edge ingest tier). Added Section 3 Security Architecture (NDPR, PCI DSS SAQ-A scoping, secrets, threat model). Added Section 7 Live Streaming Architecture with realistic latency budget. Added Section 9 Observability, Reliability & Operations (SLO/SLI/error-budget framework, OpenTelemetry stack, runbooks). Added Section 10 Quality Engineering. Added Section 11 Compliance & Regulatory. Added ADR appendix, dependency matrix with version pins, glossary, RACI. Promoted Next.js to a versioned decision (15.x with documented N-1 rationale and 16.x evaluation gate). Updated technology stack table to remove ambiguity and added an explicit risk register. |
| v4.1 | Apr 2026 | Architecture WG \+ Mobile Lead | Expanded §5.5 Mobile Architecture with full package layer detail (Riverpod 2.x, go\_router, dio, drift, flutter\_webrtc, video\_player \+ chewie \+ ExoPlayer/AVPlayer bridges, FCM, Shorebird OTA, app size and memory budgets, OS coverage rationale). Added §5.4.2 carving operator and admin surfaces (admin / studio / partner) into a Vite \+ React SPA workspace, separate from the buyer-facing Next.js application. Rewrote ADR-007 to drop the obsolete "JavaScript bridge" rationale and re-justify Flutter on Impeller-pre-compiled-shader performance and pixel-perfect rendering across the Nigerian mid-tier Android device range. Added ADR-009 documenting the buyer / operator web split. |

## **4\. Approvals**

This document requires the following approvals before it is considered the binding architecture baseline. Approvals must be recorded in the engineering wiki with a timestamped digital signature; this table is illustrative.

| Role | Name | Approval Date | Comments |
| :---- | :---- | :---- | :---- |
| CTO / VP Engineering | \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_ | \_\_\_\_\_\_\_\_\_\_\_\_ |  |
| Head of Security | \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_ | \_\_\_\_\_\_\_\_\_\_\_\_ |  |
| Head of SRE / Platform | \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_ | \_\_\_\_\_\_\_\_\_\_\_\_ |  |
| Head of Product | \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_ | \_\_\_\_\_\_\_\_\_\_\_\_ |  |
| Data Protection Officer | \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_ | \_\_\_\_\_\_\_\_\_\_\_\_ |  |
| Finance / Compliance | \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_ | \_\_\_\_\_\_\_\_\_\_\_\_ |  |

## **5\. Reading Guide**

* Sections 0 and 1 set the business context and the technology stack with rationale.

* Sections 2–6 are the architecture core: infrastructure, security, data, services, streaming.

* Sections 7–8 cover the two Nigeria-specific differentiators: fulfillment and payments.

* Sections 9–11 cover the cross-cutting enterprise concerns: ops, quality, compliance.

* Sections 12–13 cover the user-facing design system and the sprint plan.

* Appendices contain the architectural decision record (ADR) summary, the dependency matrix, the risk register, the glossary, and integration directories.

# **Executive Summary**

Epplaa is a live social commerce platform launching in Nigeria in 2026\. The platform combines short-form video, live streaming, and integrated checkout in the model proven by TikTok Shop and Taobao Live. Sellers in Nigeria source products from manufacturers in Vietnam, China, Japan, and Taiwan, and reach buyers across Nigeria through a hybrid fulfillment network of smart lockers (Epplaa Boxes), pickup partners (PUDO), and 3PL home delivery.

## **Strategic context**

Nigeria is the largest e-commerce market in Africa (≈26% of African e-commerce GMV, \~USD 10.5B in 2026, \~12% YoY growth). Mobile-first social usage is high; the gap between social engagement and structured live commerce is the opportunity. Two structural problems must be solved on day one: payments (resolved with a CBN-licensed dual gateway) and fulfillment (resolved with a three-tier hybrid model). Both are described in detail in Sections 7 and 8\.

## **Technology stance**

* Polyglot microservices on Node.js 24 LTS (Krypton, EOL April 2028\) with TypeScript strict mode. *See §1.4 for the complete dependency matrix.*

* Web on Next.js 15.x (App Router, React 19\) with documented N-1 rationale and a Q4 2026 evaluation gate for Next.js 16.x; mobile on Flutter (stable channel) targeting iOS 16+ and Android 8+.

* Primary compute on Hetzner Cloud (European regions: Falkenstein, Helsinki) for cost efficiency, fronted by Cloudflare for global edge, DDoS, and WAF. A Lagos edge ingest tier handles seller live streams to keep ingest latency under 250 ms within Nigeria.

* PostgreSQL 16 as the system of record per service, Redis 7 for caching and sessions, Kafka (Redpanda) as the event backbone, OpenSearch for product and stream search, ClickHouse for analytics and stream telemetry.

* OpenTelemetry end-to-end (logs, metrics, traces) feeding Grafana, Prometheus, Loki, and Tempo. Sentry for client-side and backend error tracking. Per-service SLOs with error budgets governed by SRE.

* Payments via Paystack (primary) and Flutterwave (failover); fulfillment via Shipbubble aggregator plus GIG Logistics direct integration; address verification via OkHi.

## **What changed in v4.0 (the short list)**

| Critical correction v3.0 referred to "evaluating Hetzner's Johannesburg data center." Hetzner Cloud (Hetzner Online GmbH, Germany) has no African region — its locations are Nuremberg, Falkenstein, Helsinki, Singapore, Ashburn (VA), and Hillsboro (OR). The "Hetzner" present in Johannesburg is Xneelo (formerly "Hetzner SA"), a separately incorporated South African company that rebranded in 2019\. v4.0 replaces this aspiration with a concrete, achievable topology: Hetzner Cloud in Falkenstein (primary) and Helsinki (DR) for stateful workloads, with a dedicated Lagos edge ingest tier (Section 7\) for live streaming. This is the difference between a plausible-sounding plan and one that meets a 250 ms RTT latency budget for Nigerian users. |
| :---- |

* Section 3 (Security Architecture) is new: identity, authorization, secrets, key management, threat model, vulnerability management.

* Section 7 (Live Streaming Architecture) is new and replaces vague references in v2.0: HLS / LL-HLS for playback, RTMP / WHIP for ingest, mediasoup-based SFU for low-latency interactive paths, explicit latency budgets.

* Section 9 (Observability, Reliability & Operations) is new: SLO/SLI/error-budget framework, OpenTelemetry, on-call rotation, incident severity matrix, runbook standard.

* Section 10 (Quality Engineering) is new: testing pyramid, coverage thresholds, SAST/DAST/SCA in the pipeline, performance and load testing.

* Section 11 (Compliance & Regulatory) is new: NDPR (Nigeria Data Protection Regulation), CBN PSP guidelines, FCCPC consumer protection, PCI DSS SAQ-A scoping, GDPR for any EU traffic.

* Appendix C (Architectural Decision Records) and Appendix D (Risk Register) are new and replace the ad-hoc rationale prose scattered through earlier versions.

## **Risk highlights**

The risk register is in Appendix D. The four risks the executive team should track personally are: (1) live streaming latency from European origins to Nigerian viewers — mitigated by Lagos edge ingest and Cloudflare Stream; (2) payment gateway concentration risk — mitigated by dual-gateway failover and a documented Paystack-to-Flutterwave fail-over runbook; (3) fulfillment last-mile failure rate — mitigated by Epplaa Box / PUDO preference at checkout and OkHi address verification; (4) NDPR and CBN regulatory exposure — mitigated by a registered DPO and the controls in Section 11\.

# **Part 0 — Market Context & Launch Strategy**

## **0.1 Nigeria-First Launch**

Epplaa launches first in Nigeria, the largest e-commerce market in Africa. Nigeria accounts for approximately 26% of total African e-commerce revenue, with the market valued at roughly USD 10.5 billion in 2026 and growing at 12% annually. Social commerce is a dominant force: an estimated 36.8 million Nigerian social media users spend close to four hours daily on platforms with embedded checkout flows, and social commerce transaction value is projected to nearly double from USD 2 billion in 2025 to USD 4 billion by 2030\.

Nigeria's young, mobile-first population is already accustomed to buying through social platforms, and the gap between informal social engagement and structured live commerce infrastructure creates the opening Epplaa is targeting. Two structural challenges must be solved from day one: payments and fulfillment. Both are addressed architecturally in Sections 7 and 8 respectively.

## **0.2 Manufacturer Origin Markets**

Epplaa's manufacturer ecosystem spans four Asian manufacturing powerhouses, each serving different product categories and price tiers. The platform's manufacturer service supports onboarding from all four countries with localised documentation, multi-currency catalogue pricing (USD, CNY, VND, JPY, TWD), and integration with international freight forwarders for consolidated shipping to a Lagos bonded warehouse.

| Country | Primary Categories | Strengths | Lead Time to Lagos |
| :---- | :---- | :---- | :---- |
| Vietnam | Apparel, footwear, textiles, furniture | Competitive labour costs; growing export infrastructure; ECOWAS-friendly trade preferences | Sea: 25–35 days via Ho Chi Minh / Hai Phong → Lagos (Apapa / Tin Can) |
| China | Electronics, consumer goods, beauty, accessories, general merchandise | Massive scale; competitive pricing; established Africa trade routes; mature B2B platforms | Sea: 30–40 days via Shenzhen / Ningbo → Lagos. Air: 5–7 days |
| Japan | Electronics, beauty / skincare, automotive parts, precision instruments | Premium quality; strong brand trust; innovation | Air: 4–6 days. Sea: 35–45 days via Yokohama → Lagos |
| Taiwan | Semiconductors, electronics components, machinery, textiles | High-tech manufacturing; quality standards; specialised components | Sea: 35–45 days. Air: 5–7 days via Taipei → Lagos |

## **0.3 Out-of-Scope Markets (v1.0 launch)**

To preserve focus, the following are explicitly out of scope for the initial Nigeria launch and will be addressed in subsequent expansion phases (timing in Section 13):

* Other ECOWAS markets (Ghana, Côte d'Ivoire, Senegal). Targeted for Phase 2 expansion (Q3 2027).

* Regional African markets outside ECOWAS (Kenya, South Africa, Egypt). Targeted for Phase 3 (2028).

* Consumer-to-consumer (C2C) used-goods marketplace.

* Crypto-denominated payments (bitcoin, stablecoins). Will be re-evaluated against CBN guidance.

# **Part 1 — Technology Stack & Standards**

The technology stack is described in three layers: the runtime stack (1.1), the application architecture stack (1.2), and the platform / infrastructure stack (1.3). Section 1.4 records every external dependency with version pin, rationale, and upgrade strategy. Section 1.5 documents the standards and conventions every team is expected to follow.

## **1.1 Runtime & Language Stack**

| Concern | Choice | Rationale |
| :---- | :---- | :---- |
| Backend runtime | Node.js 24.x LTS (Krypton) | Active LTS; supported through April 2028\. Replaces Node 20.x which reached EOL April 30 2026\. Pin via .nvmrc, package.json engines field, Docker base image (node:24-alpine), and CI matrix. Upgrade gate: re-evaluate against Node 26 LTS in Q4 2027\. |
| Backend language | TypeScript 5.x in strict mode | "strict": true plus noUncheckedIndexedAccess. Project-wide tsconfig with path aliases. Compile target: ES2023. |
| Web framework | Next.js 15.x (App Router) | N-1 selection. Next.js 16 stable since October 2025 and at 16.2.x by April 2026; v4.0 stays on 15.x for launch stability and to avoid the Turbopack-by-default risk on day one. Re-evaluation gate Q4 2026 with explicit 16.x migration sprint reserved (Sprint 16). |
| Web React version | React 19.x | Required by Next.js 15 App Router; production-proven through 2025–2026. |
| Component library | shadcn/ui on Tailwind CSS 4 | Copy-in components avoid library lock-in. React 19 compatible. Design tokens exported to design-tokens.json. |
| Mobile framework | Flutter (stable channel) | Cross-platform reach with one codebase. Targets iOS 16+ and Android 8+ (API 26+). Riverpod for state, Material 3 widgets, Dart 3.x. |
| Linting (JS/TS) | ESLint 10.x (flat config) | .eslintrc removed in ESLint 10\. Use eslint.config.mjs with defineConfig(). next lint removed in Next.js 16; CI invokes eslint directly so the linter is independent of build tool decisions. |
| Formatting | Prettier 3.x | Single source of formatting truth; runs in pre-commit and CI. |
| Package manager | pnpm 9.x | Faster, disk-efficient, strict by default. Workspace support for the monorepo. |

## **1.2 Application Architecture Stack**

| Concern | Choice | Rationale |
| :---- | :---- | :---- |
| Architectural style | Microservices over a shared platform | Service-per-bounded-context. Service boundaries listed in Section 5\. Synchronous calls only across well-defined HTTP/gRPC contracts; async-first wherever possible. |
| Inter-service sync | REST (JSON over HTTPS) for external; gRPC for internal hot paths | External APIs use REST \+ OpenAPI 3.1 (machine-readable contracts). Internal high-throughput paths (cart→catalog, fulfillment→order) use gRPC for lower overhead. |
| Inter-service async | Apache Kafka via Redpanda | Self-hosted Redpanda chosen over managed Kafka for cost (Hetzner). Event-driven backbone for orders, payments, fulfillment, notifications. Schema registry enforces compatible evolution. |
| API gateway | Cloudflare in front; Kong (open-source) at the cluster edge | Cloudflare provides DDoS, WAF, bot management, rate limiting at the edge. Kong handles routing, auth, request transformation, and per-route rate limiting at the cluster boundary. |
| Auth | OIDC via Keycloak (self-hosted) | Standard OIDC \+ OAuth 2.1 flows. JWT access tokens (short-lived, 15 min); refresh tokens (rotated, 30 day idle TTL). MFA via TOTP for sellers and admins. Session management in Redis. |
| Database (OLTP) | PostgreSQL 16 | Per-service database (no shared schema). Logical replication for read replicas. pgBouncer for connection pooling. |
| Cache & sessions | Redis 7.x (Sentinel) | Cache-aside for reads. Sessions and rate-limit counters. Redis Streams for ephemeral pub-sub. |
| Search | OpenSearch 2.x | Product search, stream discovery, seller discovery. Apache 2.0 fork avoids Elastic licensing issues. Kibana → OpenSearch Dashboards. |
| Analytics | ClickHouse | High-throughput append-only telemetry: stream events, viewer engagement, conversion funnels, fulfillment KPIs. Read-replicated to a BI layer (Metabase). |
| Object storage | Cloudflare R2 (primary), Hetzner Object Storage (DR) | R2 has no egress fees and integrates natively with Cloudflare CDN. Hetzner Object Storage for DR copies and warm backups. |
| Background jobs | BullMQ on Redis (light); Kafka consumers (heavy) | BullMQ for short tasks (email, SMS, image resize). Kafka consumer groups for high-volume workflows. |
| Real-time chat | mediasoup SFU \+ Socket.IO | In-stream chat is high-fanout; SFU pattern keeps mass-broadcast efficient. Socket.IO for client compatibility. |

## **1.3 Platform & Infrastructure Stack**

| Concern | Choice | Rationale |
| :---- | :---- | :---- |
| Cloud (compute, storage) | Hetzner Cloud — Falkenstein (primary), Helsinki (DR) | EU regions. Primary choice for cost. EXPLICIT NOTE: Hetzner Cloud has no African region; this is solved by the Lagos edge ingest tier (Section 2.3). |
| Edge / CDN / DDoS | Cloudflare (Free \+ Pro on critical zones; Workers, R2, Stream) | Global anycast network with Lagos PoP. WAF, DDoS, bot management, rate-limit, image resizing, Stream for HLS distribution, Workers for edge logic. |
| Lagos edge ingest | Hetzner Cloud Singapore is NOT used; instead a co-located bare-metal node at Rack Centre Lagos (or MainOne / MDXi) | Required to meet the live-streaming latency budget. Runs RTMP/WHIP ingest, transcoder, and a Cloudflare Stream forwarder. Detailed in Section 7\. |
| Container runtime | Docker; orchestrated by Kubernetes (k3s on Hetzner) | k3s (lightweight Kubernetes) chosen over EKS/GKE because Hetzner is the cloud. Hardened CNCF distribution. Cluster autoscaler via Cluster API. |
| Service mesh | Linkerd 2.x | Lighter than Istio; mTLS-by-default between services; per-service identity; minimal operational overhead. |
| Secrets management | HashiCorp Vault (self-hosted, HA) | Centralised secrets. Dynamic database credentials. Transit engine for envelope encryption. Auto-unseal with cloud KMS. |
| CI/CD | GitHub Actions (build, test) \+ Argo CD (deploy) | GitOps deploy: Argo CD reconciles cluster state from a Git repo. Promotion via PR-driven manifest changes. |
| IaC | Terraform 1.7+ (Hetzner provider, Cloudflare provider) \+ Helm \+ Argo CD | All cloud resources, DNS, and Cloudflare config in Terraform. All Kubernetes resources in Helm charts deployed via Argo CD. |
| Observability — metrics | Prometheus \+ Grafana (mTLS via Linkerd) | Per-service /metrics endpoint. Grafana dashboards versioned in Git. |
| Observability — logs | Loki \+ Grafana | Structured JSON logs only. Per-pod log shipping with Promtail. Retention 30 days hot, 1 year cold (R2). |
| Observability — traces | OpenTelemetry → Tempo | OpenTelemetry SDK in every service. W3C trace context propagated end-to-end. |
| Error tracking | Sentry (self-hosted) | Front-end and back-end exceptions; release-tagged. |
| Status page | Cachet (self-hosted) at status.epplaa.com | Public status page; component-level granularity; subscriber notifications for major incidents. |
| **Why not the hyperscalers?** AWS, GCP, and Azure all offer richer managed services and a Cape Town / Johannesburg / Lagos region (AWS af-south-1; Azure South Africa North; GCP no Africa region). For Epplaa's cost profile at launch, Hetzner is approximately 4–7× cheaper for equivalent compute. The trade-off accepted: more self-managed components (Kafka, OpenSearch, Vault). The Lagos edge ingest tier addresses the latency consequence. A re-evaluation gate is set for end of 2027 when hyperscaler costs may be justified by scale. |  |  |

## **1.4 Dependency Matrix (version pins & upgrade strategy)**

Every external dependency is listed with the exact pinned version, the support window, and the upgrade strategy. The full machine-readable manifest lives in the monorepo at deps.yaml; this table is the human-readable contract.

| Dependency | Pinned | Support Until | Tracked By | Upgrade Strategy |
| :---- | :---- | :---- | :---- | :---- |
| Node.js | 24.x LTS | Apr 2028 | Platform | Upgrade to next even LTS within 6 months of release. |
| TypeScript | 5.x latest minor | rolling | Platform | Minor upgrades every quarter; major within one minor of release. |
| Next.js | 15.x latest minor | Q4 2026 | Web | 16.x evaluation gate Q4 2026; migration sprint reserved (Sprint 16). |
| React | 19.x | Aligned with Next | Web | Tracks Next.js requirement. |
| Tailwind CSS | 4.x | rolling | Web | Minor upgrades quarterly. |
| shadcn/ui | latest copy-in | rolling | Design Sys | Component-by-component refresh; no global lock. |
| Flutter | stable channel | rolling | Mobile | Quarterly upgrade aligned with stable releases. |
| ESLint | 10.x | rolling | Platform | Flat config only; pin major. |
| PostgreSQL | 16.x | Nov 2028 | Data | Upgrade plan when v16 enters its final year. |
| Redis | 7.2 OSS | Aligned with OSS fork | Platform | Track Valkey (OSS fork) to avoid SSPL exposure. |
| Kafka (Redpanda) | latest stable | rolling | Platform | Quarterly upgrade in pre-prod, then prod. |
| OpenSearch | 2.x latest | rolling | Search | Upgrade per OpenSearch project cadence. |
| ClickHouse | LTS releases only | rolling | Data | LTS-only policy. |
| k3s | latest LTS | rolling | Platform | Track upstream Kubernetes minor releases. |
| Linkerd | 2.x stable | rolling | Platform | Minor upgrades quarterly. |
| Vault | 1.x latest CE | rolling | Security | Track quarterly. Evaluate Vault 2.x or OpenBao when GA. |
| Cloudflare | managed | managed | Platform | No version concern; track API deprecations. |
| Paystack SDK | latest | rolling | Payments | SDK upgrade within 30 days of release. |
| Flutterwave SDK | latest | rolling | Payments | SDK upgrade within 30 days of release. |
| Shipbubble API | v2 | rolling | Fulfillment | API version pinning; deprecation tracking. |
| OkHi SDK | latest | rolling | Fulfillment | SDK upgrade within 30 days of release. |

## **1.5 Engineering Standards**

### **1.5.1 Repository structure**

Single monorepo. apps/web (Next.js), apps/mobile (Flutter), services/\* (one folder per microservice), packages/\* (shared TypeScript libraries), infra/terraform, infra/helm, infra/argocd, deploy/runbooks, docs/. Workspace managed by pnpm. CODEOWNERS file enforces per-folder review ownership.

### **1.5.2 Branching & merging**

* Trunk-based development with short-lived feature branches.

* Pull-request only — no direct push to main. Two reviewers required for service code; one reviewer for docs and tests.

* All commits signed (GPG or SSH-with-signing). Unsigned commits are rejected by branch protection.

* Conventional Commits format. CI generates the changelog automatically.

### **1.5.3 Definition of Done**

* All quality gates green (build, lint, type-check, unit, integration, SAST, SCA — see Section 10).

* Code coverage threshold met (80% line coverage on changed files; service-level minimum 70%).

* OpenAPI spec updated for any API change; consumer contract tests passing.

* Observability: logs, metrics, and traces visible in staging dashboards before merge to main.

* Security: threat model updated if architecture changed; secrets only via Vault; dependencies free of known critical/high CVEs (Section 3.7).

* Documentation: runbook updated; ADR added if architecturally significant; changelog entry recorded.

* Feature flag in place for any user-visible change; rollback path documented.

### **1.5.4 API contracts**

* Every public API is OpenAPI 3.1 specified, with the spec living next to the code and validated in CI.

* Versioning via URL (/api/v1, /api/v2). v1 supported for at least 12 months after v2 release.

* Breaking changes require an ADR and a deprecation notice via API headers and the developer portal at least 90 days in advance.

# **Part 2 — Infrastructure & Deployment Architecture**

This section is the largest correction in v4.0. The earlier "Hetzner \+ Cloudflare" framing was correct in spirit but vague in detail and contained one factual error (a Hetzner Johannesburg region that does not exist). v4.0 documents the topology that actually meets the latency, availability, and cost objectives.

## **2.1 Topology Overview**

The platform runs on three coordinated tiers. Each is designed to fail independently:

* Tier 1 — **Cloudflare global edge**. All client traffic terminates at Cloudflare. Lagos, Johannesburg, Cape Town, and Accra PoPs serve African users. Cloudflare Stream distributes HLS playback. Cloudflare R2 hosts static assets and HLS manifests with no egress cost. WAF, DDoS, bot management, rate-limiting, and image resizing run here.

* Tier 2 — **Lagos edge ingest tier**. Co-located bare-metal at a tier-3 Lagos data centre (Rack Centre Lagos primary; MainOne / MDXi as alternatives). Runs RTMP / WHIP ingest, the live transcoder, and the publisher to Cloudflare Stream. Detailed in Section 7\.

* Tier 3 — **Hetzner Cloud — Falkenstein (primary) and Helsinki (DR)**. All stateful workloads, microservices, databases, message brokers, and the analytics estate. Network-bridged via Cloudflare Tunnel and Hetzner private networks; no service is exposed directly to the public Internet.

## **2.2 Hetzner Cloud Reality Check**

| Hetzner Cloud regions (verified April 2026\) Hetzner Cloud (Hetzner Online GmbH, Germany) operates the following regions: Nuremberg (DE), Falkenstein (DE), Helsinki (FI), Singapore (SG), Ashburn VA (US-East), and Hillsboro OR (US-West). There is no African region. There is no plan published by Hetzner to open one. A separate company in South Africa rebranded from "Hetzner SA" to Xneelo in July 2019 to avoid this exact confusion. Xneelo is a managed-hosting provider, not a cloud-API provider equivalent to Hetzner Cloud. Any architecture document that proposes "Hetzner Johannesburg" as a region is conflating the two. For Epplaa: primary region is Falkenstein (FSN1). DR region is Helsinki (HEL1). Lagos latency to FSN1 is approximately 110–160 ms RTT depending on route. This is acceptable for HTTPS API calls; it is not acceptable for live-stream ingest, which is why Section 7 introduces the Lagos edge ingest tier. |
| :---- |

## **2.3 Lagos Edge Ingest Tier**

A small bare-metal footprint co-located in Lagos provides the geographic anchor required for live-stream ingest, real-time chat fanout to Nigerian viewers, and a fallback static asset cache when Cloudflare egress to Nigerian ISPs is degraded.

| Dimension | Specification |
| :---- | :---- |
| Location (primary) | Rack Centre Lagos (Tier-3 carrier-neutral; on-net to MainOne, IXPN, Rack Centre IX). |
| Location (alternate) | MDXi Lekki (Tier-3; redundant fibre paths to Rack Centre). |
| Initial footprint | 2 × ingest nodes (24-core, 64 GB, 4 × 1 TB NVMe), 2 × transcoder nodes (32-core, 96 GB, GPU-accelerated for AV1/HEVC), 1 × edge cache node (192 GB RAM, 16 TB NVMe). |
| Network | 10 Gbps uplink with redundant carriers. Peering at IXPN (Internet Exchange Point of Nigeria) for direct delivery to MTN, Airtel, Glo, Spectranet, ipNX. |
| Software | Ubuntu 24.04 LTS. nginx-rtmp / SRS for ingest. ffmpeg for transcode. WHIP-Janus or mediasoup for low-latency interactive paths. Prometheus node exporter; OpenTelemetry collector forwards to Falkenstein. |
| Connectivity to Hetzner | WireGuard tunnel (Tailscale or self-managed) over the public Internet plus a backup Cloudflare Tunnel. End-to-end mTLS via Linkerd. |
| Operational ownership | SRE Platform team. The provider (Rack Centre or MDXi) provides smart-hands. No 24×7 on-site staff. |

## **2.4 Network Topology**

The network is organised by trust zone:

| Zone | Description & rules |
| :---- | :---- |
| Public edge (Cloudflare) | All public traffic. Terminates TLS. Applies WAF and rate limits. Forwards to either the Lagos edge or origin via Cloudflare Tunnel. |
| Lagos edge (DMZ) | Receives stream ingest from the public Internet (RTMP/WHIP). Forwards transcoded HLS to Cloudflare Stream. No database access; no PII at rest. |
| Hetzner public ingress | Cloudflare Tunnel terminates inside the cluster (no public IPs on origin services). Linkerd ingress validates mTLS and routes to services. |
| Hetzner application tier | k3s cluster in private network. East-west traffic via Linkerd mTLS. No service has a public IP. |
| Hetzner data tier | Private subnets reserved for PostgreSQL, Redis, Kafka, OpenSearch, ClickHouse, Vault. Reachable only from authorised application services via NetworkPolicies. |
| Out-of-band management | Bastion via Cloudflare Access (zero-trust). SSH only via short-lived certificates issued by Vault. No long-lived keys on engineer workstations. |

## **2.5 Environments**

| Environment | Purpose, isolation, and access |
| :---- | :---- |
| dev | Per-engineer ephemeral environments via Tilt \+ a shared k3d cluster. Synthetic data only. |
| staging | Production-like cluster. Full data pipeline with anonymised production-shaped data (no real PII). All deploys go here first via Argo CD. |
| production | Public traffic. Tightly access-controlled (read-only dashboards for engineers; write access only via tooling). Production data-tier secrets isolated in a dedicated Vault namespace. |
| dr (Helsinki) | Warm standby. Continuous replication of database and object storage. Activated only by SRE during a declared regional incident. |

## **2.6 Backup, Disaster Recovery, and Continuity**

* PostgreSQL: streaming replication to Helsinki (synchronous to one replica, asynchronous to two). Daily base backups \+ WAL archive to Hetzner Object Storage. Cross-region copy to Cloudflare R2 every 6 hours. PITR window of 30 days.

* Redis: AOF \+ RDB snapshots; replicated to a Helsinki replica. Sessions are cold-acceptable; cache is regenerable.

* Kafka (Redpanda): cross-cluster replication to Helsinki via Redpanda Connect.

* Object storage: dual-write to R2 and Hetzner Object Storage. Lifecycle rules age content to Glacier-equivalent after 90 days.

* RPO target: 5 minutes for OLTP; 1 hour for analytics.

* RTO target: 60 minutes for full regional failover (declared incident → traffic on Helsinki).

* DR drills run quarterly. The drill report is appended to the runbook; failures are tracked as engineering work.

# **Part 3 — Security Architecture**

Epplaa handles three classes of sensitive data: customer PII (names, addresses, GPS pins, government IDs for KYC), payment card metadata (tokenised — never raw PAN), and financial flows (settlements, payouts). The security architecture is built around three principles: defence in depth, least privilege, and assume breach. This section maps the controls; Section 11 maps the controls to the regulatory frameworks that require them.

## **3.1 Identity & Access Management**

### **3.1.1 End-user identity**

* Buyers: phone number is the primary identifier (Nigeria-first). OTP via SMS or WhatsApp. Optional email \+ password for cross-device persistence. Optional social login (Google, Apple, Facebook) federated through Keycloak.

* Sellers and partners: phone number \+ email. KYC tier with government ID upload (Section 11.2) before payouts unlocked. MFA via TOTP enforced for sellers above an aggregate transaction threshold.

* Admins and operators: SSO only (no passwords). Hardware security key (FIDO2 / WebAuthn) required. No exceptions.

### **3.1.2 Token model**

| Token | Properties |
| :---- | :---- |
| Access token | JWT signed RS256. TTL 15 minutes. Carries roles and scope claims. Validated by every service via shared JWKS endpoint. |
| Refresh token | Opaque, server-stored. TTL 30 day idle / 90 day absolute. Rotated on every use. Reuse detection triggers session revocation. |
| Service tokens | Short-lived OAuth 2.0 client\_credentials. Issued via Vault auth method. TTL 1 hour. Bound to caller mTLS identity. |
| Webhook signatures | HMAC-SHA256 with per-partner shared secret. Replay protection via nonce \+ 5 minute clock-skew window. |

### **3.1.3 Authorization model**

Authorization is enforced at three layers: (1) coarse role-based at the API gateway, (2) attribute-based per resource at the service, (3) row-level policy at the database for high-risk tables (orders, payouts, KYC). Service-to-service calls carry a propagated user context plus a service-level identity asserted by Linkerd mTLS. Policies are written in OPA / Rego, version-controlled, and unit-tested.

## **3.2 Secrets & Key Management**

* All secrets live in HashiCorp Vault. Static .env files in production are forbidden by policy and detected by SAST.

* Vault auto-unseal via cloud KMS (AWS KMS for the unseal key; Hetzner has no managed KMS).

* Database credentials are dynamic: services request short-lived (1 hour) credentials from Vault. No long-lived database passwords exist.

* Encryption at rest: AES-256 on all volumes. Tokenised PII encrypted with a per-tenant data key, master keys in Vault Transit.

* Encryption in transit: TLS 1.3 minimum on all public surfaces. mTLS on all east-west traffic via Linkerd.

* Key rotation: data encryption keys rotated annually; signing keys (JWT) rotated quarterly with overlap; webhook signing keys rotated on partner request and on incident.

## **3.3 Network & Perimeter Security**

* Cloudflare WAF: managed rules (OWASP Top 10\) plus Epplaa-specific custom rules for product-search abuse, account-enumeration, and credential stuffing.

* Rate limits: tiered per identity class. Anonymous: stricter. Authenticated buyer: standard. Authenticated seller: relaxed for catalog operations.

* DDoS: Cloudflare Magic Transit-class protection at the edge. Hetzner provides volumetric DDoS at the IP level.

* Bot management: Cloudflare Bot Management classifies traffic; only verified bots (Google, social platforms) reach origins. Custom rules block known scrapers.

* No origin server has a public IP. All origin traffic enters through Cloudflare Tunnel, terminated inside the cluster.

* Egress: services have an allowlist of permitted external endpoints (Paystack, Flutterwave, Shipbubble, OkHi, Sentry). All other egress is blocked at the cluster network policy.

## **3.4 Application Security**

* Input validation: every external boundary uses a schema validator (Zod for TypeScript). No string-typed inputs in handler signatures.

* Output encoding: Next.js auto-escapes by default; raw HTML is forbidden by lint rule (no-dangerously-set-inner-html) without a documented exception.

* CSRF: SameSite=Strict cookies plus per-request CSRF tokens for state-changing operations on cookie-authenticated routes. API tokens (Bearer) are exempt.

* Content Security Policy: strict policy with nonces. Reported violations sent to a dedicated Sentry project.

* SQL injection: parameterised queries everywhere. Object-relational mapping (Prisma or Kysely) makes raw SQL the exception, not the rule. Raw SQL goes through code review with an explicit security tag.

* SSRF: outbound HTTP from services uses a hardened client that blocks RFC 1918 ranges, link-local, and metadata endpoints by default. Allow-list per service.

* Deserialisation: never deserialise untrusted JSON into typed objects without a schema; never deserialise binary formats from untrusted sources.

## **3.5 Data Protection**

* PII minimisation: collect only what is required for the use case. Each table's schema documents the minimisation rationale.

* Pseudonymisation: phone numbers, emails, and government IDs are stored under a deterministic HMAC for indexing, with the plaintext encrypted in a separate column (envelope).

* Field-level encryption: KYC documents stored encrypted in object storage with per-document keys; access requires a short-lived signed URL plus the plaintext key from Vault.

* Data retention: see §11.1.4 for the NDPR-aligned retention schedule.

* Data subject access: NDPR-mandated SAR workflow implemented at launch (export, rectify, delete) — see §11.1.3.

* Logs: PII redaction at the logger layer. No payment data, no full phone numbers, no government IDs. Test fixtures verify redaction.

## **3.6 Threat Model**

A STRIDE-based threat model is maintained in /docs/threat-model.md. The summary register below lists the highest-priority threats the architecture is designed to mitigate. The full register is reviewed quarterly by Security and updated on every architecturally significant change.

| Threat | Category | Primary mitigation |
| :---- | :---- | :---- |
| Account takeover via OTP interception | Spoofing | OTP rate limit per phone; SIM-swap detection on suspicious patterns; device fingerprint \+ risk score on login. |
| Stream-jacking (RTMP key leak) | Spoofing / Tampering | Stream keys rotate per session; ingest validates key \+ JWT; ingest is geographically pinned to Lagos for sellers. |
| Catalog scraping by competitors | Information Disclosure | Cloudflare bot management; per-IP and per-account rate limits; ML-based anomaly detection on listing-fetch patterns. |
| Payment fraud (card testing, BIN attacks) | Tampering | Paystack/Flutterwave Radar-equivalent rules; velocity checks at payment-service; 3DS challenge on risk-scored transactions. |
| Marketplace fraud (fake seller, escrow abuse) | Repudiation | KYC tier; held funds for new sellers (T+7 settlement until trust established); buyer-protection process; dispute queue. |
| Data exfiltration via compromised service | Information Disclosure | Egress allow-listing per service; PII access audit log; anomaly detection on bulk reads. |
| Insider data access | Information Disclosure | Read access to PII gated by ticket reference and recorded in immutable audit log; periodic access reviews. |
| Supply chain (npm dependency compromise) | Tampering | SCA on every PR; lockfile pinning; private registry mirror; signed releases for first-party packages. |
| Live-stream content abuse (CSAM, hate speech) | Repudiation / Compliance | Real-time content moderation pipeline; trust & safety queue; legal hold workflow. |

## **3.7 Vulnerability Management**

* Static Application Security Testing (SAST): Semgrep \+ CodeQL on every PR.

* Software Composition Analysis (SCA): Snyk or OSV-Scanner on every PR. Critical/High block the merge; Medium block the release; Low tracked with SLA.

* Dynamic Application Security Testing (DAST): OWASP ZAP weekly against staging.

* Container scanning: Trivy on every image build. Base images updated weekly.

* Penetration test: external pen test annually; targeted pen test before each major launch.

* Vulnerability disclosure: security.txt published; responsible disclosure programme; triage SLA 5 business days; bug bounty considered post-launch.

## **3.8 Audit Logging**

* Every privileged action (admin login, PII access, payout approval, refund issuance, KYC decision) generates a tamper-evident audit log entry.

* Audit logs are streamed to a write-once, read-many bucket (R2 with object lock) and indexed in a separate OpenSearch cluster with read-only access for the compliance team.

* Audit retention: 7 years minimum (PCI / financial baseline) regardless of the application data retention policy.

# **Part 4 — Data Architecture**

Data architecture is described from the inside out: per-service OLTP, the event backbone, the analytical estate, and the cross-cutting data governance.

## **4.1 Per-service OLTP**

Each microservice owns its database. No service reads another service's tables directly; all cross-service reads go through APIs or events. PostgreSQL 16 is the default. Schema migrations are version-controlled (Atlas or Flyway), gated by CI, and applied by the deploy pipeline before the new service version receives traffic.

Every database has the following posture: pgBouncer in transaction mode for connection pooling; one synchronous replica in Falkenstein for HA, one asynchronous replica in Helsinki for DR; logical replication is preferred over physical to support major-version upgrades; every table has created\_at and updated\_at audit columns plus a soft-delete column where consistent with retention policy.

## **4.2 Event Backbone**

Redpanda (Kafka-compatible) is the asynchronous backbone. The schema registry enforces backwards-compatible evolution. Producers and consumers use the schema registry exclusively; consumer groups are tracked centrally. Topics follow the convention \<bounded-context\>.\<aggregate\>.\<event\>:

| Topic | Purpose |
| :---- | :---- |
| orders.order.created | Emitted by order-service on order placement. Consumed by fulfillment, payment, notification, analytics. |
| orders.order.cancelled | Cancellation event. Triggers refund, fulfillment cancellation. |
| payments.transaction.captured | Successful payment capture. Drives revenue recognition, payout schedule. |
| payments.transaction.failed | Failed payment. Triggers retry, fallback gateway, customer notification. |
| fulfillment.shipment.created / picked-up / delivered / failed | Shipment lifecycle events. |
| fulfillment.box.compartment-loaded / retrieved | Epplaa Box state changes. |
| streams.session.started / ended / heartbeat | Live-stream lifecycle. Drives analytics and the live discovery feed. |
| streams.engagement.viewer-join / message / reaction / purchase-intent | Real-time engagement events. |
| catalog.product.published / updated / removed | Catalog change events. Drives search index updates. |
| users.kyc.submitted / approved / rejected | KYC lifecycle. |
| notifications.send.requested / delivered / failed | Notification dispatch events. |

## **4.3 Analytical Estate**

* ClickHouse is the analytical store. Stream events, viewer behaviour, conversion funnels, fulfillment KPIs, and financial reconciliation flow into ClickHouse via Kafka Connect.

* Metabase fronts ClickHouse for self-service business intelligence. Sensitive datasets gated by row-level filters.

* OLTP-to-analytical replication via Debezium → Kafka → ClickHouse for change data capture.

* Data science / ML uses the same ClickHouse cluster for offline reads; online inference (delivery probability, fraud score) runs in-process or in lightweight serving services. Heavy ML is a Phase 2 concern; the architecture is prepared but not built out at launch.

## **4.4 Search Indexes**

* OpenSearch indexes: products, sellers, streams, locations (Epplaa Boxes, PUDO partners).

* Index updates driven by Kafka events; reindex workflow runs nightly with zero-downtime alias swap.

* Vector search reserved for Phase 2 (semantic product discovery, recommendation embeddings).

## **4.5 Data Governance**

* Every table is annotated with a data classification: public, internal, confidential, restricted (PII / payment).

* Restricted-class tables require a JIRA ticket reference for any read access; access is logged.

* Data dictionary lives in /docs/data-dictionary/ and is generated from the schema migrations plus annotations.

* Synthetic data generator produces shape-preserving non-PII fixtures for staging; production data never leaves production.

# **Part 5 — Application & Service Architecture**

The platform is decomposed into bounded-context microservices. The list is intentionally moderate (≈12 services at launch) to avoid over-decomposition; further splits are an explicit ADR exercise, not a default.

## **5.1 Service Catalogue**

| Service | Responsibility | Database | Key dependencies |
| :---- | :---- | :---- | :---- |
| identity-service | User registration, OTP, OIDC client integration with Keycloak, KYC orchestration, sessions, MFA. | PostgreSQL | Keycloak, Vault, notification-service |
| catalog-service | Product CRUD, manufacturer catalog import, multi-currency pricing, inventory snapshots. | PostgreSQL \+ OpenSearch | manufacturer-service, currency feed |
| manufacturer-service | Manufacturer onboarding (VN/CN/JP/TW), localisation, multi-currency wholesale pricing, payout configuration. | PostgreSQL | identity-service, payment-service |
| stream-service | Live-stream session lifecycle, scheduling, multistream relay configuration, viewer registry. | PostgreSQL \+ ClickHouse | edge ingest tier, Cloudflare Stream |
| cart-service | Cart state, applied promotions, in-stream "buy now" handling. | Redis (primary) \+ PostgreSQL (persisted) | catalog-service, pricing-service |
| order-service | Order placement, lifecycle, cancellation, refunds. | PostgreSQL | cart, payment, fulfillment, notification |
| payment-service | Paystack and Flutterwave integration, multi-party splits, dispute handling, payout orchestration. | PostgreSQL | Paystack API, Flutterwave API, Vault |
| fulfillment-service | Delivery option routing, Epplaa Box inventory, PUDO partner management, 3PL dispatch, address verification, returns. | PostgreSQL \+ Redis (box availability cache) | order-service, Shipbubble API, OkHi API, GIG API, notification-service |
| notification-service | SMS, WhatsApp, push, email. Tracks delivery status. Drives the user notification preferences. | PostgreSQL \+ Redis (queue) | Termii / Africa's Talking, Twilio fallback, FCM, APNs, SES |
| discovery-service | For-You feed, recommendation API, search facade, trending streams. | OpenSearch \+ Redis | catalog, stream, user activity events |
| admin-service | Backoffice for support, dispute resolution, payout approvals, content moderation queue. | PostgreSQL | all services (read), audit log |
| analytics-service | Aggregation jobs, materialised views over ClickHouse, BI feed. | ClickHouse | Kafka, Metabase |

## **5.2 Communication Patterns**

* Default to asynchronous: a state-changing action emits an event; downstream services react. Synchronous calls are reserved for read-paths where the caller needs an authoritative answer (e.g. checkout pricing).

* Synchronous internal calls go over gRPC with mTLS. Synchronous external calls (Paystack, Shipbubble, OkHi) go through a dedicated outbound HTTP client with retry, circuit breaker, and structured timeout policy.

* Sagas (not 2PC) coordinate cross-service transactions. The order-placement saga is the canonical example: cart → order → payment authorise → inventory reserve → fulfillment dispatch → notification.

* Idempotency: every state-changing API requires an Idempotency-Key header (UUID v4) for at-least-once safe retries. Server stores the result for 24 hours.

## **5.3 Public API Surface (high level)**

Full OpenAPI specs live in /apis/openapi/\*.yaml. The most-used surfaces are summarised here:

| Method | Route | Auth | Notes |
| :---- | :---- | :---- | :---- |
| POST | /api/v1/auth/otp/request | public | Phone-based OTP. Rate-limited per phone. |
| POST | /api/v1/auth/otp/verify | public | Returns access \+ refresh tokens. |
| GET | /api/v1/products | public | Listing with filters; OpenSearch-backed. |
| GET | /api/v1/products/:id | public | Single product detail. |
| GET | /api/v1/streams/live | public | Currently live streams. |
| POST | /api/v1/streams | seller | Create a stream session; returns RTMP/WHIP credentials. |
| POST | /api/v1/cart/items | buyer | Add to cart. Idempotent. |
| POST | /api/v1/checkout | buyer | Initiate checkout; returns Paystack/Flutterwave session. |
| GET | /api/v1/fulfillment/options/:orderId | buyer | Available delivery options \+ pricing. |
| GET | /api/v1/fulfillment/boxes | public | Nearby Epplaa Boxes \+ availability. |
| GET | /api/v1/fulfillment/pudo-partners | public | Nearby PUDO partners. |
| POST | /api/v1/fulfillment/verify-address | buyer | OkHi address verification. |
| POST | /api/v1/fulfillment/dispatch | system | Dispatch order to selected channel. |
| GET | /api/v1/fulfillment/track/:shipmentId | buyer | Unified tracking across carriers. |
| POST | /api/v1/fulfillment/boxes/:id/retrieve | buyer | OTP-gated retrieval. |
| POST | /api/v1/fulfillment/returns/initiate | buyer | Start a return at Box or PUDO. |
| POST | /api/v1/payments/webhook/paystack | signed | Paystack webhook ingress. |
| POST | /api/v1/payments/webhook/flutterwave | signed | Flutterwave webhook ingress. |

## **5.4 Frontend Architecture**

The web tier is split by surface. Buyer-facing pages need SSR for SEO, OG card rendering, and ISR-cached product pages — that is Next.js. Operator-facing surfaces (vendor admin, live-stream studio, internal back-office) are SPAs behind authentication where SEO is irrelevant and developer-velocity matters more — those run on Vite. The split is recorded in ADR-009.

### **5.4.1 Buyer-Facing Web (Next.js)**

* Next.js 15 App Router with React Server Components for product, store, and live-stream landing pages. Route segments use streaming SSR \+ Suspense to deliver Largest Contentful Paint within the budget.

* Incremental Static Regeneration (ISR) on product and store pages with on-demand revalidation triggered by the relevant Redpanda topic (product.updated, store.updated, inventory.changed).

* Open Graph and Twitter card metadata generated server-side per route via generateMetadata; live-stream landing pages render rich previews when shared on WhatsApp, Instagram, and X.

* State: Zustand for local UI state; React Query (TanStack Query) for server state. No Redux.

* Internationalisation: next-intl. Default locale en-NG. Locales seeded for future expansion: en-GH, fr-CI, sw-KE.

* Image pipeline: next/image with Cloudflare Images as the loader. AVIF \+ WebP with JPEG fallback.

* Analytics: PostHog (self-hosted) plus an internal analytics SDK that emits to Kafka via the analytics-service ingestion endpoint.

### **5.4.2 Operator & Admin Surfaces (Vite \+ React)**

* Three SPAs share a single Vite \+ React \+ TypeScript monorepo workspace: admin.epplaa.com (back-office), studio.epplaa.com (live-stream operator console), partner.epplaa.com (3PL and manufacturer self-service).

* Stack: Vite 5.x dev server, React 19, TanStack Router for type-safe routing, TanStack Query for server state, shadcn/ui components, Tailwind CSS.

* Auth: same OIDC provider as the buyer site; SPAs receive short-lived JWTs and refresh via silent renew.

* No SSR is needed on these surfaces — they are gated behind authentication and never indexed. Vite's sub-second HMR materially improves operator-tooling iteration speed.

* Build artifacts deploy as static assets to Cloudflare Pages; API calls route to the same gateway as Next.js consumers.

## **5.5 Mobile Architecture**

The mobile app is the primary buyer surface in Nigeria — most live-shopping sessions are watched on phones over mobile data, often on mid-range Android devices (Tecno, Infinix, Samsung A-series) running constrained networks. The architecture is tuned for that reality: a single Flutter codebase, predictable rendering performance via Impeller, and aggressive offline tolerance.

### **5.5.1 Codebase & Targets**

* Flutter (stable channel), Dart 3.x. Single monorepo at apps/mobile. Single codebase compiled to native ARM for iOS and Android — no platform-specific forks.

* Targets iOS 16+ and Android 8+ (API 26+). Coverage of active devices in the launch markets is \>95% by NCC and StatCounter device-share data; the long tail of older devices falls back to the mobile web experience.

* App size budget: \<30 MB initial download (iOS IPA, Android AAB base split). Heavy assets (Lottie animations, fonts beyond Latin \+ Nigerian-language character sets) lazy-load from CDN on first use.

* Min RAM target: 2 GB. Memory budget for normal use \< 200 MB; live-stream playback \< 350 MB.

### **5.5.2 Application Layer**

* State management: Riverpod 2.x. Compile-time dependency injection, reactive providers, clean separation between UI and business logic, well-suited to AsyncValue patterns for long-running operations like checkout and stream connection.

* Navigation: go\_router. Declarative routes with auth guards; deep-link friendly for product, store, and live-stream URLs (Universal Links on iOS, App Links on Android).

* Networking: dio HTTP client with interceptors for JWT refresh, exponential-backoff retry on idempotent reads, request logging in debug builds, and OpenTelemetry trace propagation.

* API contract: OpenAPI 3.1 spec is the single source of truth. Dart models and TypeScript types are generated from the same spec via build\_runner \+ json\_serializable (Dart) and openapi-typescript (TS), eliminating contract drift between the mobile app, web app, and services.

* Real-time: socket\_io\_client for live-stream chat WebSocket connections. Auto-reconnect with exponential backoff, offline-message queue with replay on reconnect.

* Local persistence: drift (typed SQLite) for cart, product cache, draft messages, notification queue, and in-flight order state. All local DB access goes through repository classes that mediate between local and remote sources.

### **5.5.3 Media & Streaming**

* Video playback: video\_player \+ chewie for HLS / LL-HLS streams. Platform channels bridge to ExoPlayer (Android) and AVPlayer (iOS) for low-level tuning (buffer sizes, ABR ladders, hardware-decoder selection).

* WebRTC capture and ingest: flutter\_webrtc for seller go-live. Camera and microphone capture is encoded and pushed to the Lagos edge SFU; the SFU re-publishes to RTMP ingest for HLS distribution. See §6.3.

* Composited overlay layer (chat bubbles, reaction emojis, "Buy now" cards, viewer-count animations) renders on the Flutter Impeller layer above the video texture. Impeller pre-compiled shaders keep this composition at 60 fps on mid-range Android and 120 fps on flagship devices — the property test gate is "no dropped frames during a 30-second live overlay sequence on a Tecno Spark 10."

### **5.5.4 Push, Auth & Bridges**

* Push notifications: Firebase Cloud Messaging (FCM) for both platforms. flutter\_local\_notifications for in-app and scheduled local alerts.

* Deep linking: Universal Links (iOS) and App Links (Android) configured via .well-known/apple-app-site-association and assetlinks.json published from the Next.js public site. DNS managed at Cloudflare.

* Payment SDK: Paystack mobile SDK as primary; Flutterwave SDK as fallback. Native bridge via platform channels — the app never sees raw PAN; all card capture happens in the gateway-hosted UI to preserve PCI SAQ-A scope.

* Crash reporting: Sentry Flutter with release-tagged source maps. Performance profiling: Firebase Performance plus custom OTel spans for the critical buyer journeys (browse → live → purchase).

* Distribution: Firebase App Distribution for internal and beta builds. App Store Connect (iOS) and Google Play Console (Android) for production. Internal track on Play for staff dogfooding.

* OTA updates: Shorebird (code-push for Flutter) for Dart-only changes; full store submission for any binary or native-code change. Roll-out gates align with the release process in §10.5.

# **Part 6 — Live Streaming Architecture**

Live streaming is the platform's differentiator. Earlier versions of this document referenced "social media streaming" and "multistream relay" without specifying the underlying stack. v4.0 commits to a concrete, latency-budgeted architecture and explains why each piece is the right choice for a Nigeria-first launch.

## **6.1 Latency Budget**

The platform supports two playback modes with distinct latency budgets. The mode is selected per stream by the seller.

| Mode | Glass-to-glass latency | Concurrent viewers per stream | Use case |
| :---- | :---- | :---- | :---- |
| Standard (HLS) | 8–15 s | Up to 50,000+ | Default. Storefront streams, product showcases, large-audience drops. |
| Low-latency (LL-HLS) | 2–4 s | Up to 10,000 | Auction-style drops, time-sensitive offers, interactive Q\&A. |
| Interactive (WebRTC SFU) | \< 500 ms | Up to 500 (co-host); ≤ 100 in audio cohosts | Co-host video, dial-in guests, pull-up reactions. |
| **Why this matters** TikTok Shop and Taobao Live operate on streams that feel "instant." A 30-second HLS-classic latency loses the live moment — a discount called out at second :05 is gone before the viewer sees it. The Lagos edge ingest tier is what makes single-digit latency achievable for Nigerian sellers and Nigerian viewers. |  |  |  |

## **6.2 End-to-End Pipeline**

A seller in Lagos broadcasting to a viewer in Ibadan flows as follows:

* Seller mobile app encodes H.264 \+ AAC, packetises as RTMP (Standard / LL) or WHIP (WebRTC ingest for Interactive).

* Stream ingress lands on the Lagos edge ingest tier (Section 2.3). The ingest server validates the stream key \+ JWT, records the start event, and forwards the elementary streams to the transcoder.

* Transcoder (ffmpeg \+ GPU) produces an ABR ladder: 240p/360p/480p/720p/1080p variants in HLS for Standard mode, LL-HLS for Low-latency mode. Audio at 64/128 kbps. Per-segment encryption (AES-128 sample) for premium content.

* HLS variants are pushed to Cloudflare Stream (origin push). Cloudflare Stream handles distribution to the global edge with Lagos, Johannesburg, and Cape Town PoPs serving African viewers.

* Viewer mobile or web players fetch from Cloudflare. Player measures buffer health, downshifts on congestion, and reports QoS metrics back to analytics-service.

* Interactive paths (co-host, dial-in) bypass HLS and use a mediasoup-based SFU running on the Lagos edge tier.

## **6.3 Multistream Relay**

Sellers can broadcast simultaneously to TikTok Live, Instagram Live, and Facebook Live in addition to the Epplaa native stream. The relay runs at the Lagos edge: from the transcoder, an RTMP republish module pushes a separate H.264/AAC stream per destination using each platform's RTMP ingest URL and stream key. Stream keys are obtained per-platform via the seller's OAuth-linked account, stored encrypted in Vault, and rotated automatically before expiry. The relay status (active, degraded, failed) is observable per platform in the seller dashboard, and a failed relay never affects the native stream.

## **6.4 Stream-Adjacent Features**

* In-stream chat: Socket.IO with Redis adapter for fanout. Per-stream chat partitioned to one Socket.IO node; users sticky-routed by hash. Moderation hooks reject messages matching the live abuse classifier before broadcast.

* Live reactions (hearts, fire, claps): emitted via Socket.IO with rate limiting per viewer; aggregated server-side and rendered client-side at 30 fps.

* In-stream commerce: a dedicated "buy" event posts to cart-service with stream-context, applies the stream-only price (if any), and triggers an inline Paystack payment sheet on the viewer's device. The seller sees a real-time purchase ticker; viewers see anonymised purchase notifications ("Someone in Lagos just bought").

* Stream recording: every stream is recorded, transcoded into a VOD asset, and indexed for replay. Recordings are stored in R2 with a 90-day lifecycle (extendable per seller plan).

## **6.5 Content Safety**

* Real-time moderation pipeline: every 5-second video segment plus the chat stream is run through a content classifier (Hive Moderation or AWS Rekognition Stream Processor for v1; in-house classifier in Phase 2).

* Policy violations (nudity, weapons, hate symbols, CSAM) trigger an immediate stream pause \+ automatic Trust & Safety queue ticket.

* CSAM detection: PhotoDNA \+ NCMEC reporting integration. Automatic stream termination \+ law-enforcement reporting workflow.

* Seller takedown SLA: reactive (reported) violations triaged within 1 hour during business hours, 4 hours overnight.

## **6.6 Stream Observability**

* Per-stream KPIs: ingest bitrate, dropped frames, transcoder latency, manifest delivery time, viewer-side rebuffer ratio, time-to-first-frame, exit reasons.

* Stream telemetry flows to ClickHouse for the seller dashboard and aggregate platform health metrics.

* Synthetic monitors run every 5 minutes from Lagos, Abuja, and Port Harcourt Cloudflare PoPs to verify end-to-end playback.

# **Part 7 — Fulfillment & Logistics Architecture (Nigeria)**

Order fulfillment is the single biggest challenge for e-commerce in Nigeria. Poor road networks, non-existent street addressing in many areas, high delivery costs inflated by up to 30% due to urban congestion, and low buyer trust in doorstep delivery create a fulfillment environment fundamentally different from mature markets. Epplaa's fulfillment strategy addresses this head-on with a hybrid model that gives buyers maximum flexibility while keeping costs sustainable for the platform. The technical implementation is in Section 5.1 (fulfillment-service); this section describes the operating model.

## **7.1 The Fulfillment Problem**

* No formal street addressing: most areas outside major commercial districts lack standardised street addresses. Delivery riders navigate by landmarks, leading to failed deliveries.

* High failed-delivery rates: cash-on-delivery refusals, unreachable recipients, and wrong locations mean the merchant pays for logistics twice for zero revenue. Industry baseline: 15–25% failed delivery rate.

* Cost: last-mile delivery represents up to 28% of product cost in Nigeria. Urban congestion in Lagos, Abuja, and Port Harcourt inflates per-delivery costs.

* Trust deficit: many buyers distrust doorstep delivery, fearing theft, substitution, or substandard products. Strong preference for inspect-before-pay models.

* Coverage gaps: approximately 47% of Nigeria's population lives in rural areas with minimal logistics coverage. Even Tier 2 cities have limited delivery infrastructure.

## **7.2 Hybrid Fulfillment Model**

Three-tier approach: Epplaa Boxes (concierge smart lockers), partnered PUDO (Pick Up / Drop Off) agent network, and optional home delivery. Inspired by Jumia's JForce network of 40,000+ local pickup agents (which reduced their fulfillment cost per order by 12% YoY) and Pargo's 4,000+ smart pickup points across South Africa and Egypt.

### **7.2.1 Tier 1 — Epplaa Boxes (Smart Concierge Lockers)**

Solar-powered smart locker stations placed in high-traffic locations. Each unit contains 20–40 individually locked compartments of varying sizes (small for phones / accessories, medium for clothing, large for electronics / appliances).

* Order placed: buyer selects "Epplaa Box" as delivery option at checkout and chooses their preferred location.

* Package delivered: 3PL partner delivers to the Epplaa Box station. Station attendant or automated system places it in an available compartment.

* Buyer notified: SMS \+ WhatsApp message with a 6-digit OTP and the compartment number.

* Buyer retrieves: visits at their convenience (6am–10pm at attended locations, 24/7 at automated locations), enters OTP on the keypad or scans a QR code, retrieves their package.

* Verification window: 24 hours to inspect at the station. Mismatch → return at the box (place item back, tap "Return" in app).

#### **Strategic placement**

| Location Type | Why It Works | Target Density | Example Partners |
| :---- | :---- | :---- | :---- |
| Supermarkets | High daily foot traffic; trusted environment; existing security; air conditioning protects goods. | 2–3 per major city | Shoprite, SPAR, Market Square |
| Petrol / Filling Stations | Open long hours (often 24/7); nationwide coverage including Tier 2/3 cities; existing power; high road visibility. | 5–10 per major city; 1–2 per Tier 2 city | NNPC, TotalEnergies, MRS, Enyo, Eterna |
| Shopping Malls | Destination shopping; secure premises; parking for large items. | 1–2 per major mall | Ikeja City Mall, Palms, Jabi Lake |
| University Campuses | Concentrated young demographic; predictable foot traffic; strong social commerce adoption. | 1 per major university | UNILAG, UI, UNIBEN, ABU Zaria |
| Transport Hubs | Bus terminals and motor parks where people naturally wait; serves inter-city travellers. | 1–2 per major hub | Jibowu, Utako Park |
| GIG Logistics centres | 150+ existing logistics hubs; existing relationship with the e-commerce ecosystem. | Co-locate at all GIGL centres | GIG Logistics experience centres |

#### **Epplaa Box economics (estimated)**

| Item | Cost (estimated) | Notes |
| :---- | :---- | :---- |
| Solar-powered locker (30 compartments) | USD 3,000–5,000 | Modular; sourced from China / Taiwan manufacturer partner. Solar \+ battery for off-grid operation. |
| Monthly location rental | NGN 50,000–150,000 | Revenue-share model preferred: location partner gets 5–10% of per-pickup fee. |
| Per-pickup fee (charged to buyer) | NGN 500–1,000 | Significantly cheaper than home delivery (NGN 1,500–3,500). Presented as "Free pickup" for orders \> NGN 15,000. |
| Station attendant | NGN 80,000–120,000 / month | Part-time at attended locations. Not needed at 24/7 automated units. |
| Breakeven | \~80 pickups / month | At NGN 750 average fee. Target 150–300 pickups / month at busy locations. |

Phase 1 (Sprint 5 — launch): 20 Epplaa Boxes across Lagos (10), Abuja (5), Port Harcourt (3), Ibadan (2). Phase 2 (Month 6): 50 units adding Kano, Benin, Enugu, Kaduna. Phase 3 (Month 12): 150 units with 24/7 automated units at petrol stations.

### **7.2.2 Tier 2 — PUDO Agent Network**

For areas without Epplaa Boxes the platform operates a PUDO agent network modelled on Jumia's JForce. Epplaa Partners are existing small businesses (phone repair shops, POS agent kiosks, pharmacy counters, barber shops) that hold packages for buyers in their area. This extends coverage to neighbourhoods and Tier 2/3 cities without the capex of locker hardware.

* Partner onboarding: business owner registers via the Epplaa Seller / Partner app. Epplaa verifies the location, provides branded shelf / lockbox and signage, and registers the location on the map.

* Commission: NGN 200–400 per package held and collected. Volume bonuses (10+ packages / day).

* Buyer experience: same as Epplaa Box — selects location at checkout, receives OTP via SMS / WhatsApp, shows OTP, collects package.

* Density target: 5–10 partners per LGA in major cities at launch; scale to 2,000+ partners within 12 months.

* Verification: partner app tracks receipt, storage duration, handoff. Reliability score drives incentive / penalty.

### **7.2.3 Tier 3 — Home Delivery (Premium)**

Premium option for buyers willing to pay for doorstep convenience. Epplaa does not build its own delivery fleet. Instead it integrates with established Nigerian 3PL providers through a logistics aggregator:

| 3PL Partner | Coverage | Capability | Integration |
| :---- | :---- | :---- | :---- |
| GIG Logistics (GIGL) | 150+ centres across Nigeria \+ USA, UK, China, Ghana offices. | Interstate express (24–48h); last-mile; international import. | API via GIGGo platform. |
| Shipbubble (aggregator) | Aggregates SpeedAF, DHL, Sendstack, GIG, UPS, Topship. | Multi-carrier rate comparison; real-time tracking; automated dispatch. | REST API — primary logistics orchestration layer. |
| Kobo360 | Nationwide haulage \+ last-mile. | Bulk freight for manufacturer shipments to warehouse; route intelligence SaaS. | API for manufacturer bulk inbound. |
| Loop / Faramove | Lagos, Abuja, PH; expanding. | Data-driven delivery probability scoring; real-time optimisation. | API for high-density city delivery. |

Home delivery pricing: NGN 1,500–3,500 depending on city and distance. Delivery probability scoring via Shipbubble flags high-risk addresses and nudges buyers toward Epplaa Box / PUDO options.

## **7.3 Address Verification (OkHi)**

Addressing is solved by integrating OkHi, an AI-powered address verification service built for markets without formal street addressing. At checkout, buyers selecting home delivery verify their location via GPS pin drop in the Epplaa app. OkHi's API returns a verified, deliverable address with confidence scoring. Low-confidence addresses are flagged and the buyer is offered a nearby Epplaa Box or PUDO instead. Target: failed-delivery rate under 5% (vs. 15–25% industry baseline).

## **7.4 Cross-Border Supply Chain (Asia → Nigeria)**

Products from Vietnam, China, Japan, and Taiwan reach Nigerian buyers through a structured import pipeline:

* Manufacturer → consolidation warehouse: each origin country has a consolidation point (Shenzhen, Ho Chi Minh, Yokohama, Taipei).

* Consolidated sea freight to Lagos: palletised containers via ocean freight to Apapa or Tin Can Island. 25–45 days transit. Pre-clearance documentation handled by a licensed customs broker.

* Air freight (high-value / urgent): 4–7 days to MMIA Lagos. Higher cost but enables "fast ship" option for premium sellers.

* Bonded warehouse (Lagos): Lekki Free Trade Zone or Apapa. Import duties, VAT, and customs clearance handled centrally by Epplaa's logistics partner.

* Regional distribution hubs: secondary warehouses in Abuja and Port Harcourt receive stock from Lagos to reduce last-mile distances outside the southwest.

* Last mile: from regional hub to Epplaa Box, PUDO partner, or home delivery via 3PL.

For dropship orders the manufacturer ships to the Lagos bonded warehouse; Epplaa handles the domestic leg. No international parcel ships directly to a buyer's home — this eliminates per-parcel customs delays and provides a consistent domestic delivery experience.

## **7.5 Fulfillment Database Schema**

| Table | Key Fields | Sprint |
| :---- | :---- | :---- |
| epplaa\_boxes | id, location\_name, address, lat, lng, type (attended/automated), total\_compartments, available\_compartments, partner\_id, status, opening\_hours | Sprint 5 |
| box\_compartments | id, box\_id, size (S/M/L), status (empty/occupied/reserved), current\_order\_id, otp\_hash, loaded\_at, expires\_at | Sprint 5 |
| pudo\_partners | id, user\_id, business\_name, address, lat, lng, operating\_hours, capacity, reliability\_score, status | Sprint 5 |
| delivery\_options | id, order\_id, option\_type (box/pudo/home), location\_id, estimated\_delivery, cost, status | Sprint 5 |
| shipments | id, order\_id, carrier, tracking\_number, status, estimated\_delivery, actual\_delivery, attempts | Sprint 5 |
| address\_verifications | id, user\_id, okhi\_location\_id, lat, lng, confidence\_score, verified\_at | Sprint 5 |
| import\_shipments | id, manufacturer\_id, origin\_country, freight\_type (sea/air), container\_id, customs\_status, warehouse\_arrival, duties\_paid | Sprint 8 |

Note that otp\_hash (not raw otp) is stored — see §3.4 input handling.

# **Part 8 — Payment Infrastructure (Nigeria)**

The original v1.0 / v2.0 architecture specified Stripe Connect for payments. For a Nigeria-first launch this has been replaced with a dual-gateway strategy using Paystack (primary) and Flutterwave (backup), both CBN-licensed and optimised for the Nigerian market. PCI DSS scope is reduced to SAQ-A (eligible hosted-payment-page model) by tokenising at the gateway and never touching raw PAN — see §11.3.

## **8.1 Why Not Stripe**

While Stripe acquired Paystack in 2020, Stripe's own gateway is not the primary choice for Nigerian merchants. Paystack's checkout is specifically optimised for Nigerian payment methods (Verve cards, bank transfers, USSD, QR codes) and has direct relationships with Nigerian banks. Paystack commands an estimated 60%+ market share among Nigerian online merchants. Using Paystack directly provides better transaction success rates with Nigerian banks, next-day settlement in Naira, and familiarity for Nigerian buyers.

## **8.2 Dual Gateway Strategy**

| Feature | Paystack (primary) | Flutterwave (backup) |
| :---- | :---- | :---- |
| Local transaction fee | 1.5% \+ NGN 100 (waived under NGN 2,500) | 1.4% per transaction |
| International fee | 3.9% | 3.8% |
| Settlement | Next business day | Next business day |
| Payment methods | Cards (Visa, Mastercard, Verve), bank transfer, USSD, QR code | Cards, bank transfer, USSD, mobile money (MTN, Airtel) |
| African coverage | Nigeria, Ghana, South Africa, Kenya, Rwanda, Côte d'Ivoire | 14+ African countries |
| Split payments | Paystack Transfer Split | Flutterwave SubAccounts |
| Recurring billing | Comprehensive | Basic |
| Why included | Best Nigerian checkout UX; highest local-bank success rates; Stripe-backed | Lower fees; broader African coverage for future expansion; failover redundancy |

Both gateways are integrated simultaneously. When Paystack experiences elevated failure rates the payment-service shifts new transactions to Flutterwave, and vice versa. The decision is data-driven (rolling 5-minute success rate; circuit breaker pattern) rather than manual. This is critical in Nigeria where both platforms experience occasional outages during peak periods.

## **8.3 Payment Methods Supported**

* Card payments: Visa, Mastercard, Verve (Nigeria's domestic card scheme; processed fastest through Interswitch but supported by both gateways).

* Bank transfer: direct bank debit via Paystack. Popular for high-value transactions where buyers prefer not to use cards.

* USSD: Unstructured Supplementary Service Data. Allows payments via feature phones without internet (\*737\# GTBank, \*901\# Access, etc.). Critical for reaching buyers without smartphones or data.

* Mobile money: MTN MoMo, Airtel Money via Flutterwave. Growing rapidly as CBN pushes financial inclusion.

* Pay on Delivery (PoD): supported ONLY at Epplaa Box and PUDO partner locations (not home delivery). Buyer pays upon collection. This eliminates the primary PoD problem (failed deliveries where rider has already travelled) because the package is already at the pickup point.

* Buy Now, Pay Later: future integration with Nigerian BNPL providers. Market expected to surpass USD 1.78B in 2026\.

## **8.4 Payment Splits for Marketplace**

Every transaction involves a multi-party payment split:

* Seller share: product price minus platform commission (10–15% depending on tier).

* Platform commission: 10–15% of product price, retained by Epplaa.

* Manufacturer share: for manufacturer-sourced products the wholesale price is forwarded to the manufacturer's account (settled in USD / originating currency via Flutterwave's multi-currency payout).

* Fulfillment fee: charged to buyer (or absorbed into the product price for "free delivery" promotions).

Paystack Transfer Split handles the seller / platform split automatically per transaction. Manufacturer payouts are batched weekly via Flutterwave's international transfer (USD, CNY payouts to Asia).

## **8.5 Webhooks, Idempotency, and Reconciliation**

* Both gateways post transaction events to /api/v1/payments/webhook/{paystack|flutterwave}. Each request is verified by HMAC signature; replay-protected; idempotent at the receipt-id level.

* Outcome of each webhook is published as a payments.transaction.\* event for downstream consumers. The webhook handler is a thin verifier-and-publisher; business logic happens in the consumer.

* Daily reconciliation job pulls the gateway settlement file and matches it against payment-service ledger entries. Discrepancies flagged for finance review within 24 hours.

## **8.6 Settlement, Payouts, and Holds**

* Seller settlement schedule: T+1 for trusted sellers; T+7 for new sellers (first 30 days or first 50 orders). Held funds protect against fraud and disputes.

* Manufacturer payout: weekly batch via Flutterwave international transfer. Payout currency configurable per manufacturer (USD default).

* Refunds: initiated via admin-service or buyer self-service for eligible cases. Refund issued via the original gateway; tokenised card details enable card-original refunds without re-collecting card data.

* Chargebacks: handled via the gateway's dispute API; tracked in payment-service. Sellers receive evidence-submission window of 7 days; platform decides representment.

## **8.7 Updated Tech Stack Row (consolidated)**

| Layer | Technology | Rationale |
| :---- | :---- | :---- |
| Payments | Paystack (primary) \+ Flutterwave (backup) | Dual-gateway for redundancy. Paystack: best Nigerian checkout UX, 60%+ local market share, Stripe-backed. Flutterwave: lower fees, 14+ African countries, multi-currency for manufacturer payouts. Both CBN-licensed, next-day Naira settlement. PCI scope: SAQ-A. |

# **Part 9 — Observability, Reliability & Operations**

Observability and reliability are first-class concerns, not after-thoughts. This section establishes the SLO framework, the observability stack, the on-call structure, and the incident-management protocol. It is the contract between Engineering, SRE, and the business.

## **9.1 SLO Framework**

Every user-facing service has a Service Level Objective expressed as a target percentage of "good events" over a 28-day rolling window. The error budget is 1 minus the SLO. When the error budget is consumed faster than expected, feature work pauses on that service until the budget recovers (the burn-rate alert is the trigger).

| Service / Surface | SLI | SLO (28-day) | Error budget policy |
| :---- | :---- | :---- | :---- |
| Public API (P95 latency) | P95 \< 400 ms over a 5-minute window for /api/v1/products and /api/v1/streams/live | 99.0% | 50%-burn over 6 hours pages SRE; 100%-burn over 1 hour pages on-call. |
| Public API (availability) | 2xx \+ 3xx rate (excluding 4xx) | 99.9% | As above. 99.95% target Q4 2026\. |
| Checkout success | Successful checkout / attempted checkout | 99.5% | Sub-target halts checkout-related releases. |
| Payment authorisation | Authorised / attempted (excluding bank declines) | 99.0% Paystack OR fail over to Flutterwave | Triggers gateway switch; runbook-driven. |
| Stream ingest | Ingest connection success rate | 99.5% | Drives Lagos edge tier capacity planning. |
| Stream playback | Playback start within 3s | 99.0% | Drives CDN strategy review. |
| Fulfillment dispatch | Order dispatched within 15 min of payment | 99.0% | Drives 3PL integration health review. |
| Notification delivery | SMS / WhatsApp delivered within 30s | 98.0% | Below target → switch provider via runbook. |

## **9.2 Observability Stack**

* Metrics: every service exposes /metrics in Prometheus format. Cluster Prometheus scrapes per-service. Long-term storage in Thanos with 1-year retention.

* Logs: structured JSON only. Promtail ships to Loki. 30 days hot in Loki; 1 year cold in R2 (Parquet).

* Traces: OpenTelemetry SDK in every service. W3C trace context propagated end-to-end including across Kafka. Tempo stores traces (7 days hot, sampled 100% on errors and 5% otherwise).

* Errors: Sentry self-hosted. Each release tagged. Alert routing per project to the owning team.

* Dashboards: Grafana, sourced from Prometheus, Loki, and Tempo. Dashboards version-controlled in Git (Grafonnet); reviewed in PRs like code.

* Synthetic monitoring: 5-minute checks from Lagos, Abuja, Port Harcourt, Johannesburg, and London PoPs. Failure pages on-call.

* Real User Monitoring (RUM): web and mobile clients report Core Web Vitals plus custom events to PostHog and the analytics-service.

## **9.3 On-Call**

| Aspect | Standard |
| :---- | :---- |
| Rotation | Per-team primary \+ secondary on a 7-day rotation. Follow-the-sun considered post-launch (initially Nigeria \+ UK time zones). |
| Tooling | PagerDuty (or Better Stack as cost-effective alternative). Phone \+ push \+ Slack escalation. |
| Severity definitions | SEV-1 customer-facing outage; SEV-2 partial degradation or single-feature outage; SEV-3 internal degradation; SEV-4 minor. |
| Page latency | SEV-1 page within 1 minute of detection; SEV-2 within 5 minutes; SEV-3 next business hour. |
| Acknowledge / Engage | SEV-1 ack within 5 minutes, engage within 15\. SEV-2 ack within 15, engage within 30\. |
| Comms | Status page updated within 10 minutes of SEV-1 acknowledgment. Customer comms drafted by support; technical updates by SRE. |
| Post-incident review | Blameless PIR within 5 business days for SEV-1/2. Action items tracked to closure with owner \+ due date. |
| Compensation | On-call shifts compensated per company policy. Page count and load tracked; sustained high load triggers staffing review. |

## **9.4 Runbooks**

* Every alert routes to a runbook URL in the alert annotation.

* Runbook standard: trigger, immediate triage, common causes, remediation steps, escalation, post-incident actions.

* Runbooks are version-controlled (deploy/runbooks/\*) and reviewed quarterly.

* Drill schedule: chaos game days quarterly; DR drill quarterly; tabletop exercises (security incident, regulatory inquiry) twice a year.

## **9.5 Capacity Planning**

* Every service has a documented capacity model (RPS per CPU, memory per concurrent connection, IOPS profile).

* Headroom target: 50% headroom on CPU and memory at peak; 40% on database connections; 60% on Kafka partition throughput.

* Quarterly capacity review: SRE reviews trends and forecasts the next quarter's scaling requirements. Pre-emptive scaling actions tracked as engineering work.

## **9.6 Cost Observability**

* Per-service cost allocation via tagged Hetzner resources and tagged Cloudflare zones.

* Monthly cost review meeting includes engineering and finance. Variance \> 20% triggers an investigation.

* Cost anomalies (sudden CPU spikes, egress spikes) page Platform on-call.

# **Part 10 — Quality Engineering**

Quality is owned by every team, supported by tooling. The pipeline is the gate; nothing reaches production that has not passed it.

## **10.1 Testing Pyramid**

| Layer | Owner | Standard |
| :---- | :---- | :---- |
| Unit tests | Service team | Co-located with code. Fast (\< 5 minutes per service). 80% line coverage on changed files; 70% service-level minimum. Vitest (TS) and pytest (where Python is used). |
| Integration tests | Service team | Per-service. Run against test containers (Postgres, Redis, Kafka). Verifies the service's contract with its own data tier. |
| Contract tests | Service team \+ consumer | Pact or Consumer-Driven Contracts. Each consumer publishes its expected contract; provider verifies on every PR. |
| End-to-end tests | QA / SDET | Playwright for web; Maestro for Flutter. Smoke pack runs on every PR (15 minutes); full pack runs nightly against staging. |
| Load tests | SRE \+ Service team | k6 scripts in repo. Run weekly against staging; full burst test before each major release. |
| Chaos tests | SRE | Litmus or Chaos Mesh. Game-day exercises monthly; integrated chaos in the pipeline experimentally. |
| Security tests | Security | See §3.7. SAST \+ SCA on every PR; DAST weekly. |

## **10.2 CI/CD Pipeline**

GitHub Actions executes the pipeline. Every PR runs:

* Lint (ESLint flat config), format check (Prettier), type-check (tsc \--noEmit).

* Unit \+ integration tests with coverage report.

* SAST (Semgrep \+ CodeQL) and SCA (Snyk / OSV-Scanner). Critical / High block the merge.

* Container build with Trivy scan.

* Smoke E2E against an ephemeral preview environment (Tilt \+ Vercel preview for the web).

* Contract tests against the latest published contracts.

On merge to main, the pipeline:

* Tags the build with the SHA \+ semver-pre.

* Pushes the image to the private registry.

* Updates the deploy manifest in the GitOps repo via PR; Argo CD reconciles staging within 5 minutes.

* Promotion to production is a manual approval on the Argo CD CR (two approvers required for production manifests).

## **10.3 Release Process**

* Continuous deployment to staging on every merge.

* Production deploys are progressive: 5% canary → 25% → 50% → 100%. Each step gated on SLO health (no error budget burn over the step duration).

* Feature flags via Unleash (self-hosted) gate user-facing changes; flags removed within 30 days of full rollout.

* Rollback is one-command (Argo CD rollback) and exercised at least monthly to keep the muscle.

## **10.4 Performance Budget**

* Web LCP \< 2.5 s (P75) on 4G; CLS \< 0.1; INP \< 200 ms.

* Mobile cold-start \< 2.0 s on a mid-tier Android device.

* API P95 latency targets in §9.1.

* Payload budgets: home page \< 200 KB compressed; product detail \< 350 KB; live stream player \< 500 KB initial.

## **10.5 Test Data & Environments**

* Production data never leaves production.

* Staging is seeded with synthetic shape-preserving fixtures.

* PII fakers used for any user data: faker.js for names, libphonenumber for valid Nigerian phones, random pin within Nigeria for GPS.

# **Part 11 — Compliance & Regulatory**

Operating an e-commerce and payments platform in Nigeria triggers obligations under several statutes and regulations. This section is the live map of those obligations to specific architectural and operational controls. It is reviewed quarterly by the Data Protection Officer (DPO) and Compliance.

## **11.1 NDPR (Nigeria Data Protection Regulation)**

The Nigeria Data Protection Act 2023 and the NDPR (issued by NITDA, now under the Nigeria Data Protection Commission — NDPC) govern processing of personal data of Nigerian data subjects. Epplaa is a data controller for buyer, seller, and partner PII. The platform processes a high volume of sensitive personal data and is therefore in the highest tier of NDPC oversight.

### **11.1.1 Designations and registrations**

* A Data Protection Officer (DPO) is designated. The DPO has direct reporting to the CEO and a documented mandate.

* Epplaa is registered with the NDPC and files the annual compliance audit (Data Protection Compliance Organisation — DPCO — engaged for the first audit cycle).

### **11.1.2 Lawful basis & consent**

* Lawful basis recorded per processing purpose (contract, legitimate interest, consent). Consent collected via granular opt-ins; never bundled.

* Marketing consent is separately collected; users can withdraw at any time via the account settings.

* Cross-border data transfer (e.g., manufacturer KYC documents stored in Hetzner Falkenstein) supported by adequacy assessment; GDPR-equivalent controls in place; specific manufacturer consent recorded.

### **11.1.3 Data subject rights**

All NDPR rights are implemented at launch:

* Right to access — self-service export (JSON \+ PDF) within 30 days of request.

* Right to rectification — self-service for fields where automation is safe; ticketed for high-risk fields (legal name, KYC).

* Right to erasure — self-service account deletion. Cascade-delete plus retention overrides for legal/financial records (kept under §11.1.4).

* Right to restrict and object — ticketed; SLA 30 days.

* Right to portability — same export pipeline as access; machine-readable formats.

* All rights requests logged; outcomes auditable.

### **11.1.4 Retention schedule**

| Data class | Retention | Rationale |
| :---- | :---- | :---- |
| Account credentials and metadata | Until account deletion \+ 30 days | Operational; deletion grace period. |
| Order records | 7 years from last order | Financial / tax obligations under FIRS rules. |
| Payment records (tokenised) | 7 years | CBN, financial audit. |
| KYC documents | Active \+ 7 years post-closure | CBN, AML obligations. |
| Live-stream recordings | 90 days default; longer per seller plan | Operational; T\&S investigation window. |
| Server logs (with PII) | 30 days hot | Operational; investigation. PII redacted at logger. |
| Audit logs | 7 years (immutable) | PCI / financial baseline. |
| Anonymised analytics | Indefinite | Aggregated / non-identifiable. |

## **11.2 KYC and Anti–Money Laundering (AML)**

* Buyer: light-touch KYC (phone \+ email \+ optional government ID for high-value purchases).

* Seller: tiered KYC. Tier 1 (≤ NGN 500,000 / month transaction): phone \+ email \+ address. Tier 2 (≤ NGN 5M / month): \+ government ID \+ bank account verification. Tier 3 (\> NGN 5M / month): \+ business registration (CAC), proof of address, ultimate beneficial owner declaration.

* Manufacturer: business registration in country of origin; export licence; UBO declaration.

* Sanctions screening on every onboarded entity (OFAC, UN, EU, Nigeria sanctions list) at onboarding and quarterly thereafter.

* Suspicious Transaction Reports (STR) filed with the NFIU per CBN guidelines.

## **11.3 PCI DSS**

* Scope: SAQ-A. Epplaa never receives, transmits, or stores raw cardholder data. All card capture happens on Paystack/Flutterwave hosted pages or their tokenised SDKs.

* Annual self-assessment plus quarterly external ASV scans on the public surface.

* Network segmentation enforced even for SAQ-A: payment-service runs in a dedicated namespace with strict egress and audit logging.

* Cardholder data flow diagram maintained in /docs/compliance/pci-cdf.md.

## **11.4 CBN Payment System Provider Guidelines**

* Epplaa is not licensed as a PSP. Payments are processed by licensed PSPs (Paystack, Flutterwave). Epplaa's responsibility is to comply with the merchant-of-record requirements imposed by the gateway and CBN.

* Settlement to Naira accounts at CBN-licensed banks only.

* Foreign manufacturer payouts comply with CBN FX guidelines; Flutterwave handles the regulated FX leg.

## **11.5 FCCPC (Federal Competition and Consumer Protection Commission)**

* Consumer terms of service comply with FCCPC e-commerce guidelines. Returns and refunds policy clearly disclosed.

* Cooling-off period: 7 days for unworn / unused goods (excluding hygiene-sensitive categories).

* Dispute resolution accessible from the buyer dashboard; FCCPC complaint process referenced in support documentation.

## **11.6 Other**

* Tax: VAT 7.5% applied at checkout where the seller is VAT-registered; tax handled by an integration with a tax engine (Avalara or equivalent regional service) or in-house tables for the Nigerian market.

* GDPR: any access from EU residents triggers GDPR-aligned handling (the codebase implements the higher of NDPR / GDPR for any rights request).

* Accessibility: WCAG 2.2 AA target on web; Flutter Material 3 accessibility primitives on mobile. Annual third-party accessibility audit.

* Trust & Safety: clear community guidelines; reporting flow on every stream and listing; transparent enforcement actions logged.

# **Part 12 — UI/UX Design System**

The full design system documentation lives in the design Figma library and the design-tokens.json package consumed by both the web (Tailwind) and mobile (Flutter ThemeData) apps. This section captures the canonical decisions.

## **12.1 Design Philosophy: Shoppertainment First**

Entertainment first, shopping second. Live commerce converts at 10–30% versus traditional e-commerce at 2–3%. The platform is designed around video-native layouts where the live stream dominates 60%+ of the viewport, with frictionless one-tap purchasing during streams (TikTok Shop model). Social proof is embedded everywhere: viewer counts, real-time purchase notifications, animated reactions floating upward, and chat activity.

## **12.2 Brand Colours**

| Token | Hex | Usage | WCAG |
| :---- | :---- | :---- | :---- |
| Epplaa Blue (primary) | \#1B2A4A | Primary brand, headers, navigation | AAA on white |
| Epplaa Sky (accent) | \#4A90D9 | CTAs, links, active states | AA on white |
| Success Green | \#28A745 | Live indicators, confirmations | AA on white |
| Danger Red | \#DC3545 | Errors, end stream | AA on white |
| Warning Amber | \#FFC107 | Low stock, alerts | AA on dark bg |
| Neutral 100 (bg) | \#F8F9FA | Page backgrounds | — |
| Neutral 900 (text) | \#212529 | Body text | AAA on white |

## **12.3 Typography**

Web: Inter (Google Fonts) with system fallbacks (-apple-system, BlinkMacSystemFont, Segoe UI, Roboto). Mobile (Flutter): platform-native fonts (San Francisco for iOS, Roboto for Android). Base size 16 px; scale: H1 2 rem, H2 1.5 rem, H3 1.25 rem, body 1 rem, small 0.875 rem. Line height: 1.5 body, 1.2 headings.

## **12.4 Component Library**

Web: shadcn/ui (React, already in architecture). Flutter: custom Material 3 library with Riverpod state management. Shared design tokens exported as design-tokens.json consumed by both Tailwind config and Flutter ThemeData.

## **12.5 Mobile Navigation**

Five-tab bottom navigation following TikTok / Instagram standard: Home (live feed \+ For You), Discover (search \+ categories), Go Live / \+ (centre, elevated, camera icon for sellers, hidden for buyers), Inbox (orders \+ messages), Profile (history / dashboard). Desktop uses top nav with expandable search bar and collapsible left sidebar for sellers.

## **12.6 Nigeria-Specific UX**

* Delivery option prominence: Epplaa Box and PUDO locations shown prominently at checkout with map view. Home delivery presented as premium with clear pricing.

* Payment method visibility: all local payment methods (Verve, bank transfer, USSD) displayed at checkout. No method hidden behind "More options."

* WhatsApp integration: order updates, OTP codes, and delivery notifications sent via WhatsApp (Nigeria's dominant messaging platform) in addition to SMS and push.

* Offline-resilient: product pages and cart cached locally. Checkout completes on USSD for buyers with poor data connectivity.

* Naira-first: all prices displayed in NGN. International manufacturer prices converted at checkout using live exchange rates.

* Data-light mode: compressed images, lazy-loaded video thumbnails, "Lite" stream quality option for buyers on limited data plans.

# **Part 13 — Sprint Plan**

14 sprints, two-week cadence (with one explicit extension for Sprint 5). Each sprint has a clear theme, exit criteria, and the cross-cutting enterprise-grade work woven in (security, observability, compliance) rather than treated as a phase-end clean-up.

## **13.1 Sprint Overview**

| Sprint | Theme | Headline outcomes |
| :---- | :---- | :---- |
| 0 | Foundation (1 week) | Repo bootstrap; Hetzner \+ Cloudflare Terraform; k3s clusters in staging and prod; Vault HA bootstrap; CI baseline; OpenTelemetry SDK in starter service. |
| 1 | Identity & Auth | identity-service; Keycloak; OTP via Termii; session management; first end-to-end SLO dashboard. Node 24 pin, ESLint 10 flat config. |
| 2 | Catalog & Manufacturer | catalog-service, manufacturer-service; multi-currency wholesale pricing; OpenSearch product index. |
| 3 | Cart & Checkout (Part 1\) | cart-service; checkout flow scaffolding; pricing-service; Paystack and Flutterwave SDKs integrated in dev only (no production traffic). |
| 4 | Streaming MVP | Lagos edge ingest tier provisioning; stream-service; RTMP ingest end-to-end; Cloudflare Stream distribution; basic player. |
| 5 | Cart, Checkout & Fulfillment (3 weeks) | fulfillment-service; Epplaa Box management; PUDO partner onboarding; OkHi address verification; Shipbubble dispatch; checkout delivery options; WhatsApp notifications; Paystack live with Flutterwave failover; 20-Box pilot deployment plan finalised. |
| 6 | Discovery & For-You | discovery-service; basic recommendation; trending streams; live discovery feed. |
| 7 | In-Stream Commerce | In-stream "buy now"; live reactions; live chat with moderation hooks; multistream relay (TikTok / Instagram / Facebook). |
| 8 | Manufacturer Marketplace | Cross-border import pipeline; bonded warehouse integration; multi-currency pricing in catalog; manufacturer payout via Flutterwave; customs broker workflow. |
| 9 | Trust & Safety | Real-time content moderation pipeline; T\&S queue; CSAM detection (PhotoDNA / NCMEC); dispute resolution. |
| 10 | Observability hardening | SLO dashboards across all services; alert routing; runbook authoring; chaos game day \#1; DR drill \#1. |
| 11 | Compliance & Audit | NDPR rights endpoints; KYC tiering; PCI SAQ-A self-assessment; first DPCO engagement; data retention enforcement; sanctions screening live. |
| 12 | Performance & A11y | Performance budget enforcement; LCP / INP work; WCAG 2.2 AA audit and fixes; load test sign-off. |
| 13 | Beta | Closed beta — 50–100 sellers, 500–1,000 buyers in Lagos. Two-week beta with at least 3 live stream events. All three fulfillment tiers exercised. Daily beta review. |
| 14 | Launch readiness & Go-live | Final security review; pen test sign-off; commercial launch; first week of operating in war-room mode. |

## **13.2 Sprint detail — Sprint 0 (Foundation)**

* Hetzner accounts and projects provisioned (Falkenstein primary, Helsinki DR).

* Cloudflare zone configured; Cloudflare Tunnel deployed to test cluster.

* Lagos edge ingest provider contracted and rack space confirmed (Rack Centre primary, MDXi alternate).

* Terraform repo bootstrapped; CI applies via OIDC-federated workflow (no long-lived cloud creds).

* k3s installed in staging and production; Linkerd installed; Argo CD installed; Vault installed and unsealed via cloud KMS.

* OpenTelemetry collector and Grafana / Prometheus / Loki / Tempo stack live.

* Starter service ("hello-svc") deployed end-to-end as the canary template; all teams fork from it.

## **13.3 Sprint detail — Sprint 5 (Cart, Checkout & Fulfillment, 3 weeks)**

Sprint 5 is intentionally three weeks because it carries the highest cross-team coordination load.

* fulfillment-service: delivery option routing; OkHi integration; Shipbubble dispatch.

* Epplaa Box management: compartment availability; OTP generation and verification (hashed at rest); station attendant mobile interface for loading.

* PUDO partner onboarding: registration flow; location verification; branded materials dispatch; commission tracking.

* Checkout delivery options: three fulfillment tiers with real-time pricing and ETA; map view of nearby Boxes and PUDO partners.

* WhatsApp notifications via Termii or Africa's Talking; SMS fallback; templates approved by WhatsApp Business.

* Paystack checkout live with Flutterwave failover; Pay on Collection at Box / PUDO; webhook ingress with HMAC \+ idempotency.

* Pilot deployment plan: 20 Epplaa Boxes (Lagos 10, Abuja 5, PH 3, Ibadan 2\) — physical hardware procured in parallel; software deploys before hardware lands.

## **13.4 Sprint detail — Sprint 13 (Closed Beta)**

* Beta cohort: 50–100 sellers, 500–1,000 buyers in Lagos.

* At least 3 live stream events during the beta — measured for engagement, conversion, and stream stability.

* All three fulfillment tiers exercised; minimum 50 successful Box pickups, 50 PUDO pickups, 50 home deliveries.

* Beta exit criteria: P95 checkout latency \< 2 s; payment success rate \> 98%; failed-delivery rate \< 8%; SEV-1 zero, SEV-2 ≤ 2\.

## **13.5 Out of scope for v1.0 (planned for v1.1+)**

* BNPL: Nigerian BNPL provider integration. Sprint 16+.

* Group buying / wholesale: group-buy mechanics. Sprint 17+.

* Phase 2 expansion: Ghana / Côte d'Ivoire localisation. Q3 2027\.

* Next.js 16 migration: scheduled Sprint 16 with explicit feature-freeze rules.

* Hyperscaler re-evaluation: end of 2027 as cost crosses the threshold.

# **Appendix A — Fulfillment Flow Diagram**

The reference flow below describes the canonical Nigeria-first journey from order capture to last-mile completion. All variants (cross-border imports, returns, COD reversals) branch from this baseline.

### **A.1 Standard Domestic Order — Lagos to Lagos**

* Buyer browses live stream or feed in the Flutter app and taps "Buy now" on a featured SKU.

* Order Service creates the order in PENDING\_PAYMENT status; Payment Service initialises a Paystack transaction and returns the checkout URL or inline modal token.

* Buyer completes payment (card, bank transfer, or USSD). Paystack webhook confirms; Order Service transitions to PAID.

* Inventory Service decrements stock and emits inventory.reserved on Redpanda.

* Fulfillment Service evaluates routing rules in priority order: (1) Epplaa Box if buyer selected one and capacity exists; (2) PUDO partner if within 5km of buyer-selected pickup point; (3) 3PL home delivery via Kwik, Glovo, or GIG.

* Selected channel is dispatched: smart-locker QR codes are generated, PUDO consignment notes are printed, or 3PL pickup is requested via the partner API.

* OkHi address verification is invoked for home-delivery orders to reduce failed-delivery rate; if confidence \< 0.8 the buyer receives an in-app prompt to refine the pin.

* Driver/courier status webhooks update Order Service; Notification Service pushes status changes via FCM and SMS.

* On delivery confirmation (locker open event, PUDO scan, or 3PL POD signature), Order Service transitions to DELIVERED and releases payment hold; Settlement runs T+1 to T+3.

### **A.2 Cross-Border Import Order — Shenzhen to Lagos Buyer**

* Vendor onboarding has flagged the SKU as IMPORT with country-of-origin CN and HS code recorded.

* On order placement the platform pre-calculates landed cost (FOB \+ freight \+ duty \+ VAT \+ clearance fee) and displays it to the buyer before payment.

* After payment, the order is consolidated at the Shenzhen freight forwarder; the platform receives a master AWB on consolidation.

* Air freight to Murtala Muhammed Cargo (Lagos) typically 5-9 days; sea freight to Apapa or Tin Can 28-45 days. Buyer sees the appropriate ETA at checkout.

* Customs clearance is handled by the licensed agent partner; SON, NAFDAC, or NCC compliance documents are produced where required by HS code.

* On clearance, the consolidated shipment is broken down at the Lagos bonded warehouse and individual orders enter the standard domestic flow from step 5 above.

### **A.3 Failure & Return Paths**

* Failed locker delivery (capacity full, hardware fault): order is re-routed to the nearest PUDO point automatically; buyer is notified with the new pickup address.

* Failed PUDO pickup after 96 hours: order is reversed to 3PL home delivery as a final attempt; if unsuccessful, return-to-sender is initiated.

* Buyer-initiated return within the 7-day NDPR-compliant return window: Return Service creates a reverse-logistics consignment; refund is held until physical inspection.

* Refunds are processed back to the original payment method within 5 business days for cards and 24 hours for bank transfers, per Paystack settlement terms.

# **Appendix B — Third-Party Integration Directory**

Every external dependency is captured below with its category, criticality tier, contract owner, and fallback posture. Tier 1 \= order flow stops on outage; Tier 2 \= degraded experience; Tier 3 \= best-effort.

## **B.1 Payment & Financial Services**

| Provider | Purpose | Tier | Fallback / Notes |
| :---- | :---- | :---- | :---- |
| Paystack | Primary payment gateway (cards, transfer, USSD, Apple Pay) | Tier 1 | Automatic failover to Flutterwave on circuit-breaker trip; PCI SAQ-A scope. |
| Flutterwave | Backup gateway, mobile-money rails (MTN MoMo, Airtel) | Tier 1 | Active-active for mobile money; primary for cross-border future expansion. |
| NIBSS BVN Verify | KYC tier 2 verification | Tier 2 | Cached results 90 days; manual review queue if unavailable \>2h. |
| Smile Identity | Document KYC, liveness check | Tier 2 | Used for vendor onboarding and tier-3 buyer KYC. |
| Mono / Okra | Bank account verification for vendor payouts | Tier 2 | Either provider can satisfy; weekly health check rotates primary. |

## **B.2 Logistics & Address**

| Provider | Purpose | Tier | Fallback / Notes |
| :---- | :---- | :---- | :---- |
| Kwik Delivery | 3PL home delivery (Lagos, Abuja, PH) | Tier 1 | One of three home-delivery partners; routing service load-balances by SLA. |
| Glovo | 3PL same-day (Lagos, Abuja) | Tier 1 | Premium SLA; preferred for cold-chain and high-value. |
| GIG Logistics | Inter-city and cross-border | Tier 1 | Sole provider for non-Lagos states until coverage expands. |
| OkHi | Address pinning and verification | Tier 2 | If unavailable, fall back to LGA-only delivery with extended ETA. |
| Google Maps | Geocoding, route preview | Tier 3 | Mapbox configured as drop-in fallback. |
| Epplaa Box network | Smart locker fulfillment (Lagos pilot) | Tier 2 | Owned hardware; outage falls back to PUDO routing. |

## **B.3 Communications & Engagement**

| Provider | Purpose | Tier | Fallback / Notes |
| :---- | :---- | :---- | :---- |
| Termii | SMS (NCC-licensed Nigerian gateway) | Tier 1 | Critical for OTP and delivery alerts; secondary route via Africa's Talking. |
| Africa's Talking | SMS, USSD, voice | Tier 2 | USSD short code provider for low-bandwidth checkout. |
| Firebase Cloud Messaging | Mobile push notifications | Tier 2 | Native FCM via Flutter; APNs for iOS bridged through FCM. |
| SendGrid | Transactional email | Tier 3 | Order receipts, vendor digests; non-blocking on failure. |

## **B.4 Streaming, Media & Content Safety**

| Provider | Purpose | Tier | Fallback / Notes |
| :---- | :---- | :---- | :---- |
| Cloudflare Stream | HLS / LL-HLS distribution and recording | Tier 1 | Used for asynchronous and standard-latency live; Mux on standby for failover testing. |
| LiveKit (self-hosted) | WebRTC SFU for ultra-low-latency seller-buyer interaction | Tier 1 | SFU nodes run on the Lagos edge tier; Hetzner EU is hot DR. |
| Cloudflare R2 | Stream segment object storage and VOD archive | Tier 1 | S3-compatible; Backblaze B2 documented as exit option. |
| Hive AI / Sightengine | NSFW and prohibited-goods classifier on stream frames | Tier 2 | Either provider satisfies; stream is auto-paused on policy hit. |

## **B.5 Platform & Observability**

| Provider | Purpose | Tier | Fallback / Notes |
| :---- | :---- | :---- | :---- |
| Hetzner Cloud (EU) | Primary compute, managed Postgres, object storage | Tier 1 | Falkenstein primary; Helsinki DR. No African region exists. |
| Cloudflare | CDN, DNS, WAF, Turnstile, Workers | Tier 1 | Lagos PoP via IXPN gives \<40ms RTT to Nigerian last-mile ISPs. |
| Rack Centre / MDXi (Lagos) | Edge co-location for ingest and SFU | Tier 1 | Either facility is acceptable; both peer at IXPN. |
| Grafana Cloud | Metrics, logs, traces, on-call | Tier 2 | Self-hosted Prometheus \+ Loki \+ Tempo retained as exit option. |
| Sentry | Frontend and mobile error tracking | Tier 3 | Self-hosted GlitchTip is the documented fallback. |
| 1Password / HashiCorp Vault | Secrets management | Tier 1 | Vault for runtime secrets; 1Password for human-held credentials. |

# **Appendix C — Architecture Decision Records (Summary)**

Each ADR below captures a decision that materially affects cost, latency, compliance, or operability. Full long-form ADRs live in the architecture repository under /docs/adr/.

### **ADR-001 — Hetzner EU primary with Lagos edge tier (not single-region Nigeria)**

Status: Accepted. Context: v3.0 referenced a "Hetzner Johannesburg" region that does not exist (Hetzner Online GmbH operates only in Germany, Finland, Singapore, and the United States; the Johannesburg "Hetzner" was rebranded Xneelo in 2019). Decision: Run the control plane and stateful tier in Hetzner Falkenstein with hot DR in Helsinki, and place latency-sensitive components (RTMP ingest, WebRTC SFU, edge cache) at a Lagos co-location facility (Rack Centre or MDXi) peered at IXPN. Consequences: \~40ms last-mile RTT for Nigerian buyers, EU compute economics for the heavy tier, and a clear NDPR data-residency story for sensitive PII via Lagos edge stores.

### **ADR-002 — Next.js 15 LTS chosen as N-1 runtime**

Status: Accepted. Context: Next.js 16.2 became stable in April 2026\. Decision: Pin to Next.js 15 (the previous stable line) for v1 launch and schedule a non-blocking upgrade evaluation in Sprint 12\. Consequences: Reduced risk of regression on launch; trades off some App Router improvements that landed in 16.x. Re-evaluation gate: open issue count and React Server Components stability at the time of the Sprint 12 review.

### **ADR-003 — Redpanda over managed Kafka for the event backbone**

Status: Accepted. Context: We need a Kafka-API-compatible event bus on Hetzner where AWS MSK or Confluent Cloud are not available in-region without a cross-region hop. Decision: Self-host Redpanda (Kafka-API-compatible, single binary, no ZooKeeper). Consequences: Lower operational complexity than open-source Kafka, fewer moving parts, and acceptable throughput for our projected event rate (estimated peak 25k events/sec at year-1 scale).

### **ADR-004 — Linkerd over Istio as service mesh**

Status: Accepted. Context: We need mTLS, retries, and traffic-shaping between microservices but do not need the full L7 policy engine of Istio. Decision: Linkerd 2.x. Consequences: \~10x lower data-plane resource overhead, simpler operability, no Envoy CVE blast radius. We accept that some advanced traffic-policy features (header-based routing weights, JWT filters) will require either a sidecar gateway or a future migration.

### **ADR-005 — k3s on Hetzner Cloud over managed Kubernetes**

Status: Accepted. Context: Hetzner does not offer a first-party managed Kubernetes control plane. Decision: Run k3s on dedicated control-plane nodes with etcd in HA, provisioned via Cluster API. Consequences: We own the control-plane upgrade cadence, which we accept in exchange for \~60% infrastructure cost reduction versus equivalent managed offerings on hyperscalers. A migration to a hosted control plane is a documented but explicitly out-of-scope option for v1.

### **ADR-006 — Paystack primary, Flutterwave backup with circuit-breaker failover**

Status: Accepted. Context: Both gateways are Nigerian-licensed and CBN-compliant; routing fully to one creates a single point of failure for revenue. Decision: Paystack handles the primary checkout path; Flutterwave is configured for synchronous failover via a circuit breaker (Resilience4j-style: open after 5 consecutive 5xx in 30s, half-open at 60s). Mobile money goes active-active. Consequences: Settlement reconciliation is more complex (two ledgers); we accept that complexity in exchange for revenue continuity during gateway incidents.

### **ADR-007 — Flutter for mobile (no native iOS/Android, no React Native)**

Status: Accepted. Supersedes the v1.0 / v2.0 rationale. Context: Earlier versions justified Flutter on the basis that React Native's "JavaScript bridge architecture" could not keep up with composited live-stream rendering. That rationale is now partially obsolete: React Native 0.76 (December 2024\) made the New Architecture (Fabric renderer \+ JSI \+ TurboModules) the default, and 0.82 removed the legacy bridge entirely. JSI gives JavaScript direct C++ memory references, eliminating the serialization tax the original argument depended on. The decision to stay on Flutter therefore needed to be re-justified on current terms.

Decision: Flutter (stable channel, Dart 3.x) for iOS and Android. Current rationale: (1) Impeller pre-compiled shaders deliver consistent 60 fps on mid-range Android (Tecno, Infinix) and 120 fps on flagship devices, with no first-frame jank — measurably better than React Native \+ Reanimated 3 \+ react-native-skia for the composited live-stream overlay use case (chat \+ reactions \+ product cards layered above an HLS video texture). (2) Pixel-perfect rendering across the wide Nigerian device spectrum, eliminating the platform-specific styling work that React Native's native-component model imposes. (3) The investment already made in the package layer (Riverpod, go\_router, dio, drift, flutter\_webrtc) and in the team's Dart expertise. Consequences: We accept a smaller talent pool than React Native and that we cannot share frontend component code with the Next.js web app; we mitigate the latter by sharing the API contract via OpenAPI codegen rather than UI code. A future re-evaluation gate is open: if mid-tier Android benchmarks show parity with Reanimated 3 \+ Fabric, and team composition shifts toward React talent, the question may be revisited.

### **ADR-008 — Per-service Postgres 16 (no shared database)**

Status: Accepted. Context: A shared database tightly couples services and prevents independent schema evolution. Decision: Each microservice owns its own Postgres logical database; cross-service reads happen via API or via outbox-driven events on Redpanda. Consequences: Higher operational surface (12 logical DBs), no cross-service joins; we accept this in exchange for the deployment independence and blast-radius isolation that the SLO model requires.

### **ADR-009 — Web tier split: Next.js for buyers, Vite \+ React for operators**

Status: Accepted. Context: A single Next.js application would force buyer-facing surfaces (which need SSR/ISR for SEO and OG cards) and operator-facing surfaces (which are SPAs behind authentication) into the same framework constraints, paying the SSR cost on tooling that does not benefit from it and slowing operator-tooling iteration. Decision: Buyer-facing pages remain on Next.js 15 App Router with React Server Components and ISR; admin.epplaa.com, studio.epplaa.com, and partner.epplaa.com run as Vite \+ React \+ TypeScript SPAs sharing a single workspace. Both stacks consume the same OpenAPI spec and the same auth provider. Consequences: Two build pipelines and two deployment targets to maintain; we accept that complexity in exchange for sub-second HMR on operator tooling and a clean SEO model for buyer surfaces. Vite's dev-speed advantage over Turbopack is meaningful over months of operator-tooling development; Next.js's SSR/ISR advantage is non-negotiable for the public marketplace.

# **Appendix D — Risk Register**

The four executive-tracked risks below feed directly into the monthly steering committee review. Each has a named owner, a quantified mitigation, and a "trip-wire" metric that escalates the risk to the next severity tier if breached.

| Risk | Likelihood | Impact | Mitigation | Owner / Trip-wire |
| :---- | :---- | :---- | :---- | :---- |
| Live-streaming latency degradation (Nigerian buyers see \>5s glass-to-glass) | Medium | High | Lagos edge ingest tier with WebRTC SFU; LL-HLS for the broadcast surface; per-stream latency SLO of 4s p95; automatic fallback to standard HLS on SFU failure. | Head of Platform / SLO breach \>2 days in 7-day window. |
| Payment gateway concentration risk (single-provider outage halts revenue) | Medium | Critical | Paystack \+ Flutterwave dual-gateway with circuit-breaker auto-failover; mobile-money rails active-active; daily reconciliation across both ledgers. | CFO / Any single-gateway outage \>30 min in business hours. |
| Last-mile delivery failure rate above contractual threshold | High | High | Three-channel routing (Box, PUDO, 3PL); OkHi address verification gate; 3PL partner SLA monitoring with monthly score-carding; per-LGA failure-rate dashboard. | Head of Operations / Failed-delivery rate \>7% in any 7-day rolling window per LGA. |
| NDPR / CBN compliance exposure (data breach, KYC lapse, settlement violation) | Low | Critical | NDPC-registered DPO; quarterly NDPR audit; full audit-log retention 7 years; KYC tiers enforced at Identity Service; CBN settlement-window monitoring. | General Counsel / Any regulator notice or P1 security incident. |

## **D.1 Secondary Risk Watchlist**

The risks below are tracked at the engineering review and escalate into the executive register only on the named trip-wire.

* Hetzner regional outage (Falkenstein primary): mitigated by hot Helsinki DR with documented failover runbook, RTO 30 min, RPO 5 min.

* Cloudflare account-level incident: mitigated by Lagos edge tier remaining functional for ingest and core API (degraded but operational); DNS exit option documented.

* Cross-border supply chain disruption (port congestion, customs hold): mitigated by air-freight default for high-margin SKUs and pre-cleared bonded inventory for top-velocity items.

* Regulatory change (NDPR amendment, CBN PSP guideline update): mitigated by quarterly legal review and a feature-flag-first design in compliance-sensitive flows so policy changes ship without code changes.

* Senior engineering attrition: mitigated by ADR discipline and runbook-first operations; bus-factor target of 3 on every Tier-1 service.

# **Appendix E — Glossary**

Plain-language definitions for the acronyms and platform-specific terms used throughout this document.

| Term | Definition |
| :---- | :---- |
| NDPR | Nigeria Data Protection Regulation — the binding data-protection regime supervised by the Nigeria Data Protection Commission (NDPC). |
| NDPC | Nigeria Data Protection Commission — successor to NITDA in the data-protection supervisory role. |
| CBN | Central Bank of Nigeria — regulator for payment service providers, settlement, and bank-payment integrations. |
| FCCPC | Federal Competition and Consumer Protection Commission — consumer-protection regulator with jurisdiction over e-commerce. |
| FIRS | Federal Inland Revenue Service — VAT and corporate-tax authority. |
| NCC | Nigerian Communications Commission — telecoms and SMS-gateway regulator. |
| SON / NAFDAC | Standards Organisation of Nigeria / National Agency for Food and Drug Administration and Control — product-conformity regulators relevant to imports. |
| BVN | Bank Verification Number — 11-digit biometric identifier issued by Nigerian banks; used for tier-2 KYC. |
| NIN | National Identification Number — issued by NIMC; used for tier-3 KYC and statutory ID matching. |
| PUDO | Pick-Up / Drop-Off — fulfillment model where the buyer collects from a partner location (pharmacy, kiosk, agent) instead of receiving at home. |
| Epplaa Box | Branded smart-locker network operated by Epplaa for self-collection in Lagos pilot zones. |
| USSD | Unstructured Supplementary Service Data — short-code menu accessed via \*xxx\# on any GSM handset; used for low-bandwidth checkout. |
| IXPN | Internet Exchange Point of Nigeria — Lagos peering fabric where Cloudflare, MainOne, and major Nigerian ISPs interconnect. |
| Rack Centre / MDXi | Tier-III carrier-neutral data centres in Lagos used as edge co-location partners. |
| HLS / LL-HLS | HTTP Live Streaming and Low-Latency HLS — Apple-originated streaming protocols; LL-HLS targets \~2-4s glass-to-glass. |
| WebRTC SFU | Selective Forwarding Unit — server topology that forwards encrypted media streams between WebRTC peers; enables sub-second latency. |
| SLO / SLI / SLA | Service Level Objective (internal target) / Indicator (the measurement) / Agreement (external commitment). |
| RPO / RTO | Recovery Point Objective (max acceptable data loss) / Recovery Time Objective (max acceptable downtime). |
| NCMEC | National Center for Missing & Exploited Children — recipient of mandatory CSAM reports under U.S. law that we voluntarily align to as a global standard. |
| SAQ-A | Self-Assessment Questionnaire A — the lightest PCI DSS scope, available where we never see, process, store, or transmit cardholder data. |
| ADR | Architecture Decision Record — a short, dated document capturing a single architectural choice and its rationale. |
| SBOM | Software Bill of Materials — machine-readable inventory of every dependency in a build; required for supply-chain attestation. |

# **Appendix F — RACI Matrix (Selected Activities)**

R \= Responsible, A \= Accountable, C \= Consulted, I \= Informed. This matrix lists only the activities most prone to ownership ambiguity; full RACI lives in the operating manual.

| Activity | CTO | Head of Platform | Head of Eng | Head of Ops | Security Lead | DPO |
| :---- | :---- | :---- | :---- | :---- | :---- | :---- |
| Production deploy approval (Tier 1 service) | A | R | C | I | C | I |
| SLO definition and review | A | R | C | C | I | I |
| Incident command (P1) | I | A | R | C | C | I |
| Vendor onboarding (KYC tier 3\) | I | C | R | A | C | C |
| NDPR data-subject request response | I | C | C | I | C | A/R |
| Penetration test scoping and remediation | A | C | C | I | R | I |
| Hetzner-to-Lagos edge cutover | A | R | C | C | C | I |
| Payment-gateway failover drill | I | A | R | C | C | I |
| Last-mile partner score-card review | I | I | C | A/R | I | I |
| Dependency upgrade (Node, Next.js major) | A | R | C | I | C | I |

| End of document This document supersedes Epplaa Architecture & Sprint Plan v3.0 in full. The v3.0 reference to a "Hetzner Johannesburg" region has been corrected; the runtime topology described here (Hetzner EU primary \+ Lagos co-location edge) is the only authoritative deployment model for v1. Approved versions of this document are stored in the architecture repository at /docs/architecture/v4.0/. Any deviation from the technology choices, SLOs, or compliance posture defined herein requires an ADR and CTO sign-off before implementation. |
| :---- |

