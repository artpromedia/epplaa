# Runbook: Production secrets — boot-time presence checks

This runbook is the inventory of environment variables that the
api-server REQUIRES on a production deploy, plus the boot-time
presence checks that catch missing values before the next outage
proves them missing.

The pattern is deliberately copied from the rate-limit-store and
hostname-pattern checks in
[`docs/runbooks/rate-limit-store.md`](rate-limit-store.md) — each
"must-be-set on production" env var that currently defaults to a
silently-degraded mode gets a small `assertXxxConfiguredForProduction`
helper wired into `artifacts/api-server/src/index.ts`. The helpers
emit a structured `logger.warn` with a unique message tag on
production-shaped boots; on staging / dev / Replit dev workspaces
they are silent.

The check is intentionally a WARNING, not a hard failure: each
underlying env var has a per-request fail-closed (or per-feature
disable) at the consumer site, and crash-looping every existing
deploy that hasn't yet wired one of these would be more disruptive
than the marginal observability gain. The job of the boot-time check
is to put the misconfiguration in front of on-call within minutes of
the next deploy instead of on the next checkout / KYC upload / real
outage.

## Audit — every production-required env var the api-server reads

| Env var | Risk if unset on production | Check at boot? | Where the check lives |
| ------- | --------------------------- | -------------- | --------------------- |
| `DATABASE_URL` | Pool can't connect — every request 5xxs. | ✅ **Fails fast at import** in [`lib/db/src/index.ts`](../../lib/db/src/index.ts) (throws before any route can register). | `import` time in `lib/db/src/index.ts`. |
| `PORT` | Server can't bind. | ✅ **Fails fast at boot** in [`artifacts/api-server/src/index.ts`](../../artifacts/api-server/src/index.ts). | `index.ts` `rawPort` guard. |
| `HEALTHZ_REHEARSAL_ENABLED` | Staging-only injector enabled in production lets an external caller force `/healthz` into a fake-degraded state. | ✅ **Fails fast at boot** via `assertRehearsalKillSwitchSafe` in [`routes/healthzRehearsal.ts`](../../artifacts/api-server/src/routes/healthzRehearsal.ts). | `index.ts`. |
| `PRODUCTION_HOSTNAME_PATTERN` | The hostname signal in `assertRehearsalKillSwitchSafe` (the strongest backstop against a copy-pasted staging env file ending up on production) is silently disabled. | ✅ **Warns at boot** via `assertProductionHostnamePatternConfigured`. | `routes/healthzRehearsal.ts`, alert tag `production_hostname_pattern_missing`. See [`rate-limit-store.md`](rate-limit-store.md). |
| `RATE_LIMIT_STORE` | Falls back to the in-process bucket — replica-local counters trivially bypassed by spreading traffic across replicas in any multi-replica deploy. | ✅ **Warns at boot** via `assertRateLimitStoreConfiguredForProduction`. | `middlewares/apiRateLimit.ts`, alert tag `rate_limit_store_misconfigured_for_production`. See [`rate-limit-store.md`](rate-limit-store.md). |
| `SENTRY_DSN` | Silent no-op shim — every alert layered on top of Sentry (rate-limit failure pages, audit-chain anomaly captures, …) is dead at the source. | ✅ **Warns at boot** via `assertSentryDsnConfiguredForProduction` (this runbook). | `lib/sentry.ts`, alert tag `sentry_dsn_missing_for_production`. |
| `CLERK_SECRET_KEY` | Silent auth-bypass: `/api/__clerk` strips the secret-key header, `/auth/otp/verify` returns a `noClerk: true` stub, Socket.IO joins as anonymous. | ✅ **Warns at boot** via `assertClerkSecretKeyConfiguredForProduction` (this runbook). | `middlewares/clerkProxyMiddleware.ts`, alert tag `clerk_secret_key_missing_for_production`. |
| `SESSION_SECRET` | Per-request 5xx storms: shipping-quote signing, address-verification token signing, and KYC document encryption all throw on first use. | ✅ **Warns at boot** via `assertSessionSecretConfiguredForProduction` (this runbook). | `lib/sessionSecret.ts`, alert tag `session_secret_missing_for_production`. |
| `MFA_ENCRYPTION_KEY` | TOTP secrets silently encrypted under a `SESSION_SECRET`-derived key on a deploy that uses `REPLIT_DEPLOYMENT=1` / `DEPLOYMENT_ENVIRONMENT=production` without `NODE_ENV=production` (the existing `lib/mfa.ts` lazy throw is gated on `NODE_ENV=production` only). | ✅ **Warns at boot** via `assertMfaEncryptionKeyConfiguredForProduction` (this runbook). | `lib/mfa.ts`, alert tag `mfa_encryption_key_missing_for_production`. |
| `MFA_BACKUP_PEPPER` | Falls back to `SESSION_SECRET`, then to the constant `"dev-mfa-pepper"` — production deploys without either env var would store backup-code hashes under a hard-coded pepper. | ❌ Indirectly covered by the `SESSION_SECRET` check (the chain is `MFA_BACKUP_PEPPER ?? SESSION_SECRET ?? "dev-mfa-pepper"`); a dedicated check is a future candidate (see follow-up #94). | n/a. |
| `INTERNAL_API_KEY` | `/pudo`, `/promos`, `/referrals/payout` cross-service webhooks return `503 not_configured` — the endpoints are dead. Less severe than auth bypass (fail-closed), but a silent feature outage. | ✅ **Warns at boot** via `assertInternalApiKeyConfiguredForProduction` (this runbook). | `lib/internalApiKey.ts`, alert tag `internal_api_key_missing_for_production`. |
| `TERMII_API_KEY` | OTP issuer flips to a dev echo path that returns the OTP code in the API response — phone verification is trivially bypassable and any caller can claim any phone number. | ✅ **Warns at boot** via `assertTermiiConfiguredForProduction` (this runbook). | `lib/notifications/termii.ts`, alert tag `termii_api_key_missing_for_production`. |
| `PAYSTACK_SECRET_KEY`, `FLUTTERWAVE_SECRET_KEY`, `FLUTTERWAVE_WEBHOOK_HASH` | If neither real gateway is configured, payments fall back to `DevMockGateway` which always returns `{ ok: true }` without touching a real card; if Flutterwave is the only gateway, missing `FLUTTERWAVE_WEBHOOK_HASH` means webhooks cannot be verified (silent settlement loss). | ✅ **Warns at boot** via `assertPaymentProviderConfiguredForProduction` (this runbook). | `lib/payments.ts`, alert tag `payment_provider_missing_for_production`. |
| `SHIPBUBBLE_API_KEY`, `SHIPBUBBLE_SENDER_CODE`, `SHIPBUBBLE_WEBHOOK_SECRET` | Shipping returns three deterministic stub rates and orders ship under fake tracking numbers; missing webhook secret means inbound tracking events fail signature verification and are silently dropped. | ✅ **Warns at boot** via `assertShipbubbleConfiguredForProduction` (this runbook). | `lib/fulfillment/shipbubble.ts`, alert tag `shipbubble_credentials_missing_for_production`. |
| `MODERATION_PROVIDER` (+ `HIVE_API_KEY` or `SIGHTENGINE_API_USER`+`SIGHTENGINE_API_SECRET`; optional `PHOTODNA_API_KEY`) | Every uploaded image, stream poster, and chat message silently falls through to a substring-matching stub — no real CSAM / NSFW / hate / weapons scanning happens. The dashboard `degraded` flag is also raised, and `runModerationProviderHealthCheck` records the boot probe to the audit log. | ✅ **Warns at boot** via `assertModerationProviderConfiguredForProduction` (this runbook). | `lib/moderation.ts`, alert tag `moderation_provider_missing_for_production`. |
| `OKHI_API_KEY`, `OKHI_BRANCH_ID` | Address verification returns a deterministic stub place id with 100% confidence — the verification gate becomes trivially bypassable. The runtime production-signal guard refuses the stub at first call (5xx), but boot looks healthy until then. | ✅ **Warns at boot** via `assertOkHiConfiguredForProduction` (this runbook). | `lib/fulfillment/okhi.ts`, alert tag `okhi_credentials_missing_for_production`. |
| `CF_STREAM_API_TOKEN`, `CF_STREAM_ACCOUNT_ID` | Live streaming falls back to a deterministic stub provider (no real RTMP ingest, no playable HLS, no recording). Sellers cannot actually go live. | ❌ Silent feature degradation — covered indirectly by the `webhookConfigured` UI badge in the seller go-live page. *Future candidate (lower-severity).* | n/a. |
| `CF_STREAM_WEBHOOK_SECRET` | When the CF Stream provider IS enabled, the inbound `/api/streaming/webhooks/cloudflare` handler refuses every request with 503 — Cloudflare's "video ready" notifications are dropped and replays never get persisted from real broadcasts. | ✅ **Warns at boot** via `assertCloudflareStreamWebhookConfiguredForProduction` (this runbook). Only fires when `CF_STREAM_API_TOKEN + CF_STREAM_ACCOUNT_ID` are set; stub deploys stay silent. | `lib/streaming.ts`, alert tag `cf_stream_webhook_secret_missing_for_production`. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Web-push notifications are no-ops. | ❌ Silent feature degradation. *Future candidate (lower-severity).* | n/a. |
| `SENTRY_RELEASE` | Optional release tag — Sentry events are still captured, just not grouped by release. | n/a (optional). | n/a. |

The two remaining "future candidate" rows (`MFA_BACKUP_PEPPER`,
VAPID push keys) are intentionally out of scope: the first is fully
covered transitively by the `SESSION_SECRET` check on the chain
`MFA_BACKUP_PEPPER ?? SESSION_SECRET ?? "dev-mfa-pepper"`; the
second is a low-severity "feature is silently a no-op" rather than
a security or transactional issue.

## Boot-time presence checks added in this runbook

All three checks share the structure and conventions of the existing
hostname-pattern and rate-limit-store checks: they are pure functions
that take `env` and a `log` sink, return `{ ok: true } | { ok: false; reason }`,
log a unique message tag on warn, and never echo the secret value
itself into the structured log payload.

| Check | Helper | Lives in | Wired in `index.ts`? | Message tag |
| ----- | ------ | -------- | -------------------- | ----------- |
| SENTRY_DSN | `assertSentryDsnConfiguredForProduction` | [`artifacts/api-server/src/lib/sentry.ts`](../../artifacts/api-server/src/lib/sentry.ts) | ✅ | `sentry_dsn_missing_for_production` |
| CLERK_SECRET_KEY | `assertClerkSecretKeyConfiguredForProduction` | [`artifacts/api-server/src/middlewares/clerkProxyMiddleware.ts`](../../artifacts/api-server/src/middlewares/clerkProxyMiddleware.ts) | ✅ | `clerk_secret_key_missing_for_production` |
| SESSION_SECRET | `assertSessionSecretConfiguredForProduction` | [`artifacts/api-server/src/lib/sessionSecret.ts`](../../artifacts/api-server/src/lib/sessionSecret.ts) | ✅ | `session_secret_missing_for_production` |
| MFA_ENCRYPTION_KEY | `assertMfaEncryptionKeyConfiguredForProduction` | [`artifacts/api-server/src/lib/mfa.ts`](../../artifacts/api-server/src/lib/mfa.ts) | ✅ | `mfa_encryption_key_missing_for_production` |
| INTERNAL_API_KEY | `assertInternalApiKeyConfiguredForProduction` | [`artifacts/api-server/src/lib/internalApiKey.ts`](../../artifacts/api-server/src/lib/internalApiKey.ts) | ✅ | `internal_api_key_missing_for_production` |
| TERMII_API_KEY | `assertTermiiConfiguredForProduction` | [`artifacts/api-server/src/lib/notifications/termii.ts`](../../artifacts/api-server/src/lib/notifications/termii.ts) | ✅ | `termii_api_key_missing_for_production` |
| Payments (PAYSTACK / FLUTTERWAVE) | `assertPaymentProviderConfiguredForProduction` | [`artifacts/api-server/src/lib/payments.ts`](../../artifacts/api-server/src/lib/payments.ts) | ✅ | `payment_provider_missing_for_production` |
| OkHi (OKHI_API_KEY + OKHI_BRANCH_ID) | `assertOkHiConfiguredForProduction` | [`artifacts/api-server/src/lib/fulfillment/okhi.ts`](../../artifacts/api-server/src/lib/fulfillment/okhi.ts) | ✅ | `okhi_credentials_missing_for_production` |
| Shipbubble (API_KEY + SENDER_CODE + WEBHOOK_SECRET) | `assertShipbubbleConfiguredForProduction` | [`artifacts/api-server/src/lib/fulfillment/shipbubble.ts`](../../artifacts/api-server/src/lib/fulfillment/shipbubble.ts) | ✅ | `shipbubble_credentials_missing_for_production` |
| Cloudflare Stream webhook (CF_STREAM_WEBHOOK_SECRET, when CF_STREAM_API_TOKEN + CF_STREAM_ACCOUNT_ID are set) | `assertCloudflareStreamWebhookConfiguredForProduction` | [`artifacts/api-server/src/lib/streaming.ts`](../../artifacts/api-server/src/lib/streaming.ts) | ✅ | `cf_stream_webhook_secret_missing_for_production` |

Each helper detects production-shape via
`detectNonHostnameProductionSignals` (any of `NODE_ENV=production`,
`REPLIT_DEPLOYMENT=1`, `DEPLOYMENT_ENVIRONMENT=production`) so the
production-shape gating is consistent across all eleven checks
(these nine plus the existing rate-limit and hostname checks).

### `SENTRY_DSN`

**What:** `initSentryServer` reads `SENTRY_DSN`. If unset / empty,
the SDK is replaced with a no-op shim
(`logger.info("sentry_disabled_no_dsn")` is the only signal) and
every `captureException` / `captureMessage` call silently drops.

**Blast radius:** every alert layered on top of Sentry stops firing.
Concretely: `rate_limit_redis_failure_threshold_breached` (the fatal
page when Redis is down for the rate limiter),
`rate_limit_store_stuck_degraded` (the cron page when the store
stays degraded for too long), the per-failure `subsystem=rate_limit`
rule, audit-chain anomaly captures, and any future `Sentry.captureException`
added to the codebase. None of them reach on-call.

**Boot-time signal:** `logger.warn` with message tag
`sentry_dsn_missing_for_production` and a structured payload of
`{ node_env, replit_deployment, deployment_environment, sentry_dsn: null, production_signals }`.

**Alert wiring (LOG AGGREGATOR — canonical for this check):**

> The canonical alert for the SENTRY_DSN check **must** live in the
> log aggregator (Datadog Logs, Loki, CloudWatch Logs Insights, …),
> not in Sentry. Sentry can't tell you Sentry is off.

In Datadog Logs / Loki:

- Filter: `source:api-server message:"sentry_dsn_missing_for_production"`.
- Trigger when count > 0 over a 15-minute window.
- Route to the api-server on-call rotation; severity = sev-2.
- Annotate with a link back to this runbook.

In Sentry (backstop, only useful AFTER the DSN is restored):

- Issue alert: `level:warning message:"sentry_dsn_missing_for_production"`.
- Trigger immediately on first event seen.
- Route to the api-server on-call rotation.
- This will only catch the case where the DSN was unset for a previous
  deploy and got restored on the current one — operators reading the
  alert should treat it as "the previous deploy was flying blind for
  N hours" and cross-check the Sentry alert pipeline for missed events.

### `CLERK_SECRET_KEY`

**What:** Three code paths read `CLERK_SECRET_KEY` and silently
choose a less-secure path when it's missing:

1. `clerkProxyMiddleware()` — becomes a `next()` passthrough; the
   `/api/__clerk` proxy strips the `Clerk-Secret-Key` header and
   custom-domain auth breaks.
2. `routes/auth.ts /auth/otp/verify` — returns `{ ok: true, noClerk: true }`
   without provisioning a Clerk user, so the "verified" session is a
   stub that other auth-aware handlers will reject.
3. `lib/socket.ts` Socket.IO middleware — skips token verification
   and joins every connection as an anonymous viewer; seller / admin
   identity is silently absent on every socket.

**Blast radius:** real auth regression on the entire production
deploy, dressed up as normal-looking sessions and connections.

**Boot-time signal:** `logger.warn` with message tag
`clerk_secret_key_missing_for_production` and a structured payload of
`{ node_env, replit_deployment, deployment_environment, clerk_secret_key: null, production_signals }`.

The structured payload **never** contains the key value (even if the
slot is set to a whitespace string, the log shows the sentinel
`"[set-but-empty]"`). The same goes for the human-readable `reason`
string returned to the caller — only the failure mode and the env
var name are surfaced.

**Alert wiring (Sentry — primary):**

In Sentry:

- Issue alert: `level:warning message:"clerk_secret_key_missing_for_production"`.
- Trigger immediately on first event seen.
- Route to the api-server on-call rotation; severity = sev-1 (auth
  regression).
- Annotate with a link back to this runbook.

In the log aggregator (backstop in case Sentry is also down — see
the `SENTRY_DSN` interaction above):

- Filter: `source:api-server message:"clerk_secret_key_missing_for_production"`.
- Trigger when count > 0 over a 5-minute window.
- Route to the api-server on-call rotation; severity = sev-1.

### `SESSION_SECRET`

**What:** `SESSION_SECRET` is the HMAC / encryption key for several
security-critical primitives:

- `lib/kyc.ts deriveDocKey` — encrypts uploaded KYC documents at
  rest under AES-256-GCM. Throws `"SESSION_SECRET must be set and >= 16 chars
  to encrypt KYC documents"` on every upload.
- `lib/fulfillment/quoteToken.ts` — signs the shipping-quote tokens
  whose `priceMinor` is the only number we trust at `POST /orders`.
  Throws `"SESSION_SECRET is required to sign shipping quotes"`.
- `lib/fulfillment/verifyToken.ts` — signs the address-verification
  token. Throws `"SESSION_SECRET is required (>=16 chars) to issue/verify
  address tokens"`.
- `lib/mfa.ts` — used as a dev-only fallback for the AES key and the
  backup-code pepper. Production deploys missing both `MFA_BACKUP_PEPPER`
  and `SESSION_SECRET` would store backup-code hashes under a hard-coded
  pepper.

Each consumer fails closed at the first request that needs the
secret, so the misconfiguration is **not silently exploitable** —
but the failure mode is per-request 5xx storms (KYC uploads bounce,
checkout breaks, address verification fails) rather than a clean
operator-facing alert. By the time those errors page on-call from
Sentry, every buyer mid-checkout has already seen a "shipping quote
unavailable" toast.

**Boot-time signal:** `logger.warn` with message tag
`session_secret_missing_for_production` and a structured payload of
`{ node_env, replit_deployment, deployment_environment, session_secret_condition, session_secret_length, production_signals }`.

`session_secret_condition` is one of `"unset"`, `"empty"`, or
`"too_short"`; `session_secret_length` is the trimmed length. The
secret value itself is **never** logged or surfaced into the `reason`
string. The 16-character minimum mirrors the `s.length < 16` runtime
guards in `kyc.ts` and `fulfillment/verifyToken.ts`.

**Alert wiring (Sentry — primary):**

In Sentry:

- Issue alert: `level:warning message:"session_secret_missing_for_production"`.
- Trigger immediately on first event seen.
- Route to the api-server on-call rotation; severity = sev-1
  (checkout / KYC outage imminent on first user request).
- Annotate with a link back to this runbook.

In the log aggregator (backstop):

- Filter: `source:api-server message:"session_secret_missing_for_production"`.
- Trigger when count > 0 over a 5-minute window.
- Route to the api-server on-call rotation; severity = sev-1.

### `MFA_ENCRYPTION_KEY`

**What:** `lib/mfa.ts encryptionKey()` already throws
`"MFA_ENCRYPTION_KEY is required in production"` lazily on the first
MFA enrollment / verification when `NODE_ENV === "production"` and
the env var is unset. Two gaps:

1. The throw is gated on `NODE_ENV === "production"` only — a deploy
   that uses `REPLIT_DEPLOYMENT=1` / `DEPLOYMENT_ENVIRONMENT=production`
   without `NODE_ENV=production` would silently encrypt TOTP secrets
   under a `SESSION_SECRET`-derived key. That makes MFA secrets only
   as strong as `SESSION_SECRET` on those deploys.
2. Even on a `NODE_ENV=production` deploy the failure mode is lazy —
   boot looks healthy, then the next user attempting to enroll MFA
   gets a 5xx and on-call only finds out via a Sentry capture from
   inside the route handler.

**Blast radius:** TOTP secret confidentiality on every newly enrolled
factor is silently downgraded; the eventual lazy throw is a 5xx storm
on the MFA enrollment flow.

**Boot-time signal:** `logger.warn` with message tag
`mfa_encryption_key_missing_for_production` and a structured payload
of `{ node_env, replit_deployment, deployment_environment, mfa_encryption_key: null|"[set-but-empty]", production_signals }`.
The secret value itself is **never** logged.

**Alert wiring (Sentry — primary):**

In Sentry:

- Issue alert: `level:warning message:"mfa_encryption_key_missing_for_production"`.
- Trigger immediately on first event seen.
- Route to the api-server on-call rotation; severity = sev-1 (MFA
  secret confidentiality regression).
- Annotate with a link back to this runbook.

In the log aggregator (backstop in case Sentry is also down):

- Filter: `source:api-server message:"mfa_encryption_key_missing_for_production"`.
- Trigger when count > 0 over a 5-minute window.
- Route to the api-server on-call rotation; severity = sev-1.

### `INTERNAL_API_KEY`

**What:** `INTERNAL_API_KEY` is the shared bearer for cross-service
callers on three sets of routes — `routes/pudo.ts` (PUDO partner
manifest / scan webhooks), `routes/promos.ts` (promo activation
webhooks), `routes/referrals.ts` (settlement webhooks). Each route
returns `503 not_configured` when the key is unset.

**Blast radius:** fail-closed (no auth bypass) but every cross-
service webhook into the api-server starts 503-ing. Promos don't
activate, referrals don't pay out, PUDO partner scans don't reach
the order. The 503 looks like a normal fail-closed response from the
partner's perspective; on-call only finds out when a partner
complains or when downstream metrics (e.g. promo redemption count)
drop to zero.

**Boot-time signal:** `logger.warn` with message tag
`internal_api_key_missing_for_production` and a structured payload
of `{ node_env, replit_deployment, deployment_environment, internal_api_key: null|"[set-but-empty]", production_signals }`.
The key value itself is **never** logged.

**Alert wiring (Sentry — primary):**

In Sentry:

- Issue alert: `level:warning message:"internal_api_key_missing_for_production"`.
- Trigger immediately on first event seen.
- Route to the api-server on-call rotation; severity = sev-2 (silent
  feature outage on partner integrations).
- Annotate with a link back to this runbook.

In the log aggregator (backstop):

- Filter: `source:api-server message:"internal_api_key_missing_for_production"`.
- Trigger when count > 0 over a 5-minute window.
- Route to the api-server on-call rotation; severity = sev-2.

### `TERMII_API_KEY`

**What:** `lib/notifications/termii.ts` falls back to a `devEcho`
issuer when `TERMII_API_KEY` is unset. The dev issuer returns the
generated OTP code in the API response, so the phone-verification
challenge becomes trivially bypassable — any caller can claim any
phone number by reading the OTP back from their own request response.

**Blast radius:** SECURITY-CRITICAL. The phone-verification gate is
the foundation of OTP-based account creation, password reset, and
sensitive action confirmation. A production deploy without this key
is effectively running with no phone verification at all.

**Boot-time signal:** `logger.warn` with message tag
`termii_api_key_missing_for_production` and a structured payload of
`{ node_env, replit_deployment, deployment_environment, termii_api_key: null|"[set-but-empty]", production_signals }`.
The key value itself is **never** logged.

**Alert wiring (Sentry — primary):**

In Sentry:

- Issue alert: `level:warning message:"termii_api_key_missing_for_production"`.
- Trigger immediately on first event seen.
- Route to the api-server on-call rotation; severity = sev-1 (auth
  regression, OTP bypass).
- Annotate with a link back to this runbook.

In the log aggregator (backstop):

- Filter: `source:api-server message:"termii_api_key_missing_for_production"`.
- Trigger when count > 0 over a 5-minute window.
- Route to the api-server on-call rotation; severity = sev-1.

### Payments (`PAYSTACK_SECRET_KEY` / `FLUTTERWAVE_SECRET_KEY` / `FLUTTERWAVE_WEBHOOK_HASH`)

**What:** `lib/payments.ts selectPrimaryAndSecondary` selects the
`DevMockGateway` for both gateway slots when neither
`PAYSTACK_SECRET_KEY` nor `FLUTTERWAVE_SECRET_KEY` is set. The
mock gateway always returns `{ ok: true }` without touching a real
card. On a production deploy that means **buyers cannot actually
pay**: the checkout flow appears to succeed (and order rows are
created), but no real authorization has happened. The
`payments_initialized` info log surfaces `mode: "dev-mock"` at boot
but that's exactly the kind of one-line boot signal that gets lost
in normal startup chatter.

The check also warns when only `FLUTTERWAVE_SECRET_KEY` is set
without `FLUTTERWAVE_WEBHOOK_HASH` — the gateway will accept charges
but cannot verify webhooks (silent settlement loss; spoofed or
dropped settlement events go undetected).

**Blast radius:** revenue. Either no real payments at all, or
unverifiable settlement events.

**Boot-time signal:** `logger.warn` with message tag
`payment_provider_missing_for_production` and a structured payload
of `{ node_env, replit_deployment, deployment_environment, paystack_secret_key, flutterwave_secret_key, flutterwave_webhook_hash, missing, production_signals }`.
None of the secret values are ever logged — the slot is either `null`,
`"[set]"`, or `"[set-but-empty]"`.

**Alert wiring (Sentry — primary):**

In Sentry:

- Issue alert: `level:warning message:"payment_provider_missing_for_production"`.
- Trigger immediately on first event seen.
- Route to the api-server on-call rotation; severity = sev-1
  (revenue impact, fraud risk).
- Annotate with a link back to this runbook.

In the log aggregator (backstop):

- Filter: `source:api-server message:"payment_provider_missing_for_production"`.
- Trigger when count > 0 over a 5-minute window.
- Route to the api-server on-call rotation; severity = sev-1.

### OkHi (`OKHI_API_KEY` + `OKHI_BRANCH_ID`)

**What:** `lib/fulfillment/okhi.ts isConfigured()` only returns
`true` when both `OKHI_API_KEY` and `OKHI_BRANCH_ID` are set. The
runtime production-signal `allowStubFallback()` guard refuses to
substitute the stub at runtime when production-shape is detected —
so a real-call failure on a misconfigured production deploy fails
closed (5xx) at the first address-verification call. Boot looks
healthy until then.

**Blast radius:** every buyer who reaches the address-verification
step sees a 5xx until the keys are set.

**Boot-time signal:** `logger.warn` with message tag
`okhi_credentials_missing_for_production` and a structured payload
of `{ node_env, replit_deployment, deployment_environment, okhi_api_key, okhi_branch_id, missing, production_signals }`.
The credential values themselves are **never** logged.

**Alert wiring (Sentry — primary):**

In Sentry:

- Issue alert: `level:warning message:"okhi_credentials_missing_for_production"`.
- Trigger immediately on first event seen.
- Route to the api-server on-call rotation; severity = sev-2.
- Annotate with a link back to this runbook.

In the log aggregator (backstop):

- Filter: `source:api-server message:"okhi_credentials_missing_for_production"`.
- Trigger when count > 0 over a 5-minute window.
- Route to the api-server on-call rotation; severity = sev-2.

### Shipbubble (`SHIPBUBBLE_API_KEY` + `SHIPBUBBLE_SENDER_CODE` + `SHIPBUBBLE_WEBHOOK_SECRET`)

**What:**

- Without `SHIPBUBBLE_API_KEY` the carrier returns three
  deterministic stub service tiers (standard / express / same-day)
  priced from a small linear function of declared value + weight.
  The runtime `allowStubFallback()` production-signal guard refuses
  to substitute the stub at runtime when production-shape is
  detected AND keys are configured — but a deploy that never set
  the keys at all bypasses that guard entirely. The stub IS the
  carrier on a misconfigured production deploy: buyers see fake
  rates and orders ship under fake tracking numbers.
- Without `SHIPBUBBLE_SENDER_CODE` real Shipbubble dispatches
  return 4xx but the misconfiguration only surfaces at the first
  dispatch attempt.
- Without `SHIPBUBBLE_WEBHOOK_SECRET` the webhook handler in
  `routes/fulfillmentWebhooks.ts` cannot verify the
  `x-shipbubble-signature` header on inbound tracking webhooks and
  tracking events are silently dropped.

**Blast radius:** revenue + customer trust (fake tracking numbers
on real orders); silent loss of tracking events.

**Boot-time signal:** `logger.warn` with message tag
`shipbubble_credentials_missing_for_production` and a structured
payload of `{ node_env, replit_deployment, deployment_environment, shipbubble_api_key, shipbubble_sender_code, shipbubble_webhook_secret, missing, production_signals }`.
None of the secret values are ever logged — the slot is either
`null` or `"[set]"`.

**Alert wiring (Sentry — primary):**

In Sentry:

- Issue alert: `level:warning message:"shipbubble_credentials_missing_for_production"`.
- Trigger immediately on first event seen.
- Route to the api-server on-call rotation; severity = sev-1
  (orders ship under fake tracking numbers).
- Annotate with a link back to this runbook.

In the log aggregator (backstop):

- Filter: `source:api-server message:"shipbubble_credentials_missing_for_production"`.
- Trigger when count > 0 over a 5-minute window.
- Route to the api-server on-call rotation; severity = sev-1.

### Cloudflare Stream (`CF_STREAM_WEBHOOK_SECRET`, when `CF_STREAM_API_TOKEN` + `CF_STREAM_ACCOUNT_ID` are set)

**What:**

- Without `CF_STREAM_API_TOKEN` + `CF_STREAM_ACCOUNT_ID` the streaming
  provider falls back to a deterministic stub (no real RTMP ingest, no
  playable HLS, no recording). This is the dev / staging default and
  is intentionally tolerated on production-shaped boots — a deploy
  that hasn't migrated off the stub yet shouldn't see a noisy boot
  warn for a webhook secret it can't yet use.
- When the CF Stream provider IS enabled, missing
  `CF_STREAM_WEBHOOK_SECRET` causes the inbound
  `/api/streaming/webhooks/cloudflare` handler to refuse every request
  with `503 webhook_secret_not_configured`. Cloudflare's "video
  ready" notifications are dropped, so the replay row + `cf_video_uid`
  + `hls_url` columns on the stream are never persisted. The
  best-effort poll-on-stop fallback in
  `lib/replayPersist.ts:persistReplayForEndedStream` only catches the
  case where the recording has already finalized at CF by the time the
  seller hits stop, which is unreliable for any non-trivial broadcast.
- The shared secret is provisioned by calling
  `PUT /accounts/{account}/stream/webhook` with the public-facing
  webhook URL — Cloudflare returns the secret string in the response.
  Store it as `CF_STREAM_WEBHOOK_SECRET` in the deploy's secret
  store; never commit it.

**Blast radius:** silent loss of every recorded broadcast on a real
production deploy that has otherwise migrated to the Cloudflare
provider. The seller and viewer-facing live experience still works,
so the misconfiguration only surfaces when a buyer tries to watch a
replay (or never does).

**Boot-time signal:** `logger.warn` with message tag
`cf_stream_webhook_secret_missing_for_production` and a structured
payload of `{ node_env, replit_deployment, deployment_environment, cf_stream_api_token, cf_stream_account_id, cf_stream_webhook_secret, production_signals }`.
None of the secret values are ever logged — `cf_stream_webhook_secret`
is always `null` (because that's the failure case being warned), and
`cf_stream_api_token` / `cf_stream_account_id` are reported as `"[set]"`.

**Alert wiring (Sentry — primary):**

In Sentry:

- Issue alert: `level:warning message:"cf_stream_webhook_secret_missing_for_production"`.
- Trigger immediately on first event seen.
- Route to the api-server on-call rotation; severity = sev-2
  (silent feature degradation — replays don't persist, but live
  ingest still works).
- Annotate with a link back to this runbook.

In the log aggregator (backstop):

- Filter: `source:api-server message:"cf_stream_webhook_secret_missing_for_production"`.
- Trigger when count > 0 over a 5-minute window.
- Route to the api-server on-call rotation; severity = sev-2.

### `MODERATION_PROVIDER` (+ `HIVE_API_KEY` / `SIGHTENGINE_API_USER`+`SIGHTENGINE_API_SECRET`; optional `PHOTODNA_API_KEY`)

**What:** `selectProvider()` in
[`lib/moderation.ts`](../../artifacts/api-server/src/lib/moderation.ts)
reads `MODERATION_PROVIDER` and chooses one of three implementations:

- `stub` (or unset): substring-matching dev/CI provider. Only matches
  the literal `FLAG_BLOCK` / `FLAG_REVIEW` test markers and a handful
  of obvious phrases — every other upload, stream poster, and chat
  message is treated as `allow`.
- `hive`: Hive Moderation REST API
  (`https://api.thehive.ai/api/v2/task/sync`). Requires `HIVE_API_KEY`;
  scans NSFW / weapons / drugs / hate / gore / CSAM-hash. Image scans
  fail-CLOSED-to-review on network failure; text scans fail-OPEN
  (chat would otherwise be unusable on a Hive outage).
- `sightengine`: Sightengine REST API
  (`https://api.sightengine.com/1.0/check.json` +
  `text/check.json`). Requires `SIGHTENGINE_API_USER`,
  `SIGHTENGINE_API_SECRET`, AND `PHOTODNA_API_KEY` on production.
  Sightengine does NOT expose the NCMEC hash list, so PhotoDNA is
  the only CSAM signal when this provider is chosen — the boot
  guard treats `MODERATION_PROVIDER=sightengine` without
  `PHOTODNA_API_KEY` as a misconfiguration and emits a distinct
  warn (`PHOTODNA_API_KEY is unset … Sightengine does not expose
  the NCMEC hash list`). The dashboard `degraded` flag also flips
  with `degradedReason = csam_coverage_missing_photodna_required_for_sightengine`.

PhotoDNA (`PHOTODNA_API_KEY`) is layered on top of whichever provider
is active. When set, every `scanImage` call additionally hits the
Microsoft PhotoDNA Cloud Service `/v1.0/Match` endpoint — the
gold-standard NCMEC-aligned hash matcher and the only signal that
satisfies the South African Films & Publications Act mandatory CSAM
reporting requirement.

If `MODERATION_PROVIDER` is unset, set to `stub`, set to a value
whose required credentials are missing, or set to an unimplemented
value, `selectProvider()` falls back to the substring stub and sets
`degradedReason` so the admin dashboard shows a prominent red banner
(`data-testid="moderation-degraded-banner"`).

**Blast radius:** every uploaded image (listings, KYC, profile),
every video stream poster, every chat message, every report-as-
"content" trace silently passes the moderation gate. CSAM, NSFW,
hate, and weapons content reach the marketplace.

**Boot-time signal:** `logger.warn` with message tag
`moderation_provider_missing_for_production` and a structured
payload of `{ node_env, replit_deployment, deployment_environment, moderation_provider, hive_api_key_set, sightengine_api_user_set, sightengine_api_secret_set, photodna_api_key_set, production_signals }`.
None of the secret values are ever logged — the slot is the literal
boolean `true` / `false` indicating presence.

`runModerationProviderHealthCheck()` (called from
[`src/app.ts`](../../artifacts/api-server/src/app.ts) after
`initAuditChain()`) additionally probes the active provider's
`getHealth()` and writes the outcome to the audit log under action
`moderation.provider_health_check`. Operators can audit the boot
state of the moderation pipeline alongside every other compliance
event.

**Alert wiring (Sentry — primary):**

In Sentry:

- Issue alert: `level:warning message:"moderation_provider_missing_for_production"`.
- Trigger immediately on first event seen.
- Route to the api-server on-call rotation; severity = sev-1
  (regulatory + brand risk: unscanned uploads include CSAM exposure).
- Annotate with a link back to this runbook.

In the log aggregator (backstop):

- Filter: `source:api-server message:"moderation_provider_missing_for_production"`.
- Trigger when count > 0 over a 5-minute window.
- Route to the api-server on-call rotation; severity = sev-1.

In the audit log (forensics):

- Query for `action = 'moderation.provider_health_check'` to see the
  per-boot health probe outcome (`provider`, `degraded`,
  `degradedReason`, `health.ok`, `photoDna.ok`, `latencyMs`).

## What to do when one of these alerts fires

1. **Confirm the deploy is production-shaped.** The structured log
   payload includes `production_signals` — check that at least one of
   `node_env`, `replit_deployment`, `deployment_environment` is the
   production value. False positives here would mean
   `detectNonHostnameProductionSignals` is mis-detecting; see
   [`lib/productionSignals.ts`](../../artifacts/api-server/src/lib/productionSignals.ts).
2. **Set the missing env var on the deployment platform.** Each
   alert's `reason` string names the exact env var and points back to
   this runbook section. Use the project-level secret store; do not
   inline the value in workflow YAML or the `.replit` file.
3. **Redeploy.** All three checks run at boot, so the alert will not
   re-fire on the next deploy if the secret is now set.
4. **Backfill what was lost while the secret was missing:**
   - SENTRY_DSN: nothing to backfill, but cross-check Sentry for any
     missed alerts during the gap window — every layer that depends
     on Sentry was silent.
   - CLERK_SECRET_KEY: any session created via `/auth/otp/verify`
     during the gap window is a `noClerk: true` stub and will be
     rejected by other handlers. Audit the `users` table for rows
     created with `phoneVerifiedAt` set but without a matching Clerk
     id.
   - SESSION_SECRET: KYC uploads / quote requests / address verifies
     during the gap window will already have 5xx-ed; no backfill
     needed (the consumers fail closed).

## Validation

Each new check has a unit test that covers the staging-skipped,
production-warned (each production signal individually + aggregated),
and configured-silent paths, plus a "secret value is never echoed
into the log payload" check:

- [`artifacts/api-server/src/lib/sentry.test.ts`](../../artifacts/api-server/src/lib/sentry.test.ts)
- [`artifacts/api-server/src/middlewares/clerkProxyMiddleware.test.ts`](../../artifacts/api-server/src/middlewares/clerkProxyMiddleware.test.ts)
- [`artifacts/api-server/src/lib/sessionSecret.test.ts`](../../artifacts/api-server/src/lib/sessionSecret.test.ts)
- [`artifacts/api-server/src/lib/mfa.assert.test.ts`](../../artifacts/api-server/src/lib/mfa.assert.test.ts)
- [`artifacts/api-server/src/lib/internalApiKey.test.ts`](../../artifacts/api-server/src/lib/internalApiKey.test.ts)
- [`artifacts/api-server/src/lib/notifications/termii.test.ts`](../../artifacts/api-server/src/lib/notifications/termii.test.ts)
- [`artifacts/api-server/src/lib/payments.assert.test.ts`](../../artifacts/api-server/src/lib/payments.assert.test.ts)
- [`artifacts/api-server/src/lib/fulfillment/okhi.test.ts`](../../artifacts/api-server/src/lib/fulfillment/okhi.test.ts)
- [`artifacts/api-server/src/lib/fulfillment/shipbubble.assert.test.ts`](../../artifacts/api-server/src/lib/fulfillment/shipbubble.assert.test.ts)

Run with:

```sh
pnpm --filter @workspace/api-server run test
```
