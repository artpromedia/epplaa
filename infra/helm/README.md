# infra/helm/

Helm chart skeletons for everything we deploy to the Hetzner k3s
cluster. Empty placeholder until [Phase 2 of the v4.2
amendment](../../docs/architecture/v4.2-amendment.md#phase-2--infrastructure-as-code-foundation-23-sprints).

## Planned charts

Substrate (Phase 2):

- `traefik/` — cluster ingress
- `cloudflared/` — Cloudflare Tunnel (only public ingress path)
- `argocd/` — GitOps deployment
- `cert-manager/`
- `external-dns/`
- `prometheus-grafana-loki-tempo/` — observability stack
- `otel-collector/`

Cross-cutting platform capabilities (Phase 3):

- `linkerd/` — service mesh; see [ADR-0009](../../docs/adr/0009-service-mesh-linkerd.md)
- `vault/` — secrets backbone; see [ADR-0010](../../docs/adr/0010-secrets-vault.md)
- `redpanda/` — event broker; see [ADR-0006](../../docs/adr/0006-event-backbone-redpanda.md)
- `opensearch/` — search; see [ADR-0007](../../docs/adr/0007-search-opensearch.md)
- `clickhouse/` — analytics; see [ADR-0008](../../docs/adr/0008-analytics-clickhouse-dbt.md)
- `postgres-operator/`
- `redis/`

Application charts (one per service, added in Phase 4 extractions):

- `api-monolith/` — first cutover; proves the substrate
- `notification-service/`, `identity-service/`, …, `analytics-service/`

Each chart is consumed by an Argo CD `Application` manifest under
[`infra/argocd/applications/`](../argocd/README.md). Charts are
linted in CI (`helm lint`) and rendered against Kubernetes schemas
(`kubeval`).
