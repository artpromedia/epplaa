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

> **Superseded for new deployments by the generalised verifier
> (Task #101) below.** The hostname-only probe is intentionally left
> in place because `.github/workflows/check-production-hostname-pattern.yml`
> already wires it into a 15-minute schedule and removing it would
> silently drop the existing alert until the new workflow lands. New
> deploy / cron wiring should call `check-readyz-config` instead — it
> covers `productionHostnamePattern` AND every other high-risk
> setting in a single probe.

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
- Deploy-workflow integration (Task #100): the release pipeline
  (`.github/workflows/release.yml`, triggered on `push` of `v*` tags)
  ends with a `post-deploy-config-check` job that invokes the
  reusable workflow via `uses:` with `secrets: inherit`. The job runs
  with `needs: sentry-release` + `if: always()` so the configuration
  gate fires even when Sentry release tagging is skipped (Sentry vars
  unset) or fails — the two are intentionally independent, since a
  missing `PRODUCTION_HOSTNAME_PATTERN` is a deploy-blocking issue
  regardless of release-tag bookkeeping. A non-zero probe exit fails
  the release run synchronously instead of waiting up to ~15 minutes
  for the cron tick. The probe job no-ops cleanly until
  `vars.HOSTNAME_PATTERN_PROBE_ENABLED` is set to `1`. Required
  deploy-time configuration in the GitHub repo
  Settings → Secrets and variables → Actions:
  - `vars.HOSTNAME_PATTERN_PROBE_ENABLED=1` — opts the post-deploy
    gate (and the 15-minute cron) in. Leaving this unset (or set to
    anything other than `1`) silently skips the gate AND the cron
    job; the Sentry Cron monitor will then page on missed check-ins,
    which is the intended "disabling the probe must be deliberate"
    behaviour.
  - `vars.READYZ_URL` — full URL to `/api/readyz` on the production
    deploy (e.g. `https://api.epplaa.com/api/readyz`). The probe
    fails fast if missing.
  - `vars.SENTRY_ORG`, `vars.SENTRY_PROJECT` — Sentry destination,
    reused from `release.yml`'s `sentry-release` job.
  - `secrets.HOSTNAME_PATTERN_SENTRY_DSN` — DSN used by `sentry-cli`
    to post the fatal-level page event AND the Sentry Cron monitor
    check-ins. Omitting it disables Sentry forwarding + heartbeat
    but keeps the GitHub failed-workflow notification path intact.
- Tests: `routes/health.test.ts` (route shape across signals,
  including the 503-not_ready + missing-pattern combination),
  `lib/productionSignals.ts`'s helper unit tests, and
  `scripts/checkProductionHostnamePattern.test.ts` (decision matrix +
  CLI exit-code mapping + structured stdout/stderr lines).

### Post-deploy verifier: full readyz config block (Task #101)

The original hostname-only probe (Task #89) only paged on
`PRODUCTION_HOSTNAME_PATTERN`. Task #101 generalised the `/readyz`
config block to surface a tri-state status for EVERY high-risk
operator-set boot-time setting, and added a generalised probe that
pages on-call when ANY of them is in a dangerous combination — so
on-call sees exactly which env var is wrong rather than just
"something is wrong".

- Surface: `getReadyzConfigBlock()` in `artifacts/api-server/src/routes/health.ts`
  now returns FIVE fields (every status defaults to a non-paging
  value on a clean dev/staging env so the probe stays silent unless
  something is actually wrong):

  | Field                         | Page on                       | Informational on                                                            |
  | ----------------------------- | ----------------------------- | --------------------------------------------------------------------------- |
  | `productionHostnamePattern`   | `missing`                     | `configured`, `not_required`                                                |
  | `rehearsalInjectorEnabled`    | `enabled_in_production`       | `disabled`, `enabled_non_production`                                        |
  | `stubFulfillmentEnabled`      | `enabled_in_production`       | `disabled`, `enabled_non_production`                                        |
  | `rateLimitStore`              | `memory_misconfigured`        | `redis`, `memory_not_required`, `memory_opt_out_acknowledged` (single-replica canaries that explicitly set `RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION=1` — intentional, not paged) |
  | `sentryDsn`                   | `missing`                     | `configured`, `not_required`                                                |

  Every boot-time guard already crash-loops the dangerous
  combination on a clean restart — but a hot env-var rotation, a
  platform-side env-var change without restart, or an emergency
  rollback that skipped the boot guard can still leave a running
  replica in the dangerous state. The probe catches that drift
  within the next polling interval. As before, the block is
  INFORMATIONAL and does NOT change the ready/not_ready decision.

- Probe: `pnpm --filter @workspace/api-server run check-readyz-config`
  (source: `src/scripts/checkReadyzConfig.ts`). Reads `READYZ_URL`,
  polls `/readyz`, evaluates every field independently, folds the
  outcomes into a worst-wins decision, and exits:
  - `0` — every field is in a non-paging state (silent on healthy
    prod and on non-prod deploys; the same workflow can fan out
    across envs without flapping).
  - `1` — probe error: network failure, non-JSON body, missing
    `config` block, OR any field has an unrecognised value
    (response-shape regression / version skew with an older replica
    that hasn't deployed yet — escalate to a human rather than
    silently treating the field as healthy).
  - `2` — page on-call: at least ONE field is in a paging state.
    The structured stdout JSON line lists every paging field with a
    field-specific reason that names the offending env var AND
    points at this runbook, so the page body is self-contained and
    the on-call can fix every misconfigured setting in one
    redeploy rather than one-at-a-time after re-running the probe
    between each restart.

  Accepts BOTH `200 ready` AND `503 not_ready` (the config block is
  included on both paths) so a downstream outage can never silently
  mask a config misconfiguration — the worst-possible time to lose
  the page.

- Scheduling: when the dedicated workflow lands it should mirror
  `.github/workflows/check-production-hostname-pattern.yml`'s
  schedule + Sentry pager + cron-monitor heartbeat pattern (15-minute
  cadence, `workflow_dispatch` for ad-hoc, `workflow_call` so deploy
  workflows can invoke it as the final post-deploy gate). Use a
  separate `vars.READYZ_CONFIG_PROBE_ENABLED=1` toggle and a
  separate `secrets.READYZ_CONFIG_SENTRY_DSN` so the two probes can
  be enabled / disabled independently while the rollout is in
  progress.

- Tests: `routes/health.test.ts` (per-field route shape on both
  the 200 ready and 503 not_ready paths, plus the all-safe
  baseline and the page-everything composition),
  `lib/productionSignals.test.ts` (per-helper branch matrix for
  `getRehearsalInjectorEnabledStatus` /
  `getStubFulfillmentEnabledStatus` / `getSentryDsnStatus`),
  `middlewares/apiRateLimit.test.ts` (the
  `getRateLimitStoreReadyzStatus` helper), and
  `scripts/checkReadyzConfig.test.ts` (per-field rule matrix +
  aggregate fold + worst-wins severity + CLI exit-code mapping +
  structured stdout/stderr lines, including the version-skew
  missing-field case).

### `lib/fulfillment/gig.ts` `allowStubFallback()`

- Env flag: `STUB_FULFILLMENT=1`
- Why dangerous on production: when GIG credentials *are* configured,
  a real GIG outage would silently return synthetic stub quotes /
  labels. Buyers would be charged against shipments that don't exist.
- Disposition: **hardened.** `allowStubFallback()` now refuses the
  stub fallback whenever `isProductionEnvironment(...)` is true,
  regardless of whether `STUB_FULFILLMENT=1` is set. The previous
  `NODE_ENV !== "production"` check is preserved underneath as the
  default behaviour for staging/dev. Task #88 additionally added a
  boot-time guard (`assertStubFulfillmentSafe`, see below) so a
  misconfigured production deploy crash-loops at startup instead of
  waiting for the first carrier failure to surface.

### `lib/fulfillment/shipbubble.ts` `allowStubFallback()`

- Env flag: `STUB_FULFILLMENT=1`
- Same threat model as GIG.
- Disposition: **hardened** (same change as GIG, plus the same boot-
  time guard in Task #88).

### `lib/fulfillment/okhi.ts` `allowStubFallback()`

- Env flag: `STUB_FULFILLMENT=1`
- Why dangerous on production: when OkHi credentials *are*
  configured, a real OkHi outage would silently return a deterministic
  stub place id with high confidence. An unverified address would
  pass the home-delivery confidence gate (≥70) and ship to a bad
  address.
- Disposition: **hardened** (same change as GIG / Shipbubble, plus the
  same boot-time guard in Task #88).

### Boot-time guard for `STUB_FULFILLMENT=1` (`assertStubFulfillmentSafe`)

- Env flag: `STUB_FULFILLMENT=1`
- File: `artifacts/api-server/src/lib/fulfillment/bootGuard.ts`
- Wired in: `artifacts/api-server/src/index.ts` (alongside
  `assertRehearsalKillSwitchSafe` and
  `assertRateLimitStoreConfiguredForProduction`).
- Why dangerous on production: the per-request `allowStubFallback()`
  guards above are reactive — a copy-paste of staging env vars
  (which include `STUB_FULFILLMENT=1`) into a production deploy would
  let the api-server boot cleanly and only surface the
  misconfiguration the first time a real carrier call failed
  (potentially mid-checkout for a real buyer). The per-request guard
  would then throw on every dispatch attempt rather than producing
  one loud crash on-call could act on.
- Disposition: **hardened (Task #88).** Mirrors the rehearsal injector
  guard: at boot, if `STUB_FULFILLMENT=1` is observed alongside any
  production signal (`NODE_ENV=production`, `REPLIT_DEPLOYMENT=1`,
  `DEPLOYMENT_ENVIRONMENT=production`, or `HOSTNAME` matching
  `PRODUCTION_HOSTNAME_PATTERN`), `process.exit(1)` runs and the
  platform health check crash-loops the deploy. The structured log
  line (`stub_fulfillment_kill_switch_on_in_production`) names every
  triggered signal so the operator can fix the misconfiguration in
  one round trip.
- Unit-tested in `lib/fulfillment/bootGuard.test.ts` (staging-allowed
  paths covering each non-production NODE_ENV / hostname-mismatch
  case, and production-rejected paths covering each individual signal
  plus multi-signal aggregation).

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
