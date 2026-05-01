// Sentry MUST be initialised before any other module so its async-context
// hooks see every request from the very first line of code. The module is
// a no-op when SENTRY_DSN is unset.
import { initSentryServer } from "./lib/sentry";
initSentryServer();

import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import router from "./routes";
import webhooksRouter from "./routes/webhooks";
import fulfillmentWebhooksRouter from "./routes/fulfillmentWebhooks";
import streamingWebhooksRouter from "./routes/streamingWebhooks";
import { logger } from "./lib/logger";
import { CLERK_PROXY_PATH, clerkProxyMiddleware } from "./middlewares/clerkProxyMiddleware";
import { seedDatabaseIfEmpty } from "./lib/seed";
import { runDailyReconciliation, recoverStuckRefundLocks } from "./lib/reconciliation";
import { processDuePayouts } from "./lib/payments";
import { drainOutbox } from "./lib/notifications";
import { autoReturnExpiredBoxReservations } from "./routes/box";
import { initPudoDeliverySchema } from "./lib/pudo/schema";
import { runDailyPudoManifestDelivery } from "./lib/pudo/delivery";
import { auditMutations, auditPiiReads, initAuditChain } from "./lib/audit";
import { startAuditDlqMonitor } from "./lib/auditDlqMonitor";
import { startAuditChainVerifier } from "./lib/auditChainVerifier";
import { initAdminSchema } from "./lib/roles";
import { initManufacturerSchema } from "./lib/manufacturers";
import { initSecuritySchema } from "./lib/security";
import { initMoneyFlowFkConstraints } from "./lib/moneyFlowFk";
import { initOtel } from "./lib/otel";
import { refreshFxRates, seedFxRatesIfEmpty } from "./lib/fx";
import { processDueNdprRequests, requireProcessingNotRestricted } from "./lib/ndpr";
import { quarterlyResweep, bootstrapAllManufacturerScreenings } from "./lib/sanctions";
import { runModerationProviderHealthCheck } from "./lib/moderation";
import {
  nudgeLowBackupCodes,
  pruneExpiredMfaChallenges,
  pruneStalePendingMfaEnrollments,
} from "./lib/mfa";
import { initRetentionSchema, runRetentionSweep } from "./lib/retention";
import { initStreamModeratorsSchema } from "./lib/streamModerators";
import { securityHeaders } from "./middlewares/securityHeaders";
import { csrfMiddleware } from "./middlewares/csrf";
import { apiRateLimit } from "./middlewares/apiRateLimit";
import { startMfaAbuseWatcherSweepTimer } from "./lib/rate-limit/mfaAbuseWatcher";
import { httpMetricsMiddleware, metricsHandler } from "./lib/metrics";

const app: Express = express();

// Prometheus /metrics — mounted FIRST so it's reachable even if the rest
// of the middleware chain blows up. Scraped by the kube-prometheus-stack
// ServiceMonitor (see infra/helm/api-monolith/templates/servicemonitor.yaml).
// NetworkPolicy at the cluster level keeps the route off the public ingress.
app.get("/metrics", metricsHandler);

// Clerk Frontend API proxy MUST be mounted BEFORE express.json().
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

// Payment gateway webhooks MUST be mounted BEFORE express.json() so we can
// access the raw request body for HMAC SHA512 signature verification.
// Each gateway uses a different signature scheme (Paystack: sha512 of body
// using secret key; Flutterwave: equality check of `verif-hash` header;
// DevMock: sha256 of body using a static dev secret).
app.use("/api/webhooks", express.raw({ type: "*/*", limit: "1mb" }), webhooksRouter);

// Carrier tracking webhooks ALSO need the raw body for HMAC SHA256 checks.
// Mounted before express.json() so the signature verification sees the
// exact bytes the carrier signed.
app.use(
  "/api/fulfillment/webhooks",
  express.raw({ type: "*/*", limit: "1mb" }),
  fulfillmentWebhooksRouter,
);

// Cloudflare Stream notification webhook. Same raw-body requirement as
// payment + carrier webhooks so the HMAC over the exact wire bytes can
// be verified before the JSON parser reformats them.
app.use(
  "/api/streaming/webhooks",
  express.raw({ type: "*/*", limit: "1mb" }),
  streamingWebhooksRouter,
);

// Strict transport + content-security headers. Mounted AFTER raw-body
// webhook routes (they need Content-Type unmodified) but BEFORE
// express.json so even malformed bodies still get the protective headers.
// Helmet defaults to frameguard=DENY, X-Content-Type-Options=nosniff,
// HSTS=180d, plus a strict CSP allowing Clerk + Sentry tunnel only.
for (const mw of securityHeaders()) app.use(mw);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);
app.use(cors());
// Record request-level RED metrics. Mounted after pino-http so the
// request id is set for log/metric correlation, but before any business
// middleware so 4xx/5xx generated upstream are still counted.
app.use(httpMetricsMiddleware);
// Body limit needs to comfortably exceed the 6 MB max KYC document size
// (kyc.ts MAX_DOC_BYTES) once base64-encoded. base64 inflates by ~4/3, so a
// 6 MB blob lands around 8 MB, plus envelope. Use 10 MB to leave headroom.
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
// cookie-parser must be mounted BEFORE the CSRF middleware so the
// double-submit check can read the `csrf_token` cookie.
app.use(cookieParser());
app.use(clerkMiddleware());

// CSRF (double-submit cookie). Skipped on Bearer-auth requests (Clerk JWT
// path), webhooks (HMAC-verified), and the /api/csrf-token issuer route
// itself. See middlewares/csrf.ts for the exemption list.
app.use(csrfMiddleware());

// Per-route + per-identity rate limiter. Tier resolution: anon by IP,
// buyer/seller/admin by Clerk userId. Hot endpoints (otp_start) keep
// their existing tighter ipRateLimit on top of this baseline.
app.use("/api", apiRateLimit({ name: "api" }));

// NDPR Article 19 — Right to Restriction of Processing. Users who flip
// `processingRestrictedAt` get 423 Locked on every mutating route except
// the NDPR routes themselves (so they can lift the restriction or cancel
// an erase). This must run BEFORE the audit middleware so we don't write
// audit rows for requests we're going to reject.
app.use("/api", requireProcessingNotRestricted);

// Audit log middleware. NDPR/PCI compliance treats every PII access
// (read AND mutation) as auditable, so we mount two complementary
// passes — auditPiiReads() captures successful authenticated GETs that
// expose user PII (registered explicitly in audit.ts), and
// auditMutations() captures every authenticated POST/PUT/PATCH/DELETE.
// Both write hash-chained rows; PII in payloads is scrubbed before
// persistence.
app.use(auditPiiReads());
app.use(auditMutations());

app.use("/api", router);

// Seed catalog tables on boot (no-op if already seeded).
void seedDatabaseIfEmpty();

// Daily reconciliation + hourly payout sweep. We use intervals so a single
// process owns the schedule without an external cron service.
const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
function startScheduledJobs(): void {
  // Stagger the first run by 30s so boot isn't blocked, then every 24h.
  setTimeout(() => {
    void runDailyReconciliation().catch((err) =>
      logger.error({ err: (err as Error).message }, "reconciliation_failed"),
    );
    setInterval(() => {
      void runDailyReconciliation().catch((err) =>
        logger.error({ err: (err as Error).message }, "reconciliation_failed"),
      );
    }, DAY_MS);
  }, 30_000);
  // Run payouts every hour so funds released by hold expiry get sent out promptly.
  setTimeout(() => {
    void processDuePayouts().catch((err) =>
      logger.error({ err: (err as Error).message }, "payouts_failed"),
    );
    setInterval(() => {
      void processDuePayouts().catch((err) =>
        logger.error({ err: (err as Error).message }, "payouts_failed"),
      );
    }, HOUR_MS);
  }, 60_000);
  /*
   * Refund-lock recovery: every 10 minutes, finalize or release any
   * order whose `refund_started_at` lock has been held longer than the
   * default 30-min stale window. This auto-heals partial-failure cases
   * where the refund route crashed after contacting the gateway and
   * intentionally left the lock held to prevent double charges.
   */
  const REFUND_RECOVERY_INTERVAL_MS = 10 * 60 * 1000;
  setTimeout(() => {
    void recoverStuckRefundLocks().catch((err) =>
      logger.error({ err: (err as Error).message }, "refund_lock_recovery_failed"),
    );
    setInterval(() => {
      void recoverStuckRefundLocks().catch((err) =>
        logger.error({ err: (err as Error).message }, "refund_lock_recovery_failed"),
      );
    }, REFUND_RECOVERY_INTERVAL_MS);
  }, 90_000);
  // Notifications outbox drain: every 30s. Each row claim is atomic so
  // overlapping ticks under load never double-send.
  const OUTBOX_INTERVAL_MS = 30_000;
  setTimeout(() => {
    void drainOutbox().catch((err) =>
      logger.error({ err: (err as Error).message }, "outbox_drain_failed"),
    );
    setInterval(() => {
      void drainOutbox().catch((err) =>
        logger.error({ err: (err as Error).message }, "outbox_drain_failed"),
      );
    }, OUTBOX_INTERVAL_MS);
  }, 15_000);
  // Box reservation auto-return: every 15 minutes. The default hold window
  // is 72h (BOX_RESERVATION_HOURS), and the WHERE clause + status guard
  // makes overlapping ticks a no-op.
  const BOX_AUTO_RETURN_INTERVAL_MS = 15 * 60 * 1000;
  setTimeout(() => {
    void autoReturnExpiredBoxReservations().catch((err) =>
      logger.error({ err: (err as Error).message }, "box_auto_return_failed"),
    );
    setInterval(() => {
      void autoReturnExpiredBoxReservations().catch((err) =>
        logger.error({ err: (err as Error).message }, "box_auto_return_failed"),
      );
    }, BOX_AUTO_RETURN_INTERVAL_MS);
  }, 120_000);
  // PUDO daily manifest push (task #16): every 15 minutes the cron
  // walks every active partner and, for those whose local clock has
  // crossed 06:00 today, builds + delivers the manifest CSV via
  // email or SFTP. The contentHash dedupe + per-(partner, day) row
  // make overlapping ticks a no-op once the day's run is `sent`.
  // Pull-mode partners (`delivery_method='none'`) are silently
  // skipped — they keep using `GET /pudo/:partnerCode/manifest`.
  const PUDO_DELIVERY_INTERVAL_MS = 15 * 60 * 1000;
  setTimeout(() => {
    void runDailyPudoManifestDelivery().catch((err) =>
      logger.error({ err: (err as Error).message }, "pudo_manifest_delivery_failed"),
    );
    setInterval(() => {
      void runDailyPudoManifestDelivery().catch((err) =>
        logger.error({ err: (err as Error).message }, "pudo_manifest_delivery_failed"),
      );
    }, PUDO_DELIVERY_INTERVAL_MS);
  }, 240_000);
  // NDPR processor: every 5 minutes pick up pending requests (assemble
  // export bundles, apply effective erases, etc.). Erase requests honour
  // the 30-day grace window via `effective_at`.
  const NDPR_INTERVAL_MS = 5 * 60 * 1000;
  setTimeout(() => {
    void processDueNdprRequests().catch((err) =>
      logger.error({ err: (err as Error).message }, "ndpr_process_failed"),
    );
    setInterval(() => {
      void processDueNdprRequests().catch((err) =>
        logger.error({ err: (err as Error).message }, "ndpr_process_failed"),
      );
    }, NDPR_INTERVAL_MS);
  }, 45_000);
  // Retention engine: daily. Honours the v4.1 retention schedule —
  // financial records (orders/payouts/payments/audit) preserved 7y;
  // ephemeral data (notifications, recently viewed, etc.) trimmed.
  setTimeout(() => {
    void runRetentionSweep().catch((err) =>
      logger.error({ err: (err as Error).message }, "retention_sweep_failed"),
    );
    setInterval(() => {
      void runRetentionSweep().catch((err) =>
        logger.error({ err: (err as Error).message }, "retention_sweep_failed"),
      );
    }, DAY_MS);
  }, 150_000);
  // Sanctions quarterly resweep: hourly tick, only sellers whose
  // `next_review_at` is past actually get re-screened.
  setTimeout(() => {
    void quarterlyResweep().catch((err) =>
      logger.error({ err: (err as Error).message }, "sanctions_resweep_failed"),
    );
    setInterval(() => {
      void quarterlyResweep().catch((err) =>
        logger.error({ err: (err as Error).message }, "sanctions_resweep_failed"),
      );
    }, HOUR_MS);
  }, 180_000);
  // Prune stale `pending` MFA enrolments: every 5 minutes delete rows
  // older than `MFA_PENDING_PRUNE_MAX_AGE_MS` (default 10 min) so the
  // mfa_enrollments table doesn't accumulate abandoned QR-code setups
  // and so encrypted secrets don't sit in the DB longer than needed.
  // Active enrolments are never touched.
  const MFA_PRUNE_INTERVAL_MS = 5 * 60 * 1000;
  setTimeout(() => {
    void pruneStalePendingMfaEnrollments().catch((err) =>
      logger.error({ err: (err as Error).message }, "mfa_pending_prune_failed"),
    );
    setInterval(() => {
      void pruneStalePendingMfaEnrollments().catch((err) =>
        logger.error({ err: (err as Error).message }, "mfa_pending_prune_failed"),
      );
    }, MFA_PRUNE_INTERVAL_MS);
  }, 75_000);
  // Prune expired MFA challenges: every 15 minutes delete rows whose
  // `expires_at` is older than `MFA_CHALLENGES_PRUNE_GRACE_MS` ago
  // (default 1 day). `recordChallenge` writes one row per successful
  // TOTP / backup-code assertion with a 15-minute TTL; nothing else
  // ever deletes them, so the table grows unboundedly without this
  // sweep. The grace tail keeps a short forensic record after expiry.
  const MFA_CHALLENGES_PRUNE_INTERVAL_MS = 15 * 60 * 1000;
  setTimeout(() => {
    void pruneExpiredMfaChallenges().catch((err) =>
      logger.error(
        { err: (err as Error).message },
        "mfa_challenges_prune_failed",
      ),
    );
    setInterval(() => {
      void pruneExpiredMfaChallenges().catch((err) =>
        logger.error(
          { err: (err as Error).message },
          "mfa_challenges_prune_failed",
        ),
      );
    }, MFA_CHALLENGES_PRUNE_INTERVAL_MS);
  }, 90_000);
  // Email a nudge when a seller's TOTP backup codes are running low
  // (fewer than 3 remaining) or have run out. Daily cadence is enough
  // because backup codes are consumed at most a handful of times a year
  // by any one user; the per-row threshold marker prevents the same
  // user being re-emailed on every tick. Stagger the first run so boot
  // isn't blocked.
  setTimeout(() => {
    void nudgeLowBackupCodes().catch((err) =>
      logger.error(
        { err: (err as Error).message },
        "mfa_backup_codes_low_nudge_failed",
      ),
    );
    setInterval(() => {
      void nudgeLowBackupCodes().catch((err) =>
        logger.error(
          { err: (err as Error).message },
          "mfa_backup_codes_low_nudge_failed",
        ),
      );
    }, DAY_MS);
  }, 210_000);
  // MFA-burst watcher memory sweep: drop per-identity buckets that
  // have been quiet for at least one window length so a steady drip
  // of distinct attacker identities can't grow the in-process map
  // unboundedly. The watcher itself runs synchronously inside the
  // 429 path; this is just GC. Skipped under NODE_ENV=test by the
  // helper so unit tests aren't polluted by stray timers.
  startMfaAbuseWatcherSweepTimer();
}

if (process.env.NODE_ENV !== "test") {
  // Eagerly install the append-only audit-table triggers so the DB-level
  // immutability protection is in place before the first request rather
  // than lazily on the first audit write.
  void initAuditChain()
    .then(() => {
      // Start the audit-DLQ backlog monitor only after the audit
      // schema migration completes — otherwise the very first poll
      // could race against the `ALTER TABLE … ADD COLUMN
      // replayed_at` and fail with `column "replayed_at" does not
      // exist`. The monitor is idempotent on repeat calls so a
      // future caller can't accidentally double-schedule it.
      startAuditDlqMonitor();
      // Periodic in-prod audit-chain integrity probe (task #106). Runs
      // `verifyAuditChain()` against the live `audit_events` table on
      // an `AUDIT_CHAIN_VERIFY_INTERVAL_MS` cadence (default 4h) and
      // pages audit/compliance owners on a non-null offending seq via
      // the same Sentry capture path the weekly backup-verify drill
      // uses for its exit-8 routing — see
      // `docs/runbooks/backup-verify.md`. Idempotent on repeat calls
      // so a future caller can't double-schedule the verifier.
      startAuditChainVerifier();
      // Run the moderation provider's connection check and write the
      // outcome to the audit log. Deferred until after `initAuditChain`
      // so the audit table is guaranteed to exist when we append; runs
      // best-effort so a degraded provider doesn't block boot. The
      // dashboard's `degraded` banner + the warn-tag alert from the
      // boot-time `assertModerationProviderConfiguredForProduction`
      // guard are the operator-facing controls.
      void runModerationProviderHealthCheck().catch((err) =>
        logger.error(
          { err: (err as Error).message },
          "moderation_provider_health_check_failed_unexpectedly",
        ),
      );
    })
    .catch((err) =>
      logger.error({ err: (err as Error).message }, "audit_chain_init_failed"),
    );
  // Trust & Safety operator console schema: roles, user_roles,
  // moderation_cases, moderation_scans, payout_actions, takedowns.
  // Additive-only (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS)
  // — matches the initAuditChain pattern. Bootstraps default roles and
  // grants `admin` to anyone in EPPLAA_ADMIN_USER_IDS.
  void initAdminSchema().catch((err) =>
    logger.error({ err: (err as Error).message }, "admin_schema_init_failed"),
  );
  // Cross-border manufacturer schema (Task #8): manufacturers,
  // manufacturer_kyc, manufacturer_listings, wholesale_orders,
  // freight_bookings, customs_events, bonded_warehouse_inventory, fx_rates.
  // Additive-only (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS) —
  // matches the initAuditChain / initAdminSchema pattern. Also adds
  // additive `kind` and `currency_code` columns to `payouts` so the
  // payouts table can carry `kind="manufacturer_share"` rows in origin
  // currency without a separate table.
  void initManufacturerSchema()
    .then(() => seedFxRatesIfEmpty())
    .then(() => refreshFxRates())
    .catch((err) => logger.error({ err: (err as Error).message }, "manufacturer_schema_init_failed"));
  // Security/MFA schema (Task #9): mfa_enrollments, mfa_challenges,
  // rate_limit_events. Same additive `CREATE TABLE IF NOT EXISTS` pattern
  // as the other init* helpers — every PK is `text` to match the rest
  // of the project. NEVER use a destructive force-push here.
  void initSecuritySchema().catch((err) =>
    logger.error({ err: (err as Error).message }, "security_schema_init_failed"),
  );
  // Money-flow FK constraints (Task #105): real DB-level FKs on
  // orders.user_id, payment_intents.user_id, payment_intents.order_id
  // so a bad money-movement INSERT/UPDATE rejects at write time
  // instead of being caught a week later by the backup verifier's
  // anti-join (`scripts/src/verifyBackup.ts` exit 7). Cleans pre-
  // existing orphans (detach to NULL where the column allows it,
  // backfill placeholder users elsewhere) in the same transaction
  // so the ALTER TABLE doesn't reject. Verifier still runs as
  // defence in depth.
  void initMoneyFlowFkConstraints().catch((err) =>
    logger.error({ err: (err as Error).message }, "money_flow_fk_init_failed"),
  );
  // Retention heartbeat table: per-arm `last_run_at` rows for the
  // daily sweep. Same additive `CREATE TABLE IF NOT EXISTS` pattern
  // as the other init* helpers. Also primes the in-memory heartbeat
  // cache from the previous process's writes so a redeploy doesn't
  // false-trigger the "no successful sweep in >36h" alert before the
  // next scheduled tick lands.
  void initRetentionSchema().catch((err) =>
    logger.error({ err: (err as Error).message }, "retention_schema_init_failed"),
  );
  // PUDO daily-push delivery schema additions (Task #16): adds
  // delivery configuration columns to `pudo_partners` and per-run
  // delivery audit columns to `pudo_manifest_runs`. Strictly additive
  // (`ADD COLUMN IF NOT EXISTS`), so old rows back-fill to safe
  // defaults and the manifest endpoint keeps working unchanged.
  void initPudoDeliverySchema().catch((err) =>
    logger.error({ err: (err as Error).message }, "pudo_delivery_schema_init_failed"),
  );
  // Per-stream moderator grants (Task #22): hosts can deputise viewers
  // to delete chat messages and tune slow-mode/banned-words during a
  // live stream. Same additive `CREATE TABLE IF NOT EXISTS` pattern as
  // the other init* helpers so a redeploy is always safe.
  void initStreamModeratorsSchema().catch((err) =>
    logger.error({ err: (err as Error).message }, "stream_moderators_schema_init_failed"),
  );
  // OpenTelemetry SDK init. No-op when OTEL_EXPORTER_OTLP_ENDPOINT is
  // unset, which is the normal case in dev. In prod it ships traces from
  // express + http instrumentations to Grafana Cloud OTLP.
  void initOtel().catch((err) =>
    logger.warn({ err: (err as Error).message }, "otel_init_failed"),
  );
  // Daily FX refresh — pulls fresh CBN/OXR rates so quoted/landed prices in
  // Naira don't drift. The seed/refresh on boot covers cold start; the
  // setInterval ensures long-running processes refresh every 24h without
  // an external cron.
  setInterval(() => {
    refreshFxRates().catch((err) =>
      logger.error({ err: (err as Error).message }, "fx_rates_refresh_failed"),
    );
  }, 24 * 60 * 60 * 1000);
  // Backfill sanctions screening for every manufacturer attributed to a
  // product. Manufacturers don't have a dedicated onboarding route in this
  // codebase — they're seeded/imported externally — so without this pass
  // the quarterly resweep (and per-payout gate) would silently miss any
  // manufacturer whose first payout has not yet been scheduled. Running
  // at boot satisfies "every onboarded seller AND manufacturer is screened
  // at onboarding and quarterly".
  void bootstrapAllManufacturerScreenings().catch((err) =>
    logger.error({ err: (err as Error).message }, "manufacturer_sanctions_bootstrap_failed"),
  );
  startScheduledJobs();
}

export default app;
