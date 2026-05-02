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
import { requireAdminToken } from "./lib/adminAuth.js";
import type { AgentServiceDeps } from "./composition.js";
import { promptEvalCaseSchema } from "./lib/promptEvalSchema.js";
import { evaluatePrompt, formatReport } from "./lib/promptEvaluator.js";
import { gatewayPromptRunner } from "./lib/gatewayPromptRunner.js";

const messageSchema = z.object({
  sessionId: z.string().min(1).max(200),
  message: z.string().min(1).max(8000),
});

const createPromptSchema = z.object({
  ref: z.string().min(1).max(200),
  family: z.string().min(1).max(128),
  version: z.string().min(1).max(32),
  systemPrompt: z.string().min(1).max(64_000),
  createdBy: z.string().min(1).max(200).optional(),
});

const activatePromptSchema = z
  .object({
    evalCases: z.array(promptEvalCaseSchema).optional(),
    skipEval: z.boolean().optional(),
  })
  .optional();

/**
 * When AGENT_REQUIRE_EVAL_FOR_ACTIVATION=true, the activate endpoint
 * refuses with 412 unless the request body carries evalCases (or
 * skipEval=true with an explicit override). Default off so existing
 * dev/test flows continue to work; production should turn it on.
 */
const REQUIRE_EVAL =
  (process.env["AGENT_REQUIRE_EVAL_FOR_ACTIVATION"] ?? "").toLowerCase() ===
  "true";

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

  // ---- Admin: prompt registry write API -------------------------------
  // Mounted only when a DB-backed promptAdmin store is available. All
  // routes are guarded by requireAdminToken (Bearer + AGENT_ADMIN_TOKEN).
  if (deps.promptAdmin) {
    const promptAdmin = deps.promptAdmin;

    app.get("/admin/prompts", requireAdminToken, async (_req, res, next) => {
      try {
        const rows = await promptAdmin.listAll();
        res.json({ prompts: rows });
      } catch (err) {
        next(err);
      }
    });

    app.get(
      "/admin/prompts/:ref",
      requireAdminToken,
      async (req, res, next) => {
        try {
          const refParam = req.params.ref;
          const ref = typeof refParam === "string" ? refParam : "";
          const row = await promptAdmin.getOne(ref);
          if (!row) {
            res.status(404).json({ error: "not_found", ref });
            return;
          }
          res.json(row);
        } catch (err) {
          next(err);
        }
      },
    );

    app.post("/admin/prompts", requireAdminToken, async (req, res, next) => {
      try {
        const parsed = createPromptSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: "invalid_body",
            details: parsed.error.flatten(),
          });
          return;
        }
        const row = await promptAdmin.create(parsed.data);
        res.status(201).json(row);
      } catch (err) {
        const msg = (err as Error).message;
        // Postgres unique-violation surfaces as a 23505; surface as 409.
        if (
          msg.includes("duplicate key") ||
          msg.includes("unique constraint")
        ) {
          res.status(409).json({ error: "ref_exists", detail: msg });
          return;
        }
        next(err);
      }
    });

    app.post(
      "/admin/prompts/:ref/activate",
      requireAdminToken,
      async (req, res, next) => {
        const refParam = req.params.ref;
        const ref = typeof refParam === "string" ? refParam : "";
        try {
          const parsed = activatePromptSchema.safeParse(req.body ?? {});
          if (!parsed.success) {
            res.status(400).json({
              error: "invalid_body",
              details: parsed.error.flatten(),
            });
            return;
          }
          const body = parsed.data ?? {};
          const cases = body.evalCases ?? [];
          const skip = body.skipEval === true;

          if (REQUIRE_EVAL && cases.length === 0 && !skip) {
            res.status(412).json({
              error: "eval_required",
              message:
                "activation requires evalCases (or skipEval=true with audit) when AGENT_REQUIRE_EVAL_FOR_ACTIVATION=true",
            });
            return;
          }

          if (cases.length > 0) {
            const candidate = await promptAdmin.getOne(ref);
            if (!candidate) {
              res.status(404).json({ error: "not_found", ref });
              return;
            }
            const runner = gatewayPromptRunner(deps.gateway, {
              agentId: candidate.family,
            });
            const report = await evaluatePrompt({
              prompt: candidate.systemPrompt,
              cases,
              runner,
            });
            if (!report.passed) {
              logger.warn(
                { ref, failures: report.failedCount },
                "prompt_activation_eval_failed",
              );
              res.status(422).json({
                error: "eval_failed",
                report,
                summary: formatReport(report),
              });
              return;
            }
          } else if (skip) {
            logger.warn({ ref }, "prompt_activation_eval_skipped");
          }

          const row = await promptAdmin.activate(ref);
          res.json(row);
        } catch (err) {
          const msg = (err as Error).message;
          if (msg.includes("unknown ref")) {
            res.status(404).json({ error: "not_found", ref });
            return;
          }
          next(err);
        }
      },
    );
  }

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
