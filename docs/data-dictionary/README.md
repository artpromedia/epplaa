# Data Dictionary

- **Status**: Placeholder (Phase 0 of v4.2 amendment); auto-generated
  in Phase 10.

This directory will hold the platform's data dictionary — a per-table
catalogue of column names, types, semantics, retention class,
PII / payment / health classification, and the responsible service
once the strangler-fig extraction is complete.

## Generation plan

1. **Phase 0 (now)** — empty placeholder.
2. **Phase 4 (per-service extraction)** — each extracted service's
   PR adds its tables to a `<service>.md` file in this directory.
3. **Phase 10** — replace the hand-maintained files with output of
   a script that walks every `packages/db/schema/*.ts` Drizzle
   definition and generates one Markdown file per service. The
   script lives at `tools/data-dictionary/generate.ts` and runs in
   CI so the dictionary is never stale.

## Classification taxonomy

Every column is tagged with one of:

- `public` — safe to expose externally.
- `internal` — internal-only, not regulated.
- `pii` — personally identifiable information (NDPR scope).
- `pii-sensitive` — sensitive PII (NDPR Art. 25 — health,
  biometric, etc.); subject to extra controls.
- `payment` — touches the cardholder data flow; SAQ-A boundary
  (see `docs/compliance/pci-cdf.md`).
- `secret` — must come from Vault, not the schema.

And one retention class:

- `retain-7y` — financial / order / payment audit (CBN guidance).
- `retain-5y` — identity, KYC.
- `retain-2y` — operational logs.
- `retain-90d` — session, ephemeral telemetry.
- `retain-purge` — deleted on user account erasure (NDPR right).

The Drizzle schema annotations that drive generation will be added
in the same PR that introduces the generator script.
