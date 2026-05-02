/**
 * notification-service entry point.
 *
 * Skeleton that exposes /healthz and /metrics. The outbox draining and
 * /v1/notifications/enqueue endpoint land in subsequent commits per the
 * strangler-fig plan in README.md.
 */

import express from "express";
import { initOtel, logger, metricsRegistry } from "./lib/observability.js";
import { ShadowOutboxWatcher } from "./lib/ShadowOutboxWatcher.js";

const PORT = parseInt(process.env.PORT ?? "3200", 10);

await initOtel();

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

let watcher: ShadowOutboxWatcher | null = null;
if (process.env.DATABASE_URL) {
  watcher = new ShadowOutboxWatcher({
    databaseUrl: process.env.DATABASE_URL,
    drainEnabled: process.env.NOTIFICATION_DRAIN_ENABLED === "true",
    pollIntervalMs: process.env.NOTIFICATION_POLL_INTERVAL_MS
      ? Number.parseInt(process.env.NOTIFICATION_POLL_INTERVAL_MS, 10)
      : undefined,
  });
  watcher.start();
} else {
  logger.warn("outbox_watcher_disabled \u2014 set DATABASE_URL to enable");
}

app.get("/healthz", (_req, res) => {
  res.json({
    status: "ok",
    service: "@workspace/notification-service",
    mode: watcher
      ? process.env.NOTIFICATION_DRAIN_ENABLED === "true"
        ? "drain"
        : "shadow"
      : "no-db",
  });
});

app.get("/metrics", async (_req, res, next) => {
  try {
    res.set("Content-Type", metricsRegistry.contentType);
    res.end(await metricsRegistry.metrics());
  } catch (err) {
    next(err);
  }
});

const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, "notification_service_listening");
});

function shutdown(signal: string): void {
  logger.info({ signal }, "notification_service_shutdown");
  server.close(() => {
    void (watcher?.stop() ?? Promise.resolve()).finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
