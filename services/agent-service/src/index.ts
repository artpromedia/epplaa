/**
 * services/agent-service entry point.
 *
 * Bootstraps observability, builds dependencies (LiteLLM gateway, Redis
 * memory, Kafka approval bus), and starts the Express HTTP server.
 */

import { buildDeps } from "./composition.js";
import { buildServer } from "./server.js";
import { initOtel, logger } from "./lib/observability.js";

const PORT = parseInt(process.env.PORT ?? "3100", 10);

await initOtel();

const deps = await buildDeps();
const app = buildServer(deps);

const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, "agent_service_listening");
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "agent_service_shutdown");
  server.close();
  await deps.shutdown().catch((err) => {
    logger.warn({ err: (err as Error).message }, "shutdown_error");
  });
  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
// Hard cap so we never hang in CI.
setTimeout(() => undefined, 0).unref();
