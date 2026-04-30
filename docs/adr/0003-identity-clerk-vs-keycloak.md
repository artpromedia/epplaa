# ADR-0003: Identity provider — Clerk retained, Keycloak deferred

- **Status**: Accepted
- **Date**: 2026-04-30
- **Deciders**: Architecture WG, Security Eng

## Context

The v4.1 spec lists Keycloak as the OIDC provider of record. The
current code base integrates Clerk (`@clerk/clerk-react`,
`@clerk/express`) with custom MFA, backup-codes, and an MFA-elevated
session model already implemented in `lib/` and `artifacts/api-server`.
There is meaningful sunk investment: the MFA contract test
(`mfa.contract.test.ts`), the rate-limit opt-out gating, and the
Sentry monitor configuration all assume Clerk's session shape.

Clerk is a managed SaaS; Keycloak is self-hosted. The trade-offs are
the standard SaaS-vs-self-hosted axes — operational burden, blast
radius, data residency, vendor lock-in, cost at scale, feature
velocity.

## Decision

Retain **Clerk** as the identity provider for at least Phases 0–6 of
the v4.2 evolution. Defer the Keycloak migration. Capture the
migration design now (so the deferral is informed) but do not
implement it yet.

The `services/identity-service` extracted in Phase 4 step 2 will own
the *boundary* to the identity provider — every other service will
talk to identity-service, never to Clerk directly. This means a
future swap to Keycloak (or any other OIDC IdP) is a one-service
change, not a workspace-wide change.

## Consequences

**Easier**
- No identity-platform migration risk during the strangler-fig
  service extractions.
- MFA, backup codes, session elevation, and audit hooks already work
  and have CI cover.
- Developer onboarding remains free (Clerk dev tier).

**Harder**
- Vendor lock-in to Clerk grows the longer we defer.
- Data residency: Clerk's primary region is US. For NDPC compliance
  on Nigerian PII, we already document Clerk as a sub-processor and
  rely on its DPA; this stance must be re-validated annually.
- Cost scales with monthly active users; migration economics worsen
  the further along we are.

## Alternatives considered

- **Migrate to Keycloak now** — rejected because it adds 1–2 sprints
  of identity migration on top of the strangler-fig work and
  multiplies risk during the most critical migration phase.
- **Migrate to Auth0 / WorkOS / Stytch** — rejected: same SaaS
  trade-offs as Clerk with no compelling delta and a non-trivial
  migration cost.
- **Roll a custom IdP on top of Lucia / NextAuth** — rejected: an
  identity provider is not core differentiation and we already pay
  Clerk's MFA, social login, and bot-protection complexity tax.

## Re-evaluation triggers

- Clerk monthly bill exceeds ~USD 5k/month, *or*
- An NDPC ruling or contract clause makes US-region session storage
  untenable, *or*
- Clerk imposes a feature limit that materially blocks roadmap
  (e.g., custom session claims for marketplace seller scoping).

When any trigger fires, ADR-0003 is superseded by an ADR documenting
the chosen replacement and the migration plan owned by
identity-service.
