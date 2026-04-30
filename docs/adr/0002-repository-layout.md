# ADR-0002: Repository layout (apps/, services/, packages/, infra/)

- **Status**: Accepted
- **Date**: 2026-04-30
- **Deciders**: Architecture WG, Platform Eng

## Context

The current repository organises code under two top-level directories:

- `artifacts/` — applications (`api-server`, `admin-console`,
  `manufacturer-portal`, `epplaa-app`, `epplaa-mobile`,
  `mockup-sandbox`).
- `lib/` — shared TypeScript packages (`api-spec`, `api-zod`,
  `api-client-react`, `db`, `payments`).

This layout served the early monolith well but does not express the
distinction the v4.1 spec relies on between *user-facing applications*,
*backend services*, *shared libraries*, and *infrastructure code*. As
services are extracted from the monolith, each new service will need a
clear home — and `artifacts/` is too generic to be that home.

## Decision

Adopt the following top-level layout, which mirrors the conventions
used by Turborepo / Nx workspaces and the layouts described in the
v4.1 spec sections 5.4 and 6:

```
apps/         — user-facing applications (web, mobile, admin, partner, studio)
services/     — backend services (and the api-monolith during transition)
packages/     — shared libraries published only inside the workspace
infra/        — infrastructure-as-code (terraform, helm, argocd, k3s, grafana)
apis/         — OpenAPI / AsyncAPI / Avro contracts shared across services
docs/         — architecture, ADRs, runbooks, compliance, glossary
tools/        — developer utilities, load tests, scaffolding scripts
scripts/      — repo-level automation (kept where it is for git history)
```

The migration from `artifacts/` and `lib/` is performed with `git mv`
so file history is preserved. The mapping is documented in
[v4.2 amendment §Phase 1](../architecture/v4.2-amendment.md).

`pnpm-workspace.yaml` is updated to enumerate the new roots
(`apps/*`, `services/*`, `packages/*`) instead of `artifacts/*` and
`lib/*`. Existing import paths are rewritten in the same commit that
moves the corresponding directory.

## Consequences

**Easier**
- New services and apps have an obvious home.
- Tooling that conventionally walks `apps/`, `services/`, `packages/`
  (Turborepo, Nx, GitHub Codespaces devcontainers, common Renovate
  configurations) works out of the box.
- CODEOWNERS rules become tree-aligned: frontend leads own `apps/`,
  backend leads own `services/`, platform owns `infra/`.

**Harder**
- One large mechanical PR per directory move; reviewers need to trust
  that `git mv` preserved history rather than re-reading every file.
- Replit `.replit` and any deploy config that references
  `artifacts/api-server` must be updated atomically with the move.

## Alternatives considered

- **Keep `artifacts/` and `lib/`, just add new dirs** — rejected
  because it permanently entrenches a layout that does not match the
  v4.1 vocabulary or industry conventions, costing every new
  contributor the cognitive tax of learning the local naming.
- **Use a flat `packages/` for both apps and libraries** (Turborepo's
  default) — rejected because the apps/services/packages distinction
  carries real semantic information (release cadence, deployment
  topology, ownership) that we want encoded in the path.

## Re-evaluation triggers

- If we adopt a build system (Turborepo, Nx, Bazel) that prefers a
  different top-level convention, revisit. Turborepo and Nx both
  accept the chosen layout as-is.
- If the number of services exceeds ~30, consider grouping by domain
  (e.g., `services/commerce/`, `services/streaming/`) rather than
  flat. This is a future-fork, not a current concern.
