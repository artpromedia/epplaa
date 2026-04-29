import { createServer } from "node:http";
import { logger } from "./lib/logger";
import { assertStubFulfillmentSafe } from "./lib/fulfillment/bootGuard";
import { assertOkHiConfiguredForProduction } from "./lib/fulfillment/okhi";
import { assertShipbubbleConfiguredForProduction } from "./lib/fulfillment/shipbubble";
import { assertCloudflareStreamWebhookConfiguredForProduction } from "./lib/streaming";
import { assertInternalApiKeyConfiguredForProduction } from "./lib/internalApiKey";
import { assertMfaEncryptionKeyConfiguredForProduction } from "./lib/mfa";
import { assertModerationProviderConfiguredForProduction } from "./lib/moderation";
import { assertTermiiConfiguredForProduction } from "./lib/notifications/termii";
import { assertPaymentProviderConfiguredForProduction } from "./lib/payments";
import { assertSentryDsnConfiguredForProduction } from "./lib/sentry";
import { assertSessionSecretConfiguredForProduction } from "./lib/sessionSecret";
import { assertRateLimitStoreConfiguredForProduction } from "./middlewares/apiRateLimit";
import { assertClerkSecretKeyConfiguredForProduction } from "./middlewares/clerkProxyMiddleware";
import {
  assertProductionHostnamePatternConfigured,
  assertRehearsalKillSwitchSafe,
} from "./routes/healthzRehearsal";

// Defense-in-depth: refuse to boot if the staging-only rehearsal
// injector kill switch (HEALTHZ_REHEARSAL_ENABLED=1) is observed in a
// production environment. The route itself is also gated at request
// time, but a copy-paste of staging env vars into production would
// silently expose `/api/_rehearsal/inject-stuck-degraded` and let a
// leaked URL page real on-call. Failing fast here turns a process
// control into a technical control. See
// `docs/runbooks/rate-limit-store.md` (boot-time guard).
//
// IMPORTANT: this check runs before importing `./app` and
// `./lib/socket`. Importing `./app` triggers schema-init and
// scheduler side effects (initAuditChain / initAdminSchema /
// initManufacturerSchema, etc. — see `src/app.ts`). Running the
// guard first means a misconfigured production deploy fails fast
// without spinning up DB/scheduler work it shouldn't be doing.
const rehearsalGuard = assertRehearsalKillSwitchSafe(process.env, logger);
if (!rehearsalGuard.ok) {
  process.exit(1);
}

// Boot-time sanity check (task #84): on production-shaped deploys
// (NODE_ENV=production / REPLIT_DEPLOYMENT=1 / DEPLOYMENT_ENVIRONMENT=production),
// warn loudly if PRODUCTION_HOSTNAME_PATTERN is missing. The hostname
// signal in `assertRehearsalKillSwitchSafe` is the strongest backstop
// against a copy-pasted staging env into production, but it's silently
// absent if no operator ever configured the regex. The runbook
// recommends setting it; this check turns that recommendation into an
// automated boot-time signal so the misconfiguration shows up in
// log aggregators / Sentry instead of waiting for a real outage. The
// outcome is intentionally NOT used to abort boot — the other guard
// layers above still work without the hostname backstop, and crash-
// looping every existing production deploy that never set this env
// var would be more disruptive than the marginal security gain.
assertProductionHostnamePatternConfigured(process.env, logger);

// Boot-time hard failure (task #90, graduated from the task #87 warning):
// on production-shaped deploys (NODE_ENV=production /
// REPLIT_DEPLOYMENT=1 / DEPLOYMENT_ENVIRONMENT=production), refuse to
// start if RATE_LIMIT_STORE is unset / "memory" / typo'd. The runbook
// (`docs/runbooks/rate-limit-store.md`) explicitly says
// `RATE_LIMIT_STORE=redis` is required for any deploy with more than
// one api-server replica — the in-process bucket is replica-local, so
// each replica owns its own counters and the per-tier rate limit is
// trivially bypassed by spreading traffic across replicas. Now that
// managed Redis is provisioned for every shipping production deploy
// and the Sentry alert on the original warning has been clean for the
// stabilisation window, the check has been graduated to a hard boot
// failure so a future env-var rotation can't silently re-introduce
// the bypassable per-process bucket. Mirrors how
// `assertRehearsalKillSwitchSafe` is already a hard failure above.
//
// Legitimate single-replica production deploys (canary, internal-only
// tools) that intentionally run on the in-process bucket can opt out
// by setting `RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION=1` —
// `assertRateLimitStoreConfiguredForProduction` then downgrades to a
// loud warn keyed off `rate_limit_store_memory_in_production_via_opt_out`
// so on-call still sees the bypassable bucket but boot proceeds. See
// `docs/runbooks/rate-limit-store.md` (boot-time presence check) for
// when the escape hatch is appropriate.
const rateLimitStoreGuard = assertRateLimitStoreConfiguredForProduction(
  process.env,
  logger,
);
if (!rateLimitStoreGuard.ok) {
  process.exit(1);
}

// Boot-time hard failure (task #88): refuse to boot if the carrier
// stub-fallback escape hatch (STUB_FULFILLMENT=1) is observed in a
// production environment. Task #83 already added a per-request guard
// inside each carrier (`lib/fulfillment/{gig,okhi,shipbubble}.ts`)
// that refuses to substitute synthetic carrier data on real-call
// failure when any production signal is observed, but that guard is
// reactive — a misconfigured production deploy would silently boot
// and only surface the misconfiguration the first time a real
// carrier call fails (potentially mid-checkout for a real buyer).
// Failing here turns the per-request runtime guard into an additional
// technical control on the deploy pipeline, mirroring how
// `assertRehearsalKillSwitchSafe` is already a hard failure above.
// See `docs/runbooks/staging-only-endpoints.md` (boot-time guard).
const stubFulfillmentGuard = assertStubFulfillmentSafe(process.env, logger);
if (!stubFulfillmentGuard.ok) {
  process.exit(1);
}

// Boot-time sanity check (task #91): on production-shaped deploys,
// warn loudly if SENTRY_DSN is unset. Without a DSN, initSentryServer
// silently swaps the SDK for a no-op and every captureException call
// becomes a drop — meaning every alert layered on top of Sentry
// (rate_limit_redis_failure_threshold_breached, audit-chain anomaly
// captures, etc.) is dead at the source. The runbook
// (`docs/runbooks/production-secrets.md`) recommends configuring it
// on every production deploy; this check turns that recommendation
// into an automated boot-time signal. Warning, not a hard failure —
// crash-looping every deploy that hasn't yet wired Sentry would be
// more disruptive than the marginal observability gain. The
// canonical alert for THIS specific check has to live in the log
// aggregator (not Sentry) — Sentry can't tell you Sentry is off.
assertSentryDsnConfiguredForProduction(process.env, logger);

// Boot-time sanity check (task #91): on production-shaped deploys,
// warn loudly if CLERK_SECRET_KEY is unset. Three code paths silently
// fall back to insecure defaults when missing: the /api/__clerk
// proxy strips the secret-key header, /auth/otp/verify returns a
// noClerk stub that never provisions a Clerk user, and Socket.IO
// connections skip token verification and join as anonymous viewers.
// The runbook (`docs/runbooks/production-secrets.md`) covers how to
// wire the alert. Warning, not a hard failure — a brand-new
// production deploy may legitimately ship with auth disabled while
// it's being stood up.
assertClerkSecretKeyConfiguredForProduction(process.env, logger);

// Boot-time sanity check (task #91): on production-shaped deploys,
// warn loudly if SESSION_SECRET is unset / too short (< 16 chars).
// SESSION_SECRET signs shipping-quote and address-verification
// tokens and encrypts KYC documents at rest. Each consumer fails
// closed at first use, so the misconfiguration is not silently
// exploitable, but the failure mode is per-request 5xx storms
// (KYC uploads bounce, checkout breaks) rather than a clean
// operator-facing alert. The runbook
// (`docs/runbooks/production-secrets.md`) covers how to wire the
// alert. Warning, not a hard failure — the per-request throws at
// the consumer sites are still the hard fail-closed control.
assertSessionSecretConfiguredForProduction(process.env, logger);

// Boot-time sanity check (task #91): on production-shaped deploys,
// warn loudly if MFA_ENCRYPTION_KEY is unset. The lib/mfa.ts
// encryptionKey() lazy throw is gated on NODE_ENV=production ONLY,
// so a deploy that uses REPLIT_DEPLOYMENT=1 / DEPLOYMENT_ENVIRONMENT=production
// without NODE_ENV=production would silently encrypt TOTP secrets
// under a SESSION_SECRET-derived key. See
// docs/runbooks/production-secrets.md.
assertMfaEncryptionKeyConfiguredForProduction(process.env, logger);

// Boot-time sanity check (task #91): on production-shaped deploys,
// warn loudly if INTERNAL_API_KEY is unset. The /pudo, /promos, and
// /referrals/payout cross-service webhooks all return 503
// not_configured to every caller — fail-closed (no auth bypass) but
// partner integrations stop working until the key is set. See
// docs/runbooks/production-secrets.md.
assertInternalApiKeyConfiguredForProduction(process.env, logger);

// Boot-time sanity check (task #91): on production-shaped deploys,
// warn loudly if TERMII_API_KEY is unset. The OTP issuer flips into
// devEcho mode and returns the OTP code in the API response — every
// phone OTP becomes trivially bypassable. SECURITY-CRITICAL. See
// docs/runbooks/production-secrets.md.
assertTermiiConfiguredForProduction(process.env, logger);

// Boot-time sanity check (task #91): on production-shaped deploys,
// warn loudly if neither PAYSTACK_SECRET_KEY nor FLUTTERWAVE_SECRET_KEY
// is set, or if Flutterwave is the only gateway and
// FLUTTERWAVE_WEBHOOK_HASH is unset. Without real gateway keys
// lib/payments.ts falls back to DevMockGateway and buyers cannot
// actually pay (checkout appears to succeed but no real authorization).
// See docs/runbooks/production-secrets.md.
assertPaymentProviderConfiguredForProduction(process.env, logger);

// Boot-time sanity check (task #91): on production-shaped deploys,
// warn loudly if OkHi creds (OKHI_API_KEY + OKHI_BRANCH_ID) are
// unset. The runtime allowStubFallback() guard fails the next
// address-verification call closed, but boot looks healthy until
// then — every buyer who reaches the address-verification step sees
// a 5xx. See docs/runbooks/production-secrets.md.
assertOkHiConfiguredForProduction(process.env, logger);

// Boot-time sanity check (task #91): on production-shaped deploys,
// warn loudly if Shipbubble creds (SHIPBUBBLE_API_KEY +
// SHIPBUBBLE_SENDER_CODE + SHIPBUBBLE_WEBHOOK_SECRET) are unset.
// Without the API key the carrier returns deterministic stub rates
// and orders ship under fake tracking numbers; without the webhook
// secret inbound tracking events fail signature verification and are
// silently dropped. See docs/runbooks/production-secrets.md.
assertShipbubbleConfiguredForProduction(process.env, logger);

// Boot-time sanity check (Task #23): on production-shaped deploys with
// the Cloudflare Stream provider enabled (CF_STREAM_API_TOKEN +
// CF_STREAM_ACCOUNT_ID set), warn loudly if CF_STREAM_WEBHOOK_SECRET
// is unset. Without the shared secret the inbound CF webhook handler
// refuses every request with 503, so video-ready notifications are
// dropped and replays never get persisted from real broadcasts (the
// stop-endpoint poll fallback in lib/replayPersist.ts only catches the
// case where the recording has already finalized by the time the
// seller hits stop, which is unreliable). Warning, not a hard failure
// — a deploy that intentionally hasn't migrated off the stub provider
// shouldn't crash on this. See docs/runbooks/production-secrets.md.
assertCloudflareStreamWebhookConfiguredForProduction(process.env, logger);

// Boot-time sanity check (task #27): on production-shaped deploys,
// warn loudly if MODERATION_PROVIDER is unset / `stub`, or if the
// chosen provider is missing its credentials (HIVE_API_KEY for hive,
// SIGHTENGINE_API_USER + SIGHTENGINE_API_SECRET for sightengine).
// Without a real provider every uploaded image, stream poster, and
// chat message silently falls through to the substring stub — no
// real CSAM / NSFW / hate / weapons scanning runs. The dashboard
// surfaces the `degraded` flag, `runModerationProviderHealthCheck`
// in `app.ts` records the boot probe to the audit log, and the
// warn-tag `moderation_provider_missing_for_production` is the
// canonical alert. See docs/runbooks/production-secrets.md.
assertModerationProviderConfiguredForProduction(process.env, logger);

// Test-only affordance for `src/index.boot.test.ts` (task #92). When set
// to the exact sentinel value below, the entrypoint exits cleanly AFTER
// all boot-time guards have run but BEFORE the PORT check /
// `await import("./app")` (which would otherwise require DATABASE_URL
// and trigger schema/scheduler side effects). This is the only way to
// assert the opt-out path
// (`RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION=1`) reaches an exit-0
// state without spinning up the full app on the test runner.
//
// The check is intentionally placed AFTER all boot-time guards (the
// hard-exit guards above and the warning-only secret asserts from
// task #91) so a future refactor that drops the exit on a guard
// failure or reorders the guards is still caught — the spawn test
// for the failing-guard cases sees exit code 1 from the guard, not
// exit code 0 from this affordance. Placing the sentinel last also
// ensures the test exercises every boot-time check before exit, so
// regressions in the warning asserts surface in the boot test too.
//
// Defense-in-depth against accidental production misuse:
//   1. The env var name is double-underscored so it can't be confused
//      with a real operator-facing knob.
//   2. The trigger value is NOT "1" / "true" — it's a cryptic literal
//      that an operator would never type by accident or copy from a
//      runbook (the only place it appears outside this file is the
//      spawn-based test).
//   3. If it ever DOES fire, we emit a structured `error`-level log
//      with a stable tag so any log aggregator / Sentry forwarder
//      sees it immediately. An operator who accidentally set this in
//      a real deploy would notice the missing HTTP listener within
//      one platform health check, but the explicit log makes the
//      cause unambiguous instead of a silent "process exited 0".
const BOOT_GUARDS_ONLY_SENTINEL =
  "test-only-exit-after-boot-guards-do-not-set-in-production";
if (
  process.env["__EPPLAA_BOOT_GUARDS_ONLY"] === BOOT_GUARDS_ONLY_SENTINEL
) {
  logger.error(
    {
      env_var: "__EPPLAA_BOOT_GUARDS_ONLY",
      pid: process.pid,
    },
    "boot_guards_only_test_affordance_triggered: " +
      "exiting 0 after boot-time guards without binding the HTTP listener. " +
      "This is a test-only path used by src/index.boot.test.ts. " +
      "If this log appears in a real deploy, the env var has been set in " +
      "production by mistake — unset __EPPLAA_BOOT_GUARDS_ONLY and restart.",
  );
  process.exit(0);
}

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Defer importing `app` and `socket` until after the guard has
// passed so importing them (and the schema/scheduler side effects in
// `app.ts`) never happens on a misconfigured production deploy.
const { default: app } = await import("./app");
const { bootstrapSocketServer } = await import("./lib/socket");

// Use a manual http.Server so Socket.IO can attach to the same port.
const httpServer = createServer(app);
bootstrapSocketServer(httpServer);

httpServer.listen(port, () => {
  logger.info({ port }, "Server listening");
});

httpServer.on("error", (err) => {
  logger.error({ err }, "Error listening on port");
  process.exit(1);
});
