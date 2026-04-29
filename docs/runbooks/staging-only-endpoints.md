# Staging-only debug/admin endpoint audit

Task #83 audited every endpoint, middleware toggle, and feature flag
in the api-server (and the four artifact apps) that is gated on a
single staging-only env var. The motivating threat model is the same
one that drove Task #81's boot-time guard for the rehearsal injector
(`/api/_rehearsal/*`):

> A copy-paste of staging env vars into a production deploy must
> not silently expose a debug endpoint or substitute synthetic data
> for real-call failure.

This document lists every gate found, the disposition (hardened with
the shared multi-signal helper, or documented as acceptable as a
single-flag gate), and the rationale.

## The shared helper

`artifacts/api-server/src/lib/productionEnv.ts` exports:

- `detectProductionSignals(env, log)` — returns the list of every
  production signal observed (empty when none).
- `isProductionEnvironment(env, log)` — convenience wrapper, true if
  any signal fires.

Production signals (any one is sufficient):

1. `NODE_ENV=production`
2. `REPLIT_DEPLOYMENT=1` (Replit production deployment)
3. `DEPLOYMENT_ENVIRONMENT=production`
4. `HOSTNAME` matches the regex in `PRODUCTION_HOSTNAME_PATTERN`

Unit-tested in `artifacts/api-server/src/lib/productionEnv.test.ts`
(empty cases, each individual signal, multi-signal aggregation, hot-
path log-throttling for the compiled hostname-pattern cache).

## Hardened gates (multi-signal helper applied)

### `POST /api/_rehearsal/inject-stuck-degraded` and `clear-stuck-degraded`

- Env flag: `HEALTHZ_REHEARSAL_ENABLED=1`
- File: `artifacts/api-server/src/routes/healthzRehearsal.ts`
- Why dangerous on production: would page real on-call with a
  synthetic stuck-degraded outage.
- Disposition: **already hardened in Task #81.** Refactored in Task
  #83 to import `detectProductionSignals` from the shared helper
  rather than its own private copy. Task #89 added a post-deploy
  verifier (see "Post-deploy verifier" below) that pages on-call when
  `PRODUCTION_HOSTNAME_PATTERN` — the strongest of the four signals
  — is unset on a production deploy, removing the silent-failure mode
  where the hostname backstop layer was absent without anyone
  noticing.

### Post-deploy verifier: `PRODUCTION_HOSTNAME_PATTERN` (Task #89)

- Surface: `getReadyzConfigBlock()` in `artifacts/api-server/src/routes/health.ts`
  surfaces the env-var status on `/readyz` as
  `config.productionHostnamePattern` ∈ `"not_required" | "configured"
  | "missing"`. The block is INFORMATIONAL — it does NOT change the
  ready/not_ready decision (failing readiness for a config warning
  would drain the replica out of rotation, more disruptive than the
  marginal security gain).
- Probe: `pnpm --filter @workspace/api-server run check-production-hostname-pattern`
  (source: `src/scripts/checkProductionHostnamePattern.ts`).
  Reads `READYZ_URL`, polls `/readyz`, and exits:
  - `0` — `configured` OR `not_required` (silent on healthy prod and on
    non-prod deploys, so the same workflow can fan out across envs
    without flapping).
  - `1` — probe error (network failure, non-2xx with no JSON body,
    missing or unrecognised `config` block — escalate response-shape
    regressions instead of silently passing).
  - `2` — page on-call: production deploy reports the pattern is
    missing.
  Accepts BOTH `200 ready` AND `503 not_ready` as valid responses
  (`/readyz` includes the `config` block on both paths) so a
  downstream outage can never silently mask the misconfiguration.
- Scheduling: `.github/workflows/check-production-hostname-pattern.yml`
  runs on `schedule` (every 15 minutes), `workflow_dispatch` (manual
  ad-hoc), and `workflow_call` (deploy workflows invoke this as the
  final post-deploy gate; a non-zero exit fails the deploy). Uses the
  same Sentry pager + cron-monitor heartbeat pattern as
  `check-healthz-degraded.yml`. Required vars/secrets:
  `vars.HOSTNAME_PATTERN_PROBE_ENABLED=1`, `vars.READYZ_URL`,
  `secrets.HOSTNAME_PATTERN_SENTRY_DSN` (omit DSN to skip Sentry
  forwarding + heartbeat; the workflow still fails on non-zero exit
  so on-call sees it via GitHub's failed-workflow notification).
- Tests: `routes/health.test.ts` (route shape across signals,
  including the 503-not_ready + missing-pattern combination),
  `lib/productionSignals.ts`'s helper unit tests, and
  `scripts/checkProductionHostnamePattern.test.ts` (decision matrix +
  CLI exit-code mapping + structured stdout/stderr lines).

### `lib/fulfillment/gig.ts` `allowStubFallback()`

- Env flag: `STUB_FULFILLMENT=1`
- Why dangerous on production: when GIG credentials *are* configured,
  a real GIG outage would silently return synthetic stub quotes /
  labels. Buyers would be charged against shipments that don't exist.
- Disposition: **hardened.** `allowStubFallback()` now refuses the
  stub fallback whenever `isProductionEnvironment(...)` is true,
  regardless of whether `STUB_FULFILLMENT=1` is set. The previous
  `NODE_ENV !== "production"` check is preserved underneath as the
  default behaviour for staging/dev.

### `lib/fulfillment/shipbubble.ts` `allowStubFallback()`

- Env flag: `STUB_FULFILLMENT=1`
- Same threat model as GIG.
- Disposition: **hardened** (same change as GIG).

### `lib/fulfillment/okhi.ts` `allowStubFallback()`

- Env flag: `STUB_FULFILLMENT=1`
- Why dangerous on production: when OkHi credentials *are*
  configured, a real OkHi outage would silently return a deterministic
  stub place id with high confidence. An unverified address would
  pass the home-delivery confidence gate (≥70) and ship to a bad
  address.
- Disposition: **hardened** (same change as GIG / Shipbubble).

## Acceptable single-flag (or shared-secret) gates

The endpoints / toggles below were considered and intentionally left
on a single env-flag gate. Rationale per row.

### `routes/promos.ts` `POST /promos/broadcast`

- Env flag: `INTERNAL_API_KEY` (also required as `x-internal-key` header)
- Disposition: **acceptable.** Not a single boolean kill switch — a
  shared secret gates the route. When the secret is unset the route
  fails closed (503), and presented values must match exactly. A
  staging→prod env-var copy-paste cannot widen the surface.

### `routes/referrals.ts` `POST /referrals/payout`

- Env flag: `INTERNAL_API_KEY` (header)
- Disposition: **acceptable.** Same shared-secret pattern as
  `/promos/broadcast`; additionally bounded by `REFERRAL_REWARD_CAP_MINOR`.

### `routes/pudo.ts` PUDO partner endpoints

- Env flag: per-partner `apiKey` from `pudo_partners`, falling back
  to `INTERNAL_API_KEY`
- Disposition: **acceptable.** Same shared-secret pattern; per-partner
  keys are the preferred path in production once partners are
  provisioned.

### `routes/fulfillmentWebhooks.ts` carrier webhook handlers

- Env flag: `*_WEBHOOK_SECRET` (Shipbubble, GIG)
- Disposition: **acceptable.** When the secret is configured we verify
  the carrier HMAC. When it is *unset*, we fail closed in production
  (503) and only accept unsigned payloads in dev/test (with a warning
  log). The single-direction check (production → fail-closed) is the
  inverse of the rehearsal kill switch, so the multi-signal helper
  would not change behaviour here.

### `lib/sanctions.ts` `selectProvider`

- Env flag: `SANCTIONS_PROVIDER`
- Disposition: **acceptable.** When the env is unset / `stub` and
  `NODE_ENV=production`, the screen result is forced to `blocked`
  (fail-closed) — payouts halt rather than silently passing
  un-screened recipients. Adopting the multi-signal helper would
  not strengthen this behaviour.

### `lib/moderation.ts` `selectProvider`

- Env flag: `MODERATION_PROVIDER`
- Disposition: **acceptable.** When unset / `stub` in production we
  flag `degraded` and surface it via the moderation provider info API
  (the admin dashboard surfaces a banner). The stub provider returns
  no-match for everything except an explicit `csam-test` marker, so
  a copy-paste of staging env vars into production cannot bypass real
  moderation — at worst it reduces moderation to no-op while the
  banner is visible. A separate active task ("Wire a real moderation
  provider (Hive or Sightengine + PhotoDNA)") tracks closing this.

### `routes/ndpr.ts` `POST /ndpr/export`

- Env flag: `NDPR_ASYNC=1`
- Disposition: **acceptable.** This is a forward-direction feature
  flag, not a debug endpoint: the inline path is the dev/preview
  default and `NDPR_ASYNC=1` is the production-worker mode. The flag
  changes *which* code path runs to fulfil the same request; it does
  not expose a hidden surface.

### `middlewares/csrf.ts` `secure` cookie attribute

- Env flag: `NODE_ENV === "production"` (forces `secure: true`)
- Disposition: **acceptable.** Right-direction (more strict in
  production). A staging→prod env-var copy-paste cannot weaken this.

### `middlewares/securityHeaders.ts` HSTS upgrade-insecure-requests

- Env flag: `NODE_ENV === "production"`
- Disposition: **acceptable** (right-direction).

### `middlewares/clerkProxyMiddleware.ts`

- Env flag: `NODE_ENV !== "production"` early return (proxy is a
  no-op in dev)
- Disposition: **acceptable** (right-direction — the proxy only runs
  in production).

### `middlewares/apiRateLimit.ts` in-memory store warning

- Env flag: `NODE_ENV !== "test"` gates a one-line warn-log
- Disposition: **acceptable.** Operational logging only.

### `lib/mfa.ts` `MFA_ENCRYPTION_KEY`

- Env flag: `MFA_ENCRYPTION_KEY`, with a `NODE_ENV === "production"`
  fail-fast when missing
- Disposition: **acceptable.** Already fails the boot in production
  if the key isn't set; in dev a deterministic fallback is derived
  from the session secret.

### `lib/otp.ts` `devEcho` and `routes/auth.ts` Clerk dev-stub

- Env flag: `!process.env.TERMII_API_KEY` (echoes the OTP code in the
  HTTP response when Termii is unconfigured); `!process.env.CLERK_SECRET_KEY`
  (returns a `noClerk: true` stub from `/auth/otp/verify`)
- Disposition: **acceptable but worth noting.** Both are gated on the
  *absence* of a required production secret rather than a positive
  staging-only flag, so a copy-paste of staging env vars cannot
  flip them on; if anything, prod env vars bring the real Termii /
  Clerk credentials. The risk is the inverse — a production deploy
  that *unsets* the secrets — which is already covered by the secret-
  presence checks elsewhere in the boot path. Adopting the multi-
  signal helper would not change behaviour here.

## Other artifacts

The four artifact apps (`epplaa-app`, `manufacturer-portal`,
`admin-console`, `epplaa-mobile`) were swept for `process.env.*` gates
on staging-only flags. None were found — these artifacts read only
build-time `import.meta.env.*` (Vite) or `expo-constants` values, all
of which are baked at build time per environment and have no runtime
copy-paste risk equivalent to the api-server's runtime env-var gates.
