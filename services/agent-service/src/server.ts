/**
 * Express HTTP server for agent-service.
 *
 * Routes:
 *   GET  /healthz                    — liveness
 *   GET  /metrics                    — prom-client metrics
 *   GET  /agents                     — list configured agents
 *   POST /agents/:agentId/messages   — invoke an agent
 *
 * The server is exported for tests; index.ts wires it to a port.
 */

import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import {
  agentRunsTotal,
  agentToolCallsTotal,
  logger,
  metricsRegistry,
} from "./lib/observability.js";
import type { AgentServiceDeps } from "./composition.js";

const messageSchema = z.object({
  sessionId: z.string().min(1).max(200),
  message: z.string().min(1).max(8000),
});

export function buildServer(deps: AgentServiceDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", service: "@workspace/agent-service" });
  });

  app.get("/metrics", async (_req, res, next) => {
    try {
      res.set("Content-Type", metricsRegistry.contentType);
      res.end(await metricsRegistry.metrics());
    } catch (err) {
      next(err);
    }
  });

  app.get("/agents", (_req, res) => {
    res.json({
      agents: deps.agents.list().map((a) => ({
        id: a.id,
        displayName: a.displayName,
        tools: a.tools,
      })),
    });
  });

  app.post(
    "/agents/:agentId/messages",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const agentIdParam = req.params.agentId;
        const agentId = typeof agentIdParam === "string" ? agentIdParam : "";
        const config = agentId ? deps.agents.get(agentId) : undefined;
        if (!config) {
          res.status(404).json({ error: "unknown_agent", agentId });
          return;
        }

        const parsed = messageSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: "invalid_body",
            details: parsed.error.flatten(),
          });
          return;
        }

        const { sessionId, message } = parsed.data;
        const runtime = deps.buildRuntime({ agentId, sessionId });
        const receivedAt = new Date().toISOString();

        try {
          const out = await runtime.handle({ message, receivedAt });
          agentRunsTotal.inc({ agent_id: agentId, outcome: "ok" });
          res.json({
            response: out.response,
            awaitedApproval: out.awaitedApproval,
            traceId: out.traceId,
            agentId,
            sessionId,
          });
        } catch (err) {
          agentRunsTotal.inc({ agent_id: agentId, outcome: "error" });
          logger.error(
            { err: (err as Error).message, agentId, sessionId },
            "agent_runtime_error",
          );
          res.status(502).json({
            error: "agent_runtime_failure",
            message: (err as Error).message,
          });
        }
      } catch (err) {
        next(err);
      }
    },
  );

  // Final error handler — last resort.
  app.use(
    (err: Error, _req: Request, res: Response, _next: NextFunction): void => {
      logger.error({ err: err.message }, "unhandled_error");
      if (!res.headersSent) {
        res.status(500).json({ error: "internal_error" });
      }
    },
  );

  // Reference imports so tree-shake doesn't drop the metric counter exports.
  void agentToolCallsTotal;

  return app;
}
