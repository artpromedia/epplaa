import { describe, it, expect, vi } from "vitest";
import { AgentRuntime, type ApprovalAuditEvent } from "../runtime/AgentRuntime.js";
import { StaticAgentRegistry } from "../registry/AgentRegistry.js";
import { InMemoryPromptRegistry } from "../registry/PromptRegistry.js";
import { InMemoryToolRegistry } from "../registry/ToolRegistry.js";
import { InMemoryShortTermMemory } from "../memory/ShortTermMemory.js";
import type { IModelGateway, ModelResponse } from "../gateway/ModelGateway.js";
import type { ToolCall, ToolDescriptor, ToolResult } from "../registry/ToolRegistry.js";

// buyer-concierge already lists payment.refund_request which is a
// single-human approval tool — exactly what we need to exercise the bus.
const refundCall: ToolCall = {
  callId: "c1",
  name: "payment.refund_request",
  args: {
    paymentId: "11111111-1111-1111-1111-111111111111",
    amountNgn: 1000,
    reason: "broken on arrival",
  },
};

const baseModelResponse: ModelResponse = {
  text: "Initiating refund.",
  toolCalls: [refundCall],
  model: "stub",
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  latencyMs: 0,
};

function buildRuntime(opts: {
  modelResponse: ModelResponse;
  approvalBus: NonNullable<ConstructorParameters<typeof AgentRuntime>[0]["approvalBus"]>;
  toolDispatcher: (call: ToolCall, desc: ToolDescriptor) => Promise<ToolResult>;
  auditEmit?: (e: ApprovalAuditEvent) => Promise<void>;
}): AgentRuntime {
  const agents = new StaticAgentRegistry();
  const prompts = new InMemoryPromptRegistry();
  const tools = new InMemoryToolRegistry();
  const memory = new InMemoryShortTermMemory();
  const gateway: IModelGateway = { complete: vi.fn(async () => opts.modelResponse) };

  return new AgentRuntime({
    agentId: "buyer-concierge",
    sessionId: "session-1",
    registries: { agents, prompts, tools },
    gateway,
    memory,
    toolDispatcher: opts.toolDispatcher,
    approvalBus: opts.approvalBus,
    ...(opts.auditEmit ? { auditEmit: opts.auditEmit } : {}),
  });
}

describe("AgentRuntime — approval bus loop", () => {
  it("auto-dispatches the tool after the operator approves", async () => {
    const audit: ApprovalAuditEvent[] = [];
    const dispatcher = vi.fn(async (call: ToolCall): Promise<ToolResult> => ({
      callId: call.callId,
      name: call.name,
      output: { refundId: "rf_1", status: "initiated" },
    }));
    const runtime = buildRuntime({
      modelResponse: baseModelResponse,
      approvalBus: {
        requestApproval: async () => ({
          approved: true,
          approvedBy: "user_op_42",
          decidedAt: "2026-05-02T00:00:00Z",
        }),
      },
      toolDispatcher: dispatcher,
      auditEmit: async (e) => {
        audit.push(e);
      },
    });
    const out = await runtime.handle({ message: "refund my order", receivedAt: "2026-05-02T00:00:00Z" });
    expect(out.awaitedApproval).toBe(true);
    expect(dispatcher).toHaveBeenCalledTimes(1);
    expect(audit.map((e) => e.kind)).toEqual([
      "tool_proposed",
      "tool_approved",
      "tool_dispatched",
    ]);
  });

  it("does NOT dispatch the tool when the operator rejects", async () => {
    const audit: ApprovalAuditEvent[] = [];
    const dispatcher = vi.fn(async () => {
      throw new Error("must not be called");
    });
    const runtime = buildRuntime({
      modelResponse: baseModelResponse,
      approvalBus: {
        requestApproval: async () => ({
          approved: false,
          kind: "rejected",
          reason: "policy violation",
          decidedBy: "user_op_42",
        }),
      },
      toolDispatcher: dispatcher,
      auditEmit: async (e) => {
        audit.push(e);
      },
    });
    const out = await runtime.handle({ message: "refund", receivedAt: "2026-05-02T00:00:00Z" });
    expect(out.awaitedApproval).toBe(true);
    expect(dispatcher).not.toHaveBeenCalled();
    expect(audit.map((e) => e.kind)).toEqual(["tool_proposed", "tool_rejected"]);
    const rejected = audit.find((e) => e.kind === "tool_rejected");
    expect(rejected).toMatchObject({ reason: "policy violation", decidedBy: "user_op_42" });
  });

  it("emits tool_dispatch_failed when the post-approval dispatch throws", async () => {
    const audit: ApprovalAuditEvent[] = [];
    const dispatcher = vi.fn(async () => {
      throw new Error("monolith down");
    });
    const runtime = buildRuntime({
      modelResponse: baseModelResponse,
      approvalBus: {
        requestApproval: async () => ({
          approved: true,
          approvedBy: "user_op_42",
          decidedAt: "2026-05-02T00:00:00Z",
        }),
      },
      toolDispatcher: dispatcher,
      auditEmit: async (e) => {
        audit.push(e);
      },
    });
    const out = await runtime.handle({ message: "refund", receivedAt: "2026-05-02T00:00:00Z" });
    expect(out.awaitedApproval).toBe(true);
    expect(audit.map((e) => e.kind)).toEqual([
      "tool_proposed",
      "tool_approved",
      "tool_dispatch_failed",
    ]);
  });

  it("treats bus transport errors as a non-approval (kind=error)", async () => {
    const audit: ApprovalAuditEvent[] = [];
    const dispatcher = vi.fn(async () => {
      throw new Error("must not be called");
    });
    const runtime = buildRuntime({
      modelResponse: baseModelResponse,
      approvalBus: {
        requestApproval: async () => ({
          approved: false,
          kind: "error",
          reason: "kafka unreachable",
        }),
      },
      toolDispatcher: dispatcher,
      auditEmit: async (e) => {
        audit.push(e);
      },
    });
    const out = await runtime.handle({ message: "refund", receivedAt: "2026-05-02T00:00:00Z" });
    expect(out.awaitedApproval).toBe(true);
    expect(dispatcher).not.toHaveBeenCalled();
    expect(audit.at(-1)?.kind).toBe("tool_rejected");
  });

  it("does not break the run when auditEmit itself throws", async () => {
    const dispatcher = vi.fn(async (call: ToolCall): Promise<ToolResult> => ({
      callId: call.callId,
      name: call.name,
      output: { refundId: "rf_2", status: "initiated" },
    }));
    const runtime = buildRuntime({
      modelResponse: baseModelResponse,
      approvalBus: {
        requestApproval: async () => ({
          approved: true,
          approvedBy: "user_op_42",
          decidedAt: "2026-05-02T00:00:00Z",
        }),
      },
      toolDispatcher: dispatcher,
      auditEmit: async () => {
        throw new Error("audit sink down");
      },
    });
    await expect(
      runtime.handle({ message: "refund", receivedAt: "2026-05-02T00:00:00Z" }),
    ).resolves.toMatchObject({ awaitedApproval: true });
    expect(dispatcher).toHaveBeenCalledTimes(1);
  });
});
