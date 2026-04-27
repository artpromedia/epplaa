# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Artifacts

- `artifacts/api-server` — Express 5 API server (currently only `/api/healthz`).
- `artifacts/mockup-sandbox` — Vite preview server used for canvas mockup iframes. Hosts the original Lagos Night Market / Editorial Boutique / Naija Pop variant explorations under `src/components/mockups/`.
- `artifacts/epplaa-app` — **Epplaa**, the v1+v2 buyer + seller mobile web app. React + Vite + Tailwind v4 + shadcn/ui + wouter, frontend-only (all state in `src/lib/seed.ts` + `localStorage`). Mobile-first; centers a 390px frame on desktop. **Buyer routes**: `/`, `/discover`, `/live/:streamId`, `/product/:productId`, `/inbox`, `/profile`, `/account/{payment-methods,addresses,settings}`. **Seller routes**: `/seller/{apply,tiers,studio,listings,go-live}`. Bottom nav swaps by `mode`: buyer (Home/Discover/+/Inbox/Profile) vs seller (Studio/Listings/+/Inbox/Profile); hidden on `/live/*` and during seller broadcasting.

### Epplaa app conventions

- **Visual direction**: Lagos Night Market (warm cream + stone in light mode, near-black + cyan/magenta neon in dark). Source mockups live under `artifacts/mockup-sandbox/src/components/mockups/lagos-night-market/`. Theme tokens defined in `artifacts/epplaa-app/src/index.css`.
- **Theming** (`src/lib/theme-context.tsx`): defaults to `prefers-color-scheme`; manual choice persisted to `localStorage` key `epplaa-theme` with values `"dark" | "light" | "system"`. Applied via `.dark` class on `document.documentElement`.
- **Multi-country shell** (`src/lib/countries.ts`, `src/lib/country-context.tsx`): typed registry of countries with currency, payment methods, and fulfillment options. Nigeria (NG) is `status: "live"`; Ghana / Kenya / South Africa / Côte d'Ivoire are `"coming-soon"` and disabled in the switcher. Selected country persisted to `localStorage`. **All prices must be formatted via `formatPrice(amountMinor, country)` in `src/lib/format.ts` — never hardcode currency symbols.**
- **Adding a new country**: add an entry to `COUNTRIES` in `src/lib/countries.ts` and flip its `status` to `"live"`. No component changes required.
- **Seller mode** (`src/lib/seller-context.tsx`, `src/lib/seller-tiers.ts`): SellerProvider tracks `status` (`none|pending|approved|rejected`), `tier` (`starter|pro|elite`), `mode` (`buyer|seller`), `application`, `stats`, `listings`, plus a transient `isBroadcasting` flag. Mode toggle on Profile flips bottom nav. Submit on `/seller/apply` auto-approves to Starter for the demo (production would queue for review). Tier upgrades happen on `/seller/studio` via the upgrade card when GMV + days + listings criteria from `seller-tiers.ts > evaluateUpgrade` are met. All seller state persisted under `epplaa-seller-*` keys; cleared by Settings → Clear local data.
