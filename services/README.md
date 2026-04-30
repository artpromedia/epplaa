# services/

Backend services. Each subdirectory is an independently buildable,
independently deployable Node.js service.

This directory is **empty by design** until [Phase 1 of the v4.2
amendment](../docs/architecture/v4.2-amendment.md) lands. At that
time the existing monolith moves here:

| From | To |
| :--- | :--- |
| `artifacts/api-server` | `services/api-monolith` |

The monolith then **shrinks each Phase 4 sprint** as services are
extracted from it according to the strangler-fig pattern in
[ADR-0001](../docs/adr/0001-strangler-fig-migration.md). The
extraction order, deferred until ADRs are merged, is:

1. notification-service
2. identity-service
3. catalog-service
4. manufacturer-service
5. cart-service
6. payment-service *(PCI scope reduction)*
7. order-service
8. fulfillment-service
9. discovery-service
10. stream-service
11. admin-service
12. analytics-service

When `services/api-monolith` no longer owns any routes, it is
deleted.

## Per-service skeleton

Every extracted service follows the same template:

```
services/<name>/
├── package.json
├── Dockerfile
├── src/
├── apis/
│   └── openapi.yaml      ← copy of apis/openapi/<name>.yaml
├── helm/                 ← chart deployed by infra/argocd/applications
└── tests/
```

Cross-cutting concerns (OpenTelemetry, Vault agent integration,
structured logging, health endpoints) are factored into `packages/`
and pulled in by every service.

See ADR-0001 and [v4.2 amendment §Phase 4](../docs/architecture/v4.2-amendment.md#phase-4--service-extraction-12-sprints-one-per-sprint).
