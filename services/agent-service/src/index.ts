/**
 * services/agent-service entry point.
 *
 * Bootstraps observability (OTel + prom-client), then a minimal HTTP
 * server with /healthz and /metrics endpoints. The full Fastify HTTP
 * layer and agent routing arrives in AI Sprint 1's runtime work.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { initOtel, logger, metricsRegistry } from "./lib/observability.js";

const PORT = parseInt(process.env.PORT ?? "3100", 10);

const server = createServer(
  async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "@workspace/agent-service" }));
      return;
    }

    if (req.method === "GET" && req.url === "/metrics") {
      res.writeHead(200, { "Content-Type": metricsRegistry.contentType });
      res.end(await metricsRegistry.metrics());
      return;
    }

    res.writeHead(404);
    res.end();
  },
);

function shutdown(signal: string): void {
  logger.info({ signal }, "agent_service_shutdown");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

await initOtel();

server.listen(PORT, () => {
  logger.info({ port: PORT }, "agent_service_listening");
});
