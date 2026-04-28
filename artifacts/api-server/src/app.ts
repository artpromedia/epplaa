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
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(clerkMiddleware());

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
}

if (process.env.NODE_ENV !== "test") {
  startScheduledJobs();
}

export default app;
