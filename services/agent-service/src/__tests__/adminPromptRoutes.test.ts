/**
 * Tests for the /admin/prompts routes mounted by buildServer when a
 * promptAdmin store is supplied. We stub the IPromptAdminStore so the
 * tests exercise route wiring + auth + error mapping rather than the
 * Postgres path (covered separately by DbPromptRegistry tests).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { buildServer } from "../server.js";
import { AgentRuntime } from "../runtime/AgentRuntime.js";
import { StaticAgentRegistry } from "../registry/AgentRegistry.js";
import { InMemoryPromptRegistry } from "../registry/PromptRegistry.js";
import { InMemoryToolRegistry } from "../registry/ToolRegistry.js";
import { InMemoryShortTermMemory } from "../memory/ShortTermMemory.js";
import type {
  IPromptAdminStore,
  PromptAdminRow,
  CreatePromptInput,
} from "../registry/PromptRegistry.js";
import type { IModelGateway, ModelResponse } from "../gateway/ModelGateway.js";
import type { AgentServiceDeps } from "../composition.js";

const ADMIN_TOKEN = "test-admin-token-with-at-least-32-bytes-XXXX";

const sampleRow: PromptAdminRow = {
  id: "prompt_buyer-concierge_v2_abc",
  ref: "prompts/buyer-concierge/v2",
  family: "buyer-concierge",
  version: "v2",
  systemPrompt: "# Identity\nBuyer concierge v2",
  isActive: false,
  activatedAt: null,
  createdAt: "2026-05-01T00:00:00.000Z",
  createdBy: null,
};

function buildStubAdmin(): IPromptAdminStore {
  return {
    listAll: vi.fn(async () => [sampleRow]),
    getOne: vi.fn(async (ref: string) =>
      ref === sampleRow.ref ? sampleRow : null,
    ),
    create: vi.fn(async (input: CreatePromptInput) => ({
      ...sampleRow,
      ref: input.ref,
      family: input.family,
      version: input.version,
      systemPrompt: input.systemPrompt,
      createdBy: input.createdBy ?? null,
    })),
    activate: vi.fn(async (ref: string) => {
      if (ref !== sampleRow.ref) {
        throw new Error(`PromptRegistry: cannot activate unknown ref '${ref}'`);
      }
      return { ...sampleRow, isActive: true, activatedAt: "2026-05-02T00:00:00.000Z" };
    }),
  };
}

function buildDeps(admin: IPromptAdminStore | null): AgentServiceDeps {
  const agents = new StaticAgentRegistry();
  const prompts = new InMemoryPromptRegistry();
  const tools = new InMemoryToolRegistry();
  const memory = new InMemoryShortTermMemory();
  const modelResponse: ModelResponse = {
    text: "ok",
    toolCalls: [],
    model: "stub",
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    latencyMs: 0,
  };
  const gateway: IModelGateway = { complete: vi.fn(async () => modelResponse) };
  return {
    agents,
    prompts,
    promptAdmin: admin,
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

describe("admin prompt routes", () => {
  let savedToken: string | undefined;
  beforeEach(() => {
    savedToken = process.env.AGENT_ADMIN_TOKEN;
    process.env.AGENT_ADMIN_TOKEN = ADMIN_TOKEN;
  });
  afterEach(() => {
    if (savedToken === undefined) delete process.env.AGENT_ADMIN_TOKEN;
    else process.env.AGENT_ADMIN_TOKEN = savedToken;
  });

  it("does not mount /admin routes when promptAdmin is null", async () => {
    const app = buildServer(buildDeps(null));
    const res = await request(app)
      .get("/admin/prompts")
      .set("authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(404);
  });

  it("rejects unauthenticated admin requests", async () => {
    const app = buildServer(buildDeps(buildStubAdmin()));
    const res = await request(app).get("/admin/prompts");
    expect(res.status).toBe(401);
  });

  it("rejects requests when AGENT_ADMIN_TOKEN is unset", async () => {
    delete process.env.AGENT_ADMIN_TOKEN;
    const app = buildServer(buildDeps(buildStubAdmin()));
    const res = await request(app)
      .get("/admin/prompts")
      .set("authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("admin_unavailable");
  });

  it("rejects an admin token shorter than 32 bytes", async () => {
    process.env.AGENT_ADMIN_TOKEN = "tooshort";
    const app = buildServer(buildDeps(buildStubAdmin()));
    const res = await request(app)
      .get("/admin/prompts")
      .set("authorization", "Bearer tooshort");
    expect(res.status).toBe(503);
  });

  it("GET /admin/prompts returns the list", async () => {
    const admin = buildStubAdmin();
    const app = buildServer(buildDeps(admin));
    const res = await request(app)
      .get("/admin/prompts")
      .set("authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.prompts).toHaveLength(1);
    expect(admin.listAll).toHaveBeenCalledTimes(1);
  });

  it("GET /admin/prompts/:ref returns a single row", async () => {
    const app = buildServer(buildDeps(buildStubAdmin()));
    const res = await request(app)
      .get(`/admin/prompts/${encodeURIComponent(sampleRow.ref)}`)
      .set("authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.ref).toBe(sampleRow.ref);
  });

  it("GET /admin/prompts/:ref returns 404 for unknown ref", async () => {
    const app = buildServer(buildDeps(buildStubAdmin()));
    const res = await request(app)
      .get("/admin/prompts/prompts%2Fno%2Fv1")
      .set("authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(404);
  });

  it("POST /admin/prompts creates a draft and returns 201", async () => {
    const admin = buildStubAdmin();
    const app = buildServer(buildDeps(admin));
    const res = await request(app)
      .post("/admin/prompts")
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({
        ref: "prompts/buyer-concierge/v3",
        family: "buyer-concierge",
        version: "v3",
        systemPrompt: "# Identity\nv3",
      });
    expect(res.status).toBe(201);
    expect(res.body.ref).toBe("prompts/buyer-concierge/v3");
    expect(admin.create).toHaveBeenCalledTimes(1);
  });

  it("POST /admin/prompts validates the body", async () => {
    const app = buildServer(buildDeps(buildStubAdmin()));
    const res = await request(app)
      .post("/admin/prompts")
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ ref: "x" }); // missing fields
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("POST /admin/prompts maps duplicate-key errors to 409", async () => {
    const admin = buildStubAdmin();
    (admin.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('duplicate key value violates unique constraint "prompts_ref_idx"'),
    );
    const app = buildServer(buildDeps(admin));
    const res = await request(app)
      .post("/admin/prompts")
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({
        ref: "prompts/buyer-concierge/v2",
        family: "buyer-concierge",
        version: "v2",
        systemPrompt: "#",
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("ref_exists");
  });

  it("POST /admin/prompts/:ref/activate flips the active row", async () => {
    const admin = buildStubAdmin();
    const app = buildServer(buildDeps(admin));
    const res = await request(app)
      .post(`/admin/prompts/${encodeURIComponent(sampleRow.ref)}/activate`)
      .set("authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(true);
    expect(admin.activate).toHaveBeenCalledWith(sampleRow.ref);
  });

  it("POST /admin/prompts/:ref/activate maps unknown ref to 404", async () => {
    const app = buildServer(buildDeps(buildStubAdmin()));
    const res = await request(app)
      .post("/admin/prompts/prompts%2Fnope%2Fv1/activate")
      .set("authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(404);
  });

  it("activate runs prompt-eval gate when evalCases provided and refuses on failure", async () => {
    const admin = buildStubAdmin();
    const deps = buildDeps(admin);
    // Stub gateway returns text that does NOT contain the required phrase.
    (deps.gateway.complete as ReturnType<typeof vi.fn>).mockImplementation(
      async () => ({
        text: "i cannot help",
        toolCalls: [],
        model: "stub",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        latencyMs: 1,
      }),
    );
    const app = buildServer(deps);
    const res = await request(app)
      .post(`/admin/prompts/${encodeURIComponent(sampleRow.ref)}/activate`)
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({
        evalCases: [
          {
            id: "must-greet",
            message: "hi",
            expectations: [{ type: "contains", value: "welcome" }],
          },
        ],
      });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("eval_failed");
    expect(admin.activate).not.toHaveBeenCalled();
  });

  it("activate proceeds when prompt-eval gate passes", async () => {
    const admin = buildStubAdmin();
    const deps = buildDeps(admin);
    (deps.gateway.complete as ReturnType<typeof vi.fn>).mockImplementation(
      async () => ({
        text: "welcome to epplaa",
        toolCalls: [],
        model: "stub",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        latencyMs: 1,
      }),
    );
    const app = buildServer(deps);
    const res = await request(app)
      .post(`/admin/prompts/${encodeURIComponent(sampleRow.ref)}/activate`)
      .set("authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({
        evalCases: [
          {
            id: "must-greet",
            message: "hi",
            expectations: [{ type: "contains", value: "welcome" }],
          },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(true);
    expect(admin.activate).toHaveBeenCalledWith(sampleRow.ref);
  });

  it("activate refuses with 412 when AGENT_REQUIRE_EVAL_FOR_ACTIVATION=true and no cases", async () => {
    const prev = process.env["AGENT_REQUIRE_EVAL_FOR_ACTIVATION"];
    process.env["AGENT_REQUIRE_EVAL_FOR_ACTIVATION"] = "true";
    // Need to reload the module so the const captures the new env value.
    vi.resetModules();
    const { buildServer: buildServerFresh } = await import("../server.js");
    try {
      const admin = buildStubAdmin();
      const app = buildServerFresh(buildDeps(admin));
      const res = await request(app)
        .post(`/admin/prompts/${encodeURIComponent(sampleRow.ref)}/activate`)
        .set("authorization", `Bearer ${ADMIN_TOKEN}`)
        .send({});
      expect(res.status).toBe(412);
      expect(res.body.error).toBe("eval_required");
      expect(admin.activate).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env["AGENT_REQUIRE_EVAL_FOR_ACTIVATION"];
      else process.env["AGENT_REQUIRE_EVAL_FOR_ACTIVATION"] = prev;
    }
  });
});
