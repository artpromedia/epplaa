/**
 * Composition root for agent-service.
 *
 * Reads env vars, builds concrete dependencies, and returns a wired
 * AgentRuntime factory plus the registries needed by the HTTP layer.
 *
 * Env vars (all optional unless marked required):
 *   LITELLM_BASE_URL    (required in production) — e.g. http://litellm:4000
 *   LITELLM_API_KEY     (required in production)
 *   REDIS_URL           — defaults to in-memory STM when unset
 *   KAFKA_BROKERS       — comma-separated; defaults to NoopApprovalBus
 *   KAFKA_CLIENT_ID     — default: "agent-service"
 *   KAFKA_SSL           — "true" enables TLS
 *   KAFKA_SASL_*        — SASL/PLAIN credentials
 *   AGENT_DRY_RUN       — "true" returns mock model responses (dev only)
 *   MONOLITH_BASE_URL   — base URL of api-monolith for tool dispatch
 *   AGENT_SERVICE_TOKEN — service-to-service bearer token for monolith calls
 *   LANGFUSE_BASE_URL   — enables trace export when set with PUBLIC/SECRET keys
 *   LANGFUSE_PUBLIC_KEY
 *   LANGFUSE_SECRET_KEY
 */

import Redis from "ioredis";
import { Kafka, logLevel as kafkaLogLevel } from "kafkajs";
import { LiteLLMGateway } from "./gateway/LiteLLMGateway.js";
import type { IModelGateway, ModelResponse } from "./gateway/ModelGateway.js";
import { RedisShortTermMemory } from "./memory/RedisShortTermMemory.js";
import {
  InMemoryShortTermMemory,
  type IShortTermMemory,
} from "./memory/ShortTermMemory.js";
import { StaticAgentRegistry } from "./registry/AgentRegistry.js";
import {
  InMemoryPromptRegistry,
  type IPromptRegistry,
  type IPromptAdminStore,
} from "./registry/PromptRegistry.js";
import { DbPromptRegistry } from "./registry/DbPromptRegistry.js";
import {
  InMemoryToolRegistry,
  type IToolRegistry,
  type ToolCall,
  type ToolDescriptor,
  type ToolResult,
} from "./registry/ToolRegistry.js";
import {
  AgentRuntime,
  type AgentRuntimeOptions,
} from "./runtime/AgentRuntime.js";
import { HttpToolDispatcher } from "./runtime/ToolDispatcher.js";
import { KafkaApprovalBus } from "./approval/KafkaApprovalBus.js";
import type { IApprovalBus, ProposedActionEvent } from "./approval/ApprovalBus.js";
import { LangfuseTraceExporter } from "./lib/LangfuseTraceExporter.js";
import { logger } from "./lib/observability.js";

export interface AgentServiceDeps {
  agents: StaticAgentRegistry;
  prompts: IPromptRegistry;
  /** Admin write API for prompts; null when running with the in-memory registry. */
  promptAdmin: IPromptAdminStore | null;
  tools: IToolRegistry;
  gateway: IModelGateway;
  memory: IShortTermMemory;
  approvalBus: IApprovalBus | undefined;
  /** Hook so server.ts can shut down kafka/redis cleanly on SIGTERM. */
  shutdown: () => Promise<void>;
  /** Build a per-request AgentRuntime. */
  buildRuntime: (params: { agentId: string; sessionId: string }) => AgentRuntime;
}

/**
 * Bridge: AgentRuntime expects requestApproval(call, ctx) returning an
 * ApprovalDecision; KafkaApprovalBus exposes produce + awaitDecision.
 * This adapter generates an eventId, produces, awaits, and translates
 * transport/decision errors into the typed ApprovalDecision shape.
 */
function adaptApprovalBus(bus: KafkaApprovalBus): NonNullable<AgentRuntimeOptions["approvalBus"]> {
  return {
    requestApproval: async (
      call: ToolCall,
      ctx: { agentId: string; sessionId: string },
    ) => {
      const eventId = crypto.randomUUID();
      const now = new Date();
      const event: ProposedActionEvent = {
        eventId,
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        tool: call.name,
        args: call.args,
        requestedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
      };
      try {
        await bus.produce(event);
        const decision = await bus.awaitDecision(eventId);
        if (decision.decision === "approved") {
          return {
            approved: true as const,
            approvedBy: decision.approvedBy,
            decidedAt: decision.decidedAt,
            note: decision.note,
          };
        }
        return {
          approved: false as const,
          kind: "rejected" as const,
          reason: decision.note ?? "no reason given",
          decidedBy: decision.approvedBy,
        };
      } catch (err) {
        return {
          approved: false as const,
          kind: "error" as const,
          reason: (err as Error).message,
        };
      }
    },
  };
}

class DryRunGateway implements IModelGateway {
  async complete(): Promise<ModelResponse> {
    return {
      text: "[dry-run] AGENT_DRY_RUN=true — no live LLM call was made.",
      toolCalls: [],
      model: "dry-run",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      latencyMs: 0,
    };
  }
}

export async function buildDeps(): Promise<AgentServiceDeps> {
  const env = process.env;

  // ---- Memory ----------------------------------------------------------
  let memory: IShortTermMemory;
  let redis: Redis | null = null;
  if (env.REDIS_URL) {
    redis = new Redis(env.REDIS_URL, {
      // Fail-fast on misconfig in dev so we don't masquerade as in-memory.
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });
    redis.on("error", (err) => {
      logger.warn({ err: err.message }, "redis_error");
    });
    memory = new RedisShortTermMemory(redis);
    logger.info("memory_redis_enabled");
  } else {
    memory = new InMemoryShortTermMemory();
    logger.warn("memory_in_memory_only — set REDIS_URL for production");
  }

  // ---- Tool registry --------------------------------------------------
  const tools = new InMemoryToolRegistry();

  // ---- Gateway --------------------------------------------------------
  let gateway: IModelGateway;
  if (env.AGENT_DRY_RUN === "true") {
    gateway = new DryRunGateway();
    logger.warn("gateway_dry_run_mode");
  } else if (env.LITELLM_BASE_URL && env.LITELLM_API_KEY) {
    const toolDescriptors = new Map<
      string,
      { description: string; parameters: unknown }
    >();
    for (const t of tools.list() as ToolDescriptor[]) {
      // We can't easily convert Zod schemas to JSON Schema without an extra
      // dep here. Pass a minimal type:object placeholder; LiteLLM tolerates
      // it and Zod runs its full validation on the agent-service side.
      toolDescriptors.set(t.name, {
        description: t.description,
        parameters: { type: "object", additionalProperties: true },
      });
    }
    gateway = new LiteLLMGateway({
      baseUrl: env.LITELLM_BASE_URL,
      apiKey: env.LITELLM_API_KEY,
      toolDescriptors,
    });
    logger.info({ baseUrl: env.LITELLM_BASE_URL }, "gateway_litellm_enabled");
  } else {
    throw new Error(
      "Gateway misconfigured: set AGENT_DRY_RUN=true OR LITELLM_BASE_URL+LITELLM_API_KEY.",
    );
  }

  // ---- Approval bus ---------------------------------------------------
  let approvalBus: IApprovalBus | undefined;
  let kafkaBus: KafkaApprovalBus | null = null;
  if (env.KAFKA_BROKERS) {
    type KafkaSasl = NonNullable<ConstructorParameters<typeof Kafka>[0]["sasl"]>;
    const mech = (env.KAFKA_SASL_MECHANISM ?? "plain") as
      | "plain"
      | "scram-sha-256"
      | "scram-sha-512";
    const sasl: KafkaSasl | undefined =
      env.KAFKA_SASL_USERNAME && env.KAFKA_SASL_PASSWORD
        ? mech === "plain"
          ? { mechanism: "plain", username: env.KAFKA_SASL_USERNAME, password: env.KAFKA_SASL_PASSWORD }
          : mech === "scram-sha-256"
            ? { mechanism: "scram-sha-256", username: env.KAFKA_SASL_USERNAME, password: env.KAFKA_SASL_PASSWORD }
            : { mechanism: "scram-sha-512", username: env.KAFKA_SASL_USERNAME, password: env.KAFKA_SASL_PASSWORD }
        : undefined;
    const kafka = new Kafka({
      clientId: env.KAFKA_CLIENT_ID ?? "agent-service",
      brokers: env.KAFKA_BROKERS.split(",").map((s) => s.trim()),
      ssl: env.KAFKA_SSL === "true",
      ...(sasl ? { sasl } : {}),
      logLevel: kafkaLogLevel.WARN,
    });
    kafkaBus = new KafkaApprovalBus({ kafka });
    await kafkaBus.start();
    approvalBus = kafkaBus;
    logger.info({ brokers: env.KAFKA_BROKERS }, "approval_bus_kafka_enabled");
  } else {
    approvalBus = undefined;
    logger.warn("approval_bus_disabled — set KAFKA_BROKERS to enable single-human approval");
  }

  // ---- Registries -----------------------------------------------------
  const agents = new StaticAgentRegistry();
  let prompts: IPromptRegistry;
  let dbPrompts: DbPromptRegistry | null = null;
  if (env.DATABASE_URL) {
    dbPrompts = new DbPromptRegistry({ databaseUrl: env.DATABASE_URL });
    try {
      const seeded = await dbPrompts.bootstrap();
      logger.info(
        { seeded, source: "DbPromptRegistry" },
        "prompt_registry_ready",
      );
      prompts = dbPrompts;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        "prompt_registry_db_bootstrap_failed_falling_back_in_memory",
      );
      await dbPrompts.close().catch(() => undefined);
      dbPrompts = null;
      prompts = new InMemoryPromptRegistry();
    }
  } else {
    prompts = new InMemoryPromptRegistry();
    logger.info({ source: "InMemoryPromptRegistry" }, "prompt_registry_ready");
  }

  // ---- Tool dispatcher ------------------------------------------------
  const dispatcher = new HttpToolDispatcher({
    monolithBaseUrl: env.MONOLITH_BASE_URL ?? "http://api-monolith.commerce",
    serviceToken: env.AGENT_SERVICE_TOKEN,
  });
  logger.info(
    {
      monolithBaseUrl: env.MONOLITH_BASE_URL ?? "http://api-monolith.commerce",
      registered: dispatcher.registeredTools(),
    },
    "tool_dispatcher_ready",
  );

  // ---- Trace exporter -------------------------------------------------
  let langfuse: LangfuseTraceExporter | undefined;
  if (env.LANGFUSE_BASE_URL && env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY) {
    langfuse = new LangfuseTraceExporter({
      baseUrl: env.LANGFUSE_BASE_URL,
      publicKey: env.LANGFUSE_PUBLIC_KEY,
      secretKey: env.LANGFUSE_SECRET_KEY,
    });
    logger.info({ baseUrl: env.LANGFUSE_BASE_URL }, "langfuse_exporter_enabled");
  } else {
    logger.info("langfuse_exporter_disabled — set LANGFUSE_BASE_URL/PUBLIC_KEY/SECRET_KEY to enable");
  }

  // ---- Composition root: AgentRuntime factory -------------------------
  const buildRuntime = ({
    agentId,
    sessionId,
  }: {
    agentId: string;
    sessionId: string;
  }): AgentRuntime => {
    const ctx = { agentId, sessionId, authToken: undefined };
    return new AgentRuntime({
      agentId,
      sessionId,
      registries: { agents, prompts, tools },
      gateway,
      memory,
      toolDispatcher: (call, desc) => dispatcher.dispatch(call, desc, ctx),
      ...(kafkaBus ? { approvalBus: adaptApprovalBus(kafkaBus) } : {}),
      auditEmit: async (event) => {
        // Stream audit events to the structured logger; downstream
        // log shipping (Loki/Datadog) becomes the audit trail. A
        // dedicated outbox sink can replace this without touching the
        // runtime.
        logger.info({ ...event, audit: true }, `audit.${event.kind}`);
      },
      ...(langfuse ? { emitTrace: (event) => langfuse!.emit(event) } : {}),
    });
  };

  const shutdown = async (): Promise<void> => {
    const errors: unknown[] = [];
    if (kafkaBus) {
      await kafkaBus.stop().catch((e) => errors.push(e));
    }
    if (dbPrompts) {
      await dbPrompts.close().catch((e) => errors.push(e));
    }
    if (redis) {
      await redis.quit().catch((e) => errors.push(e));
    }
    if (errors.length > 0) {
      logger.warn({ errors: errors.map((e) => (e as Error).message) }, "shutdown_partial");
    }
  };

  return {
    agents,
    prompts,
    promptAdmin: dbPrompts,
    tools,
    gateway,
    memory,
    approvalBus,
    shutdown,
    buildRuntime,
  };
}


