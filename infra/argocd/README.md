# infra/argocd/

Argo CD `Application` and `ApplicationSet` manifests. Empty
placeholder until [Phase 2 of the v4.2 amendment](../../docs/architecture/v4.2-amendment.md#phase-2--infrastructure-as-code-foundation-23-sprints).

## Planned structure

```
infra/argocd/
├── README.md             ← this file
├── projects/
│   ├── platform.yaml     ← substrate apps (Phase 2)
│   ├── data.yaml         ← Redpanda, OpenSearch, ClickHouse, Postgres
│   └── services.yaml     ← every services/* app
├── applications/
│   ├── platform/         ← one Application per Helm chart in infra/helm/
│   ├── data/
│   └── services/         ← one Application per services/<name>
└── application-sets/
    └── per-service.yaml  ← ApplicationSet that auto-discovers services/*
```

Argo CD is the single deployment authority for the cluster: nothing
is `kubectl apply`d by hand in production. The cluster's contents
must equal `infra/argocd/applications/`'s rendered output at all
times — drift is alerted on via Argo's notifications controller and
investigated within the SLO defined by the on-call runbook.
