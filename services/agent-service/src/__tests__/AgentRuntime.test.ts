/**
 * Smoke test for AgentRuntime (AI Sprint 0 exit criterion).
 *
 * Asserts that AgentRuntime can be imported and constructed cleanly
 * without requiring any live dependencies (no Redis, no LiteLLM, no
 * Redpanda). This is the minimal CI gate for the scaffolding sprint.
 *
 * Full lifecycle tests (golden-case coverage) are delivered in AI Sprint 1.
 */

import { describe, it, expect } from "vitest";
import { AgentRuntime } from "../runtime/AgentRuntime.js";

describe("AgentRuntime (smoke test — AI Sprint 0)", () => {
  it("constructs without throwing", () => {
    expect(
      () =>
        new AgentRuntime({
          agentId: "vendor-onboarding",
          sessionId: "test-session-001",
        }),
    ).not.toThrow();
  });

  it("exposes a handle() method", () => {
    const runtime = new AgentRuntime({
      agentId: "buyer-concierge",
      sessionId: "test-session-002",
    });
    expect(typeof runtime.handle).toBe("function");
  });
});
