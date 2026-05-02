/**
 * HTTP server tests for the Express agent-service.
 *
 * Composes a server with stubbed dependencies (no live LLM, no Redis,
 * no Kafka) and exercises the routes via supertest.
 */

import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { z } from "zod";
import { buildServer } from "../server.js";
import { AgentRuntime } from "../runtime/AgentRuntime.js";
import { StaticAgentRegistry } from "../registry/AgentRegistry.js";
import { InMemoryPromptRegistry } from "../registry/PromptRegistry.js";
import { InMemoryToolRegistry } from "../registry/ToolRegistry.js";
import { InMemoryShortTermMemory } from "../memory/ShortTermMemory.js";
import type { IModelGateway, ModelResponse } from "../gateway/ModelGateway.js";
import type { AgentServiceDeps } from "../composition.js";

function buildStubDeps(modelResponse: ModelResponse): AgentServiceDeps {
  const agents = new StaticAgentRegistry();
  const prompts = new InMemoryPromptRegistry();
  const tools = new InMemoryToolRegistry();
  const memory = new InMemoryShortTermMemory();
  const gateway: IModelGateway = { complete: vi.fn(async () => modelResponse) };
  return {
    agents,
    prompts,
    promptAdmin: null,
    tools,
    gateway,
    memory,
    approvalBus: undefined,
    shutdown: async () => undefined,
    buildRuntime: ({ agentId, sessionId }) =>
      new AgentRuntime({
        agentId,
        sessionId,
        registries: { agents, prompts, tools },
        gateway,
        memory,
        toolDispatcher: async (call) => ({
          callId: call.callId,
          name: call.name,
          output: { ok: true },
        }),
        emitTrace: async () => "trace-test",
      }),
  };
}

const okResponse: ModelResponse = {
  text: "Hello from the agent.",
  toolCalls: [],
  model: "stub-model",
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  latencyMs: 1,
};

describe("agent-service HTTP server", () => {
  it("GET /healthz returns ok", async () => {
    const app = buildServer(buildStubDeps(okResponse));
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("GET /metrics returns prom-client formatted metrics", async () => {
    const app = buildServer(buildStubDeps(okResponse));
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.text).toContain("epplaa_agent_");
  });

  it("GET /agents lists configured agents", async () => {
    const app = buildServer(buildStubDeps(okResponse));
    const res = await request(app).get("/agents");
    expect(res.status).toBe(200);
    expect(res.body.agents).toBeInstanceOf(Array);
    const ids = res.body.agents.map((a: { id: string }) => a.id);
    expect(ids).toContain("vendor-onboarding");
    expect(ids).toContain("buyer-concierge");
  });

  it("POST /agents/:agentId/messages returns the model response", async () => {
    const app = buildServer(buildStubDeps(okResponse));
    const res = await request(app)
      .post("/agents/vendor-onboarding/messages")
      .send({ sessionId: "sess-1", message: "I'd like to start selling shoes." });
    expect(res.status).toBe(200);
    expect(res.body.response).toBe("Hello from the agent.");
    expect(res.body.awaitedApproval).toBe(false);
    expect(res.body.traceId).toBe("trace-test");
    expect(res.body.agentId).toBe("vendor-onboarding");
  });

  it("POST returns 404 for unknown agent", async () => {
    const app = buildServer(buildStubDeps(okResponse));
    const res = await request(app)
      .post("/agents/nope/messages")
      .send({ sessionId: "s", message: "hi" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("unknown_agent");
  });

  it("POST returns 400 for invalid body", async () => {
    const app = buildServer(buildStubDeps(okResponse));
    const res = await request(app)
      .post("/agents/vendor-onboarding/messages")
      .send({ sessionId: "" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("POST returns 502 when the gateway throws", async () => {
    const deps = buildStubDeps(okResponse);
    deps.buildRuntime = () =>
      ({ handle: async () => { throw new Error("gateway down"); } } as unknown as AgentRuntime);
    const app = buildServer(deps);
    const res = await request(app)
      .post("/agents/vendor-onboarding/messages")
      .send({ sessionId: "s", message: "hi" });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("agent_runtime_failure");
  });
});

describe("PromptRegistry", () => {
  it("loads vendor-onboarding/v1 with non-placeholder content", async () => {
    const registry = new InMemoryPromptRegistry();
    const prompt = await registry.load("prompts/vendor-onboarding/v1");
    expect(prompt.systemPrompt).toContain("Vendor Onboarding Agent");
    expect(prompt.systemPrompt).not.toContain("TODO");
  });

  it("throws on unknown ref", async () => {
    const registry = new InMemoryPromptRegistry();
    await expect(registry.load("prompts/nope/v1")).rejects.toThrow(/unknown ref/);
  });

  it("all five production agents have non-stub prompts", async () => {
    const registry = new InMemoryPromptRegistry();
    const prompts = await registry.list();
    expect(prompts).toHaveLength(5);
    for (const p of prompts) {
      expect(p.systemPrompt).not.toContain("TODO");
      expect(p.systemPrompt.length).toBeGreaterThan(200);
    }
  });
});

// Reference z so an unused-import lint rule wouldn't complain if we later
// inline schemas here.
void z;
