# packages/

Shared TypeScript libraries published only inside the workspace. Not
released to npm. Consumed by `apps/*` and `services/*`.

This directory was populated in [Phase 1 of the v4.2
amendment](../docs/architecture/v4.2-amendment.md) by relocating the
existing libraries here:

| Previous location | Current location |
| :--- | :--- |
| `lib/db` | `packages/db` |
| `lib/api-spec` | `packages/api-spec` |
| `lib/api-client-react` | `packages/api-client-react` |
| `lib/api-zod` | `packages/api-zod` |
| `lib/payments` | `packages/payments` |

Additional packages introduced during the program:

- `packages/events` — broker-agnostic event publish/consume API
  (Phase 3; see [ADR-0006](../docs/adr/0006-event-backbone-redpanda.md)).
- `packages/search` — backend-agnostic search API (Phase 3; see
  [ADR-0007](../docs/adr/0007-search-opensearch.md)).
- `packages/analytics-events` — Avro schemas for analytics events
  (Phase 3; see [ADR-0008](../docs/adr/0008-analytics-clickhouse-dbt.md)).
- `packages/config` — typed `getSecret(name)` and `getConfig(name)`
  abstraction over Vault and env vars (Phase 3; see
  [ADR-0010](../docs/adr/0010-secrets-vault.md)).
- `packages/ui` — shared design system between Next.js and Vite apps
  (Phase 6).
- `packages/otel` — pre-wired OpenTelemetry SDK + auto-instrumentation
  bootstrapper for services (Phase 3).

See [ADR-0002](../docs/adr/0002-repository-layout.md) for layout
rationale.
