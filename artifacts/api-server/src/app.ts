import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import router from "./routes";
import webhooksRouter from "./routes/webhooks";
import { logger } from "./lib/logger";
import { CLERK_PROXY_PATH, clerkProxyMiddleware } from "./middlewares/clerkProxyMiddleware";
import { seedDatabaseIfEmpty } from "./lib/seed";
import { runDailyReconciliation, recoverStuckRefundLocks } from "./lib/reconciliation";
import { processDuePayouts } from "./lib/payments";

const app: Express = express();

// Clerk Frontend API proxy MUST be mounted BEFORE express.json().
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

// Payment gateway webhooks MUST be mounted BEFORE express.json() so we can
// access the raw request body for HMAC SHA512 signature verification.
// Each gateway uses a different signature scheme (Paystack: sha512 of body
// using secret key; Flutterwave: equality check of `verif-hash` header;
// DevMock: sha256 of body using a static dev secret).
app.use("/api/webhooks", express.raw({ type: "*/*", limit: "1mb" }), webhooksRouter);

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
}

if (process.env.NODE_ENV !== "test") {
  startScheduledJobs();
}

export default app;
