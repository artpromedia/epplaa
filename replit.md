# Overview

This project is a pnpm workspace monorepo using TypeScript, designed to build Epplaa, a mobile-first e-commerce platform. Epplaa aims to be a pan-African marketplace supporting both buyers and sellers across 16 countries, with features like live shopping, cross-border imports, and a robust seller studio. The platform prioritizes a localized user experience, dynamic pricing, and a secure transaction environment.

# User Preferences

I prefer iterative development with clear, high-level feature specifications. Focus on architectural decisions and core functionalities rather than minute implementation details in documentation. When adding new countries, changes should primarily be limited to data configuration rather than component modifications.

# System Architecture

The system is built as a pnpm monorepo with Node.js 24 and TypeScript 5.9. The backend uses Express 5 with PostgreSQL and Drizzle ORM for data management, while the frontend is a React, Vite, Tailwind v4, shadcn/ui, and wouter application. API code generation is handled by Orval from an OpenAPI spec.

**UI/UX Decisions:**
- **Visual Direction:** "Lagos Sunset" theme with distinct light (cream, deep navy, coral) and dark (near-black, sky-blue, warm coral) modes.
- **Theming:** Defaults to `prefers-color-scheme`, with manual override persisted in `localStorage`.
- **Mobile-First Design:** Centers a 390px frame on desktop.
- **Country Switcher:** Uses a compact native `<select>` for selecting from 16 live markets, displaying flag, name, and currency.
- **Dynamic Content:** Bottom navigation swaps between buyer and seller modes, and a floating cart badge appears conditionally.

**Technical Implementations & Feature Specifications:**
- **Multi-country Support:** Typed registry for 16 African countries, each with localized currency, payment methods, fulfillment options, business registries, and bank account specifications. All prices are formatted using `formatPrice` to ensure correct currency display.
- **Seller Studio:** Comprehensive seller features including application, tiers (Starter, Pro, Elite based on social followers), listings management, live stream tools, and earnings tracking with commission calculations.
- **Cart & Checkout:** Persistent cart, multi-step checkout wizard with fulfillment options (home delivery, pickup points), payment methods, promo code application, and order review. Pickup orders generate a 4-digit OTP.
- **Discovery & Social:** Product search with categories, wishlists, seller following, drop alerts for followed sellers, and product reviews.
- **Live Shopping:** Real-time engagement features including bot chatter, viewer count, likes, user chat, and product pinning. Supports live replays with integrated product lists.
- **Wallet System:** In-app wallet with top-up, spending, withdrawal, and refund capabilities, seeded with welcome credit.
- **Returns & Disputes:** Streamlined return request process with timeline tracking and dispute resolution.
- **Cross-Border Imports:** Calculation of landed costs (FOB, freight, insurance, duty, VAT, clearance) for imported goods, with a clear customs timeline.
- **Trust & Safety:** User reporting system for listings and sellers, with blocking functionality.
- **Onboarding:** First-run experience with animated progress, country selection, interest profiling, and notification opt-in.
- **Referral Program:** Generates unique referral codes and tracks associated earnings.

# External Dependencies

- **Database:** PostgreSQL
- **ORM:** Drizzle ORM
- **API Framework:** Express 5
- **Validation:** Zod (`zod/v4`), `drizzle-zod`
- **API Codegen:** Orval (from OpenAPI spec)
- **Payment Gateways:** Paystack, M-Pesa, Wave, Orange Money, Telebirr, Fawry (integrated based on country configurations)