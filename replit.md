# Overview

This project is a pnpm workspace monorepo using TypeScript, designed to build Epplaa, a mobile-first e-commerce platform. Epplaa aims to be a pan-African marketplace supporting both buyers and sellers across 16 countries, with features like live shopping, cross-border imports, and a robust seller studio. The platform prioritizes a localized user experience, dynamic pricing, and a secure transaction environment.

# User Preferences

I prefer iterative development with clear, high-level feature specifications. Focus on architectural decisions and core functionalities rather than minute implementation details in documentation. When adding new countries, changes should primarily be limited to data configuration rather than component modifications.

# System Architecture

The system is built as a pnpm monorepo with Node.js 24 and TypeScript 5.9. The backend uses Express 5 with PostgreSQL and Drizzle ORM for data management, while the frontend is a React, Vite, Tailwind v4, shadcn/ui, and wouter application. API code generation is handled by Orval from an OpenAPI spec.

**Authentication & Data Layer:**
- Authentication is handled by Clerk (email/password, Google, Apple). The web app wraps the tree in `ClerkProvider` and gates protected routes via an `AuthGate`. Clerk session tokens are forwarded to the API by an `ApiAuthBridge` that registers a getter with the generated client.
- The API server mounts a Clerk reverse proxy plus `clerkMiddleware`, then validates user identity per request via `requireUserId`. All mutating handlers scope DB queries to the authenticated user.
- All previous `epplaa-*` localStorage state has been replaced with real API calls backed by Postgres (Drizzle). Only `epplaa-theme` remains client-side.
- Generated query keys are absolute paths starting with `/api/...`; manual `setQueryData` / `invalidateQueries` calls must use the same prefix.

**UI/UX Decisions:**
- **Visual Direction:** "Lagos Sunset" theme with distinct light (cream, deep navy, coral) and dark (near-black, sky-blue, warm coral) modes.
- **Theming:** Defaults to `prefers-color-scheme`, with manual override persisted in `localStorage`.
- **Mobile-First Design:** Centers a 390px frame on desktop.
- **Country Switcher:** Uses a compact native `<select>` for selecting from 16 live markets, displaying flag, name, and currency.
- **Dynamic Content:** Bottom navigation swaps between buyer and seller modes, and a floating cart badge appears conditionally.

**Technical Implementations & Feature Specifications:**
- **Multi-country Support:** Typed registry for 16 African countries, each with localized currency, payment methods, fulfillment options, business registries, and bank account specifications. All prices are formatted using `formatPrice` to ensure correct currency display.
- **Seller Studio:** Comprehensive seller features including application, tiers (Starter, Pro, Elite based on social followers), listings management, live stream tools, and earnings tracking with commission calculations.
- **KYC, NDPR & Compliance:** Three-tier KYC (rolling-30d GMV thresholds at NGN 500k → Tier 2 and NGN 5M → Tier 3). Documents are AES-256-GCM encrypted with per-document keys derived from `SESSION_SECRET`. Sanctions screening (stub provider blocks names containing "BLOCKED" and KP/IR/SY/CU country codes) runs on seller apply, kyc start, and quarterly. Payouts are inserted as `blocked` when seller tier < required tier or sanctions flag, with `processDuePayouts` re-evaluating and promoting to `pending` when cleared. NDPR data-subject rights (export/portability/erase/rectify/restrict) at `/api/ndpr/*` with 30-day grace before final purge. Hash-chained immutable audit log (`audit_events`) records every authenticated mutation. Pino logger redacts email/phone/govId/bankAccount/cardNumber/cvv/otp/password/token. Retention engine (24h cron) trims notifications, recently-viewed and recent-searches older than 90d, and final-purges users with `dataDeletedAt > 30d`. Frontend pages at `/account/privacy` and `/seller/kyc`.
- **Cart & Checkout:** Persistent cart, multi-step checkout wizard with fulfillment options (home delivery, pickup points), payment methods, promo code application, and order review. Pickup orders generate a 4-digit OTP.
- **Discovery & Social:** Product search with categories, wishlists, seller following, drop alerts for followed sellers, and product reviews.
- **Live Shopping:** Real-time engagement features including bot chatter, viewer count, likes, user chat, and product pinning. Supports live replays with integrated product lists. Hosts can deputise viewers as per-stream moderators (Task #22) — mods can delete chat messages and tune slow-mode/banned-words; promotions/revocations are written to the audit log.
- **Wallet System:** In-app wallet with top-up, spending, withdrawal, and refund capabilities, seeded with welcome credit. Top-ups create real Paystack/Flutterwave payment intents; balances are credited only after a verified webhook. Withdrawals queue a payout row that the cron job pushes through the gateway.
- **Payments, Splits, Payouts & VAT (Project Task #1):**
  - **Gateways:** Paystack (primary) with Flutterwave failover. A circuit breaker opens on >40% failure across the last 5 attempts in a 5-minute window. When neither gateway is configured, a `dev-mock` gateway serves a hosted sandbox checkout (`/api/__devpay/:reference`) so flows are end-to-end testable without keys.
  - **Webhooks:** `POST /api/webhooks/paystack`, `/flutterwave`, `/devmock` mounted **before** `express.json` with raw body parsing. Each event is verified (Paystack SHA-512 HMAC, Flutterwave verif-hash, dev-mock SHA-256), de-duplicated via a unique index on `payment_webhooks.eventId`, sanity-checked against the intent's expected amount, and marked succeeded idempotently.
  - **Splits & Payouts:** On payment success, an order is finalized with a 10% platform commission split. The seller share is queued as a payout with a hold window — 1 day for trusted sellers, 7 days for starter sellers. A daily cron (`processDuePayouts`) pushes due payouts through the gateway transfer API.
  - **VAT:** Computed server-side from the canonical `vat_rates` table (Nigeria seeded at 7.5%). Client `countries.ts` exposes `vatRateBp` for UI display only — server is authoritative.
  - **Refunds:** `POST /api/orders/:id/refund` is allowed only within the 14-day window post-delivery; settled holds are clawed back via `refund_attempts`.
  - **Reconciliation:** Daily cron pulls each gateway's settlement list and diffs against the ledger, recording mismatches in `reconciliation_runs` for the admin dashboard.
  - **Admin:** `EPPLAA_ADMIN_USER_IDS` (comma-separated Clerk user IDs) gates `/api/admin/*` for gateway health, recon runs, payout retries, and intent inspection.
  - **Required env:** `PAYSTACK_SECRET_KEY`, `FLUTTERWAVE_SECRET_KEY`, `FLUTTERWAVE_WEBHOOK_HASH`, `EPPLAA_ADMIN_USER_IDS`, `DEV_MOCK_SECRET` (only used when no gateway keys are present).
- **Returns & Disputes:** Streamlined return request process with timeline tracking and dispute resolution.
- **Cross-Border Imports:** Calculation of landed costs (FOB, freight, insurance, duty, VAT, clearance) for imported goods, with a clear customs timeline.
- **Trust & Safety:** User reporting system for listings and sellers, with blocking functionality.
- **Onboarding:** First-run experience with animated progress, country selection, interest profiling, and notification opt-in.
- **Referral Program:** Generates unique referral codes and tracks associated earnings.
- **Mobile App (Expo) — Auth Screens:** The Expo app at `artifacts/epplaa-mobile` mirrors the web "Lagos Sunset" palette in `constants/colors.ts`. The auth flow lives under `app/(auth)/` (`sign-in`, `sign-up`, `phone`, `verify`) with a shared `AuthScaffold` (branded header, back button, keyboard-aware scroll), `AuthField`, and `AuthButton`. Welcome lives at `app/index.tsx` with three feature cards and CTAs into the auth stack. All submit handlers are UI-only stubs marked `TODO(auth)` referencing the matching web flow at `artifacts/epplaa-app/src/pages/auth/*` — Clerk's mobile SDK and the existing `startOtp/verifyOtp` API hooks need to be wired in a follow-up. Avoid `<Link asChild>` wrapping `<Text>` with array styles on web — it crashes react-native-web's style setter; use `<Pressable>` + `router.push` instead.
- **API Rate Limiting (Redis TODO):** `artifacts/api-server/src/middlewares/apiRateLimit.ts` uses an in-memory token-bucket store. A `TODO(deploy)` comment marks where to swap in a Redis-backed store (Upstash/Memorystore via `REDIS_URL`) so limits shard across replicas — not yet provisioned. When the rate-limit store is degraded, the shopper app, manufacturer portal, and mobile app each render a small dismissible "Some actions may be slower than usual" banner. All three surfaces read from a single shared hook (`useRateLimitStoreBanner` in `lib/api-client-react`) which polls `/healthz` and resets dismissal whenever a fresh degradation incident begins.
- **Multi-instance Socket.IO (Task #21):** `artifacts/api-server/src/lib/socket.ts` wires `@socket.io/redis-adapter` when `REDIS_URL` is set so chat/reactions/presence broadcasts cross every API replica and one chat room is shared cluster-wide. Per-room viewer counts use `getRoomSize` (delegates to `Namespace.in(room).fetchSockets()`) instead of the local-only `adapter.rooms` map, so adding a second API instance no longer splits the viewer count or chat. Without `REDIS_URL` the boot logs `socket_io_adapter_in_memory_single_instance_only` and falls back to the in-process adapter (single-instance dev only).

# External Dependencies

- **Database:** PostgreSQL
- **ORM:** Drizzle ORM
- **API Framework:** Express 5
- **Validation:** Zod (`zod/v4`), `drizzle-zod`
- **API Codegen:** Orval (from OpenAPI spec)
- **Payment Gateways:** Paystack (primary) and Flutterwave (failover) with shared HMAC-verified webhooks; a `dev-mock` sandbox checkout is used when no real keys are configured. M-Pesa, Wave, Orange Money, Telebirr, and Fawry are listed as country-specific payment methods in the catalogue and are routed through the Paystack/Flutterwave umbrella for now.