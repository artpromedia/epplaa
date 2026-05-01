# `apps/studio` — Seller Studio

Per ADR-0004 (Web framework split) and Phase 8 of the v4.2 amendment,
`apps/studio` is the **dedicated Vite + React SPA** for seller surfaces:
go-live composer, replays, earnings, and moderation tools.

## Status

**Scaffolded.** This is the minimum viable shell — Vite, React 19,
Tailwind 4, TanStack Query, and Clerk auth wiring. Phase 8 of the v4.2
amendment fills in the actual surfaces by extracting them from
`apps/web-buyer-spa/`.

## Local dev

```sh
PORT=5174 BASE_PATH=/ VITE_CLERK_PUBLISHABLE_KEY=pk_test_xxx pnpm --filter @workspace/studio dev
```

## Routing

The single page (`src/pages/Dashboard.tsx`) is a placeholder. When
TanStack Router lands (Phase 8), routes follow `apps/admin/` conventions.

## See also

- `docs/adr/0002-repository-layout.md`
- `docs/adr/0004-web-framework-split.md`
- `docs/architecture/v4.2-amendment.md`, Phase 8
