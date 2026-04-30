# apis/openapi/

Per-service OpenAPI 3.x specs. Empty placeholder; populated as
services extract from the monolith in [Phase 4 of the v4.2
amendment](../../docs/architecture/v4.2-amendment.md#phase-4--service-extraction-12-sprints-one-per-sprint).

## Conventions

- One file per service: `apis/openapi/<service-name>.yaml`.
- The seed file `apis/openapi/monolith.yaml` is a copy of
  `lib/api-spec/openapi.yaml` (post Phase 1: `packages/api-spec/openapi.yaml`).
  As routes peel off the monolith they move from `monolith.yaml` to
  `<service>.yaml`. When `monolith.yaml` is empty, it is deleted.
- The [`check-openapi-drift.yml`](../../.github/workflows/check-openapi-drift.yml)
  workflow ensures route handlers and the OpenAPI spec stay in sync.
- Per-service contract tests (Pact in Phase 9) reference these files
  as the contract.

## Why one file per service

OpenAPI 3.1 supports `$ref` across files, but tooling (codegen,
linting, contract testing) is most reliable when each service owns
exactly one self-contained spec file. Cross-service shared schemas
live in `apis/components/` (added when the first cross-service
shared schema appears).
