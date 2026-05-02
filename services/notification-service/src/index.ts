/**
 * notification-service entry point.
 *
 * Skeleton that exposes /healthz and /metrics. The outbox draining and
 * /v1/notifications/enqueue endpoint land in subsequent commits per the
 * strangler-fig plan in README.md.
 */

import express from "express";
import { initOtel, logger, metricsRegistry } from "./lib/observability.js";

const PORT = parseInt(process.env.PORT ?? "3200", 10);

await initOtel();

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok", service: "@workspace/notification-service" });
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
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
