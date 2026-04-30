# apps/

User-facing applications. Each subdirectory is an independently
buildable, independently deployable application.

This directory is **empty by design** until [Phase 1 of the v4.2
amendment](../docs/architecture/v4.2-amendment.md) lands. At that
time the following moves are performed via `git mv` so file history
is preserved:

| From | To |
| :--- | :--- |
| `artifacts/epplaa-app` | `apps/web-buyer-spa` |
| `artifacts/admin-console` | `apps/admin` |
| `artifacts/manufacturer-portal` | `apps/partner` |
| `artifacts/epplaa-mobile` | `apps/mobile` |

A new empty Vite + React app is also scaffolded at `apps/studio` for
seller-facing tooling that is currently embedded inside the buyer
SPA. It is populated in Phase 8.

A new Next.js 15 app is scaffolded at `apps/web` in Phase 6 and
takes over from `apps/web-buyer-spa` once feature parity is
reached.

## Conventions

- One application per directory. No shared business logic; that
  belongs in `packages/`.
- The directory name is the application name as it appears in
  CODEOWNERS, in CI workflow filters, and on the deployed subdomain.
- Every app has its own `package.json`, build, and test command;
  the workspace runs them via `pnpm -r`.

See [ADR-0002](../docs/adr/0002-repository-layout.md) and
[ADR-0004](../docs/adr/0004-web-framework-split.md) for the
rationale.
