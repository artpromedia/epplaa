# ADR-0004: Web framework split — Next.js 15 buyer; Vite + React operator

- **Status**: Accepted
- **Date**: 2026-04-30
- **Deciders**: Architecture WG, Frontend Eng

## Context

The v4.1 spec ADR-009 splits the web tier into two surfaces:

- **Buyer-facing** — Next.js 15 (App Router, React 19) for SEO, SSR,
  share-preview cards, and Core Web Vitals on cold-start traffic.
- **Operator surfaces** (admin, studio, partner) — Vite + React SPA
  workspace, because these surfaces are authenticated, session-bound,
  and have no SEO requirement; their needs are dev velocity and
  bundle splitting under a single SPA shell.

The current code has the buyer app as a Vite SPA at
`artifacts/epplaa-app`. The admin console, manufacturer portal, and
mockup sandbox are also Vite + React. Studio (seller go-live, replays,
earnings) is currently embedded inside the buyer SPA.

## Decision

Adopt the v4.1 split as ADR-0004:

1. The buyer-facing web app is migrated to Next.js 15 at `apps/web`
   (Phase 6). The current Vite SPA at `apps/web-buyer-spa` (post
   Phase 1 rename) coexists at a subdomain (`spa.epplaa.com`) until
   feature parity is reached, then is deleted.
2. `apps/admin`, `apps/partner`, and a new `apps/studio` remain Vite +
   React SPAs. They share a `packages/ui` design system with the
   Next.js app. They are routed with TanStack Router.
3. Studio is **carved out of the buyer SPA** as part of Phase 8 — go
   live / replays / earnings move from `apps/web-buyer-spa/src/pages/
   seller-studio/` into `apps/studio/`. This separates seller-tooling
   release cadence from buyer-app release cadence.

## Consequences

**Easier**
- Buyer pages get SSR, OG/share cards, and per-route Lighthouse
  budgets; SEO-driven product/stream/seller pages become viable.
- Operator surfaces stay simple: SPA, Clerk session, no SSR auth
  dance.
- Two separate release cadences (buyer vs operator) reduce blast
  radius — a regression in studio cannot block a buyer-app deploy.

**Harder**
- Two web stacks to maintain: Next.js plugin/lint config and a Vite
  plugin/lint config. Mitigated by sharing tsconfig, tailwind config,
  and component library via `packages/`.
- Cross-app component changes touch two repos' build graphs.

## Alternatives considered

- **Next.js for everything** — rejected: SSR is overkill for
  authenticated SPAs, and Next.js's App Router conventions add
  friction for forms-heavy operator UIs.
- **Vite for everything** — rejected: the buyer app needs SSR for
  share/SEO, which Vite alone does not provide cleanly.
- **Remix instead of Next.js for the buyer app** — rejected: Next.js
  has the larger Nigerian dev pool and the spec already names it.

## Re-evaluation triggers

- Next.js 16.x evaluation gate (Q4 2026 per spec §1.4). If 16.x
  removes a behavior we depend on, revisit.
- If `packages/ui` proves too brittle to share between Next.js and
  Vite (RSC vs SPA mismatch), revisit by either dropping RSC usage in
  buyer or by making the operator apps Next.js-without-RSC.
