# tools/

Internal developer tooling that ships in the workspace but is **not**
deployed to production. Each subdirectory is an independently
buildable workspace package.

This directory was created in [Phase 1 of the v4.2
amendment](../docs/architecture/v4.2-amendment.md) to hold things that
were previously misfiled under `artifacts/`:

| Previous location | Current location |
| :--- | :--- |
| `artifacts/mockup-sandbox` | `tools/mockup-sandbox` |

## Conventions

- Workspace packages here are named `@workspace/<dirname>`.
- They may depend on `packages/*` and on each other, but **not** on
  `apps/*` or `services/*`.
- Anything CI-only (Sentry monitor sync, secret-rotation scripts,
  load-test runners) lives under `scripts/` instead. `tools/` is for
  developer-facing UIs and harnesses (e.g. the Storybook-style mockup
  sandbox).

See [ADR-0002](../docs/adr/0002-repository-layout.md) for the
rationale behind the four-level split (`apps/` / `services/` /
`packages/` / `tools/`).
