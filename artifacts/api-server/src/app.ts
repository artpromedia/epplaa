import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import router from "./routes";
import webhooksRouter from "./routes/webhooks";
import fulfillmentWebhooksRouter from "./routes/fulfillmentWebhooks";
import { logger } from "./lib/logger";
import { CLERK_PROXY_PATH, clerkProxyMiddleware } from "./middlewares/clerkProxyMiddleware";
import { seedDatabaseIfEmpty } from "./lib/seed";
import { runDailyReconciliation, recoverStuckRefundLocks } from "./lib/reconciliation";
import { processDuePayouts } from "./lib/payments";
import { drainOutbox } from "./lib/notifications";
import { autoReturnExpiredBoxReservations } from "./routes/box";
import { auditMutations, auditPiiReads, initAuditChain } from "./lib/audit";
import { processDueNdprRequests, requireProcessingNotRestricted } from "./lib/ndpr";
import { quarterlyResweep, bootstrapAllManufacturerScreenings } from "./lib/sanctions";
import { runRetentionSweep } from "./lib/retention";

const app: Express = express();

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
// Body limit needs to comfortably exceed the 6 MB max KYC document size
// (kyc.ts MAX_DOC_BYTES) once base64-encoded. base64 inflates by ~4/3, so a
// 6 MB blob lands around 8 MB, plus envelope. Use 10 MB to leave headroom.
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(clerkMiddleware());

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
}

if (process.env.NODE_ENV !== "test") {
  // Eagerly install the append-only audit-table triggers so the DB-level
  // immutability protection is in place before the first request rather
  // than lazily on the first audit write.
  void initAuditChain().catch((err) =>
    logger.error({ err: (err as Error).message }, "audit_chain_init_failed"),
  );
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
