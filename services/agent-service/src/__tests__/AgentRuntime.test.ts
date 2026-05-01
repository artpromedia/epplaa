/**
 * AgentRuntime tests (AI Sprint 1 — wired lifecycle).
 *
 * Sprint 1 covers construction, golden-path lifecycle (load → call →
 * validate → dispatch → memory append) with all dependencies stubbed,
 * and tool-call rejection when the model proposes an unauthorised tool.
 */

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { AgentRuntime } from "../runtime/AgentRuntime.js";
import { StaticAgentRegistry } from "../registry/AgentRegistry.js";
import { InMemoryPromptRegistry } from "../registry/PromptRegistry.js";
import { InMemoryToolRegistry } from "../registry/ToolRegistry.js";
import { InMemoryShortTermMemory } from "../memory/ShortTermMemory.js";
import type { IModelGateway, ModelResponse } from "../gateway/ModelGateway.js";

function buildRuntime({
  modelResponse,
  agentId = "buyer-concierge",
}: {
  modelResponse: ModelResponse;
  agentId?: string;
}) {
  const gateway: IModelGateway = {
    complete: vi.fn(async () => modelResponse),
  };
  const dispatched: string[] = [];
  const runtime = new AgentRuntime({
    agentId,
    sessionId: "test-session-001",
    registries: {
      agents: new StaticAgentRegistry(),
      prompts: new InMemoryPromptRegistry(),
      tools: new InMemoryToolRegistry(),
    },
    gateway,
    memory: new InMemoryShortTermMemory(),
    toolDispatcher: async (call) => {
      dispatched.push(call.name);
      return { callId: call.callId, name: call.name, output: { stub: true } };
    },
    emitTrace: async () => "trace-stub",
  });
  return { runtime, gateway, dispatched };
}

describe("AgentRuntime", () => {
  it("happy path: returns model text with no tool calls", async () => {
    const { runtime } = buildRuntime({
      modelResponse: {
        text: "Hi there!",
        toolCalls: [],
        model: "claude-3-5-sonnet-20241022",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        latencyMs: 42,
      },
    });

    const out = await runtime.handle({
      message: "hello",
      receivedAt: "2026-05-01T00:00:00.000Z",
    });
    expect(out.response).toBe("Hi there!");
    expect(out.awaitedApproval).toBe(false);
    expect(out.traceId).toBe("trace-stub");
  });

  it("dispatches an authorised, no-approval tool call", async () => {
    const { runtime, dispatched } = buildRuntime({
      modelResponse: {
        text: "",
        toolCalls: [
          {
            name: "catalog.search",
            args: { query: "shoes" },
            callId: "c1",
          },
        ],
        model: "claude-3-5-sonnet-20241022",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        latencyMs: 42,
      },
    });

    await runtime.handle({ message: "find shoes", receivedAt: "2026-05-01T00:00:00.000Z" });
    expect(dispatched).toEqual(["catalog.search"]);
  });

  it("filters out tool calls the agent isn't authorised to make", async () => {
    const { runtime, dispatched } = buildRuntime({
      modelResponse: {
        text: "",
        toolCalls: [
          // listing.auto_takedown is the Fraud agent's tool, not buyer-concierge's.
          { name: "listing.auto_takedown", args: { listingId: "l_1" }, callId: "c1" },
        ],
        model: "claude-3-5-sonnet-20241022",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        latencyMs: 42,
      },
    });

    await runtime.handle({ message: "noop", receivedAt: "2026-05-01T00:00:00.000Z" });
    expect(dispatched).toEqual([]);
  });

  it("filters out tool calls with invalid args", async () => {
    const { runtime, dispatched } = buildRuntime({
      modelResponse: {
        text: "",
        toolCalls: [
          // catalog.search expects { query: string }; sending a number is rejected.
          { name: "catalog.search", args: { query: 42 }, callId: "c1" },
        ],
        model: "claude-3-5-sonnet-20241022",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        latencyMs: 42,
      },
    });

    await runtime.handle({ message: "noop", receivedAt: "2026-05-01T00:00:00.000Z" });
    expect(dispatched).toEqual([]);
  });
});

// Ensure the smoke-test promise from Sprint 0 still holds.
describe("AgentRuntime — Sprint 0 smoke", () => {
  it("exposes a handle() method", () => {
    const { runtime } = buildRuntime({
      modelResponse: {
        text: "",
        toolCalls: [],
        model: "x",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        latencyMs: 0,
      },
    });
    expect(typeof runtime.handle).toBe("function");
  });
});

// Avoid unused warning for z import (linter-friendly).
void z;
