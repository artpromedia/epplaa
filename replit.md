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
- `artifacts/epplaa-app` — **Epplaa**, the v1+v2 buyer + seller mobile web app. React + Vite + Tailwind v4 + shadcn/ui + wouter, frontend-only (all state in `src/lib/seed.ts` + `localStorage`). Mobile-first; centers a 390px frame on desktop. **Buyer routes**: `/`, `/discover`, `/search`, `/wishlist`, `/live/:streamId`, `/product/:productId`, `/cart`, `/checkout`, `/checkout/{location,address,payment,review,success/:orderId}`, `/orders`, `/orders/:orderId`, `/orders/:orderId/rate`, `/inbox`, `/profile`, `/account/{payment-methods,addresses,settings}`. **Seller routes**: `/seller/{apply,tiers,studio,listings,go-live,earnings}`. Bottom nav swaps by `mode`: buyer (Home/Discover/+/Inbox/Profile) vs seller (Studio/Listings/+/Inbox/Profile); hidden on `/live/*`, `/orders/:id/rate`, and during seller broadcasting. A floating cart badge (top-right) appears in buyer mode whenever the cart has items, except on the cart, checkout, product-detail, rate-order, and live routes.

### Epplaa app conventions

- **Visual direction**: **Lagos Sunset** — light mode uses cream surfaces (`hsl(40 76% 91%)` bg) with deep navy `#1B2A4A` primary and sunset coral `#E6502E` secondary; dark mode uses near-black `hsl(222 42% 10%)` with sky-blue `#5BA3F5` primary and warm coral `#FF8855` secondary. (Replaces the older cyan/magenta neon palette.) Source mockups live under `artifacts/mockup-sandbox/src/components/mockups/lagos-night-market/`. Theme tokens defined in `artifacts/epplaa-app/src/index.css`.
- **Theming** (`src/lib/theme-context.tsx`): defaults to `prefers-color-scheme`; manual choice persisted to `localStorage` key `epplaa-theme` with values `"dark" | "light" | "system"`. Applied via `.dark` class on `document.documentElement`.
- **Multi-country shell** (`src/lib/countries.ts`, `src/lib/country-context.tsx`): typed registry of countries with currency, payment methods, and fulfillment options. **Live**: Nigeria (NG). **Coming-soon (visible-but-disabled tiles in the switcher)**: 15 markets across all four sub-regions — West/Central (GH, CI, SN, CM, CD), East (KE, UG, TZ, RW, ET), Southern (ZA, BW, ZM), and North (EG, MA). Each entry carries country-specific currency, payment rails (Paystack, M-Pesa, Wave, Orange Money, Telebirr, Fawry, etc.), pickup partners, ID docs, business registry, bank-account spec, and central-bank payout authority — so going live in a new market is purely a config flip, never a code change. Selected country persisted to `localStorage`. **All prices must be formatted via `formatPrice(amountMinor, country)` in `src/lib/format.ts` — never hardcode currency symbols.** For **persisted orders**, use `formatOrderPrice(amountMinor, order.countryCode, fallbackCountry)` instead so historical totals keep their original currency even if the user switches country later.
- **Adding a new country**: add an entry to `COUNTRIES` in `src/lib/countries.ts` and flip its `status` to `"live"`. The `CountryCode` union is the single source of truth — TypeScript will guide you to fill in every required field. No component changes required, but to enable pickup you'll also need to seed `src/lib/fulfillment-locations.ts` with at least one Box Locker + one Pickup Partner row per primary city (mapX/mapY are 0–100 % positions on the stylized SVG city map).
- **Seller mode** (`src/lib/seller-context.tsx`, `src/lib/seller-tiers.ts`): SellerProvider tracks `status` (`none|pending|approved|rejected`), `tier` (`starter|pro|elite`), `mode` (`buyer|seller`), `application`, `stats`, `listings`, plus a transient `isBroadcasting` flag. Mode toggle on Profile flips bottom nav. Submit on `/seller/apply` auto-approves for the demo (production would queue for review). Tier upgrades happen on `/seller/studio` via the upgrade card when GMV + days + listings criteria from `seller-tiers.ts > evaluateUpgrade` are met. All seller state persisted under `epplaa-seller-*` keys; cleared by Settings → Clear local data.
- **Country-specific seller fields** (`src/lib/countries.ts`): each country defines its own `businessRegistry` (NG=CAC, GH=RGD, KE=BRS, ZA=CIPC, CI=RCCM-CEPICI), `identityDocs[]` (NG=BVN/NIN, GH=Ghana Card/Voter ID, KE=National ID/Huduma, ZA=SA ID/Passport, CI=CNI/Passeport), `bankAccount` spec (label / placeholder / digit range), and `payoutAuthority` (e.g. CBN, BoG, CBK, SARB, BCEAO). The `/seller/apply` wizard reads these fields directly — no NG-specific strings exist in components. To add a new country, extend `COUNTRIES` only.
- **Social-followers tier gate** (`src/lib/seller-tiers.ts > tierFromSocialFollowers`, `SOCIAL_TIER_THRESHOLDS`): the apply wizard's Social step asks for handle + follower count on Instagram, TikTok, X, Facebook, YouTube. The combined `totalFollowers` sets the starting tier (Pro at ≥5,000, Elite at ≥50,000) instead of forcing every new seller through Starter. Counts are recorded on the application; production would verify them within 24h before payouts unlock.
- **Cart, Checkout & Fulfillment (Sprint 5)**:
  - `src/lib/cart-context.tsx` — `useCart()` exposes `items`, `resolved`, `count`, `subtotalMinor`, `add`, `remove`, `setQty`, `clear`. Persisted under `epplaa-cart`. Lines are de-duplicated by `productId`.
  - `src/lib/orders-context.tsx` — `useOrders()`, `Order` shape with `countryCode`/`currencyCode` snapshot, `EP-<base36>` ids via `makeOrderId()`, 4-digit `pickupOTP` via `generateOTP()` for non-home deliveries. Persisted under `epplaa-orders`.
  - `src/lib/checkout-context.tsx` — draft state for the wizard (fulfillment option, pickup location id, delivery address, payment method, channel overrides). Persisted under `epplaa-checkout-draft` and cleared on order placement.
  - `src/lib/fulfillment-locations.ts` — ~40 seed pickup points across NG/GH/KE/ZA/CI with `mapX`/`mapY` for the stylized SVG city map.
  - `src/lib/notification-prefs.ts` — shared `NotificationPrefs` (push / WhatsApp + number / SMS + number / order-updates / promos / live-drops); used by both Settings and the Checkout payment step.
  - **Checkout wizard**: `/checkout` → method picker. Options whose id contains `home`, `door`, or `livraison` route to `/checkout/address` (tap-to-pin map + OkHi confidence score); all other options route to `/checkout/location` (list + map view of pickup points). Then `/checkout/payment` → `/checkout/review` → `/checkout/success/:orderId`. The Review step has strict guards that redirect back to the missing step (empty cart → `/cart`, no fulfillment option → `/checkout`, etc.) so an order with malformed state cannot be placed. Each "Where" page also redirects to the correct sibling route if the picked option doesn't match its method type.
  - Pickup orders show a 4-digit OTP card on the success screen, order detail, and inbox; home-delivery orders skip the OTP entirely.
- **Discovery, Social & Commerce extras (Sprint 6)**:
  - **Search** (`/search`, `src/lib/search-utils.ts`): full-text product search with category chips (All/Fashion/Beauty/Tech/etc) and a "Trending Now" grid as default state. Discovery's top search bar links here.
  - **Wishlist** (`/wishlist`, `src/lib/wishlist-context.tsx`): heart icon on product cards + product detail toggles `epplaa-wishlist`. Profile menu surfaces a Wishlist link.
  - **Follow sellers** (`src/lib/follows-context.tsx`): Follow/Following button on product detail next to seller name persists `epplaa-follows`.
  - **Drop alerts** (`src/lib/drop-alerts.ts`): Inbox grows a Drops tab that synthesizes "live now" + "new listing" alerts for followed sellers. Each alert renders as `{ kind, sellerName, hostAvatar?, title, detail, href, createdAtIso }`.
  - **Reviews + Rate Order** (`src/lib/reviews-context.tsx`, `/orders/:orderId/rate`): per-order-item star rating + comment + optional photo. Persisted under `epplaa-reviews`. Product detail shows aggregate rating + recent reviews via `useReviews().getForProduct/averageForProduct`. Order detail shows a "Rate Order" CTA only when status is `delivered`. Rate page hides the bottom nav and floating cart for focus.
  - **Seller Earnings** (`/seller/earnings`, `src/lib/earnings.ts`): commission-aware dashboard (10% commission, 3-day hold). Surfaces lifetime GMV, this month, commission, available balance, payout request flow with country-specific bank label (`country.bankAccount.bankNameExamples` is comma-separated — split + trim first entry). Payout threshold derived as `5000 * country.currency.minorPerMajor`. Persists payout requests under `epplaa-payouts`. Studio page links here.
  - **Recently Viewed** (`src/lib/recently-viewed.ts`): product detail tracks last 12 viewed products under `epplaa-recently-viewed`.
  - **Provider order in App.tsx** (top-down): `Theme > Country > Seller > Orders > Reviews > Follows > Wishlist > Cart > Checkout > Tooltip`. Reviews/Follows/Wishlist sit between Orders and Cart so cart/checkout consumers can read them but don't depend on them.
