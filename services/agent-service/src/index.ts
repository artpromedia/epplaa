/**
 * services/agent-service entry point.
 *
 * AI Sprint 0 — scaffolding only. This file initialises:
 *   - OpenTelemetry SDK (lazy; see lib/otel pattern from services/api-monolith)
 *   - A minimal HTTP server with a /healthz endpoint
 *   - Graceful shutdown handling
 *
 * The full Fastify HTTP layer and agent routing will be wired in AI Sprint 1
 * once the LiteLLM gateway and Prompt Registry DB backend are in place.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const PORT = parseInt(process.env.PORT ?? "3100", 10);

// ---------------------------------------------------------------------------
// OpenTelemetry initialisation (optional; no-ops if SDK not installed)
// ---------------------------------------------------------------------------
async function initOtel(): Promise<void> {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    // OTel disabled — no OTLP endpoint configured.
    return;
  }
  // TODO (AI Sprint 1): dynamic import @opentelemetry/sdk-node once added
  // to package.json and lockfile. Same lazy-import pattern as
  // services/api-monolith/src/lib/otel.ts.
  console.warn(
    JSON.stringify({
      level: "warn",
      msg: "otel_sdk_not_yet_installed",
      note: "Install @opentelemetry/sdk-node in AI Sprint 1",
    }),
  );
}

// ---------------------------------------------------------------------------
// Minimal HTTP server (replaced by Fastify in AI Sprint 1)
// ---------------------------------------------------------------------------
const server = createServer(
  (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "@workspace/agent-service" }));
      return;
    }
    res.writeHead(404);
    res.end();
  },
);

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
function shutdown(signal: string): void {
  console.info(
    JSON.stringify({ level: "info", msg: "agent_service_shutdown", signal }),
  );
  server.close(() => {
    process.exit(0);
  });
  // Force-exit after 10 s if graceful close hangs.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
await initOtel();

server.listen(PORT, () => {
  console.info(
    JSON.stringify({
      level: "info",
      msg: "agent_service_listening",
      port: PORT,
    }),
  );
});
