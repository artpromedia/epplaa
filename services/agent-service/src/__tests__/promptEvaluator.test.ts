import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  evaluatePrompt,
  formatReport,
  type PromptEvalCase,
  type PromptEvalRunner,
} from "../lib/promptEvaluator.js";

const passingRunner: PromptEvalRunner = async ({ message }) => ({
  text:
    message.toLowerCase().includes("card") || message.toLowerCase().includes("credit")
      ? "I cannot share payment card details."
      : message.toLowerCase().includes("sue") || message.toLowerCase().includes("lawyer")
        ? "Let me escalate this to a human agent."
        : "Let me look up your order right away.",
  latencyMs: 5,
});

describe("PromptEvaluator", () => {
  it("returns passed=true when every expectation matches", async () => {
    const cases: PromptEvalCase[] = [
      {
        id: "c1",
        message: "where is my order",
        expectations: [
          { type: "contains", value: "order", caseInsensitive: true },
          { type: "not_contains", value: "I cannot help" },
          { type: "regex", pattern: "look up", flags: "i" },
          { type: "max_latency_ms", value: 100 },
        ],
      },
    ];
    const report = await evaluatePrompt({ prompt: "be helpful", cases, runner: passingRunner });
    expect(report.passed).toBe(true);
    expect(report.passedCount).toBe(1);
    expect(report.cases[0]?.failures).toHaveLength(0);
  });

  it("reports per-expectation failures without short-circuiting", async () => {
    const cases: PromptEvalCase[] = [
      {
        id: "c1",
        message: "hello",
        expectations: [
          { type: "contains", value: "missing-word" },
          { type: "not_contains", value: "Let me", caseInsensitive: false },
          { type: "regex", pattern: "^never$" },
          { type: "max_latency_ms", value: 1 },
        ],
      },
    ];
    const report = await evaluatePrompt({ prompt: "p", cases, runner: passingRunner });
    expect(report.passed).toBe(false);
    expect(report.failedCount).toBe(1);
    const failures = report.cases[0]?.failures ?? [];
    // All four expectations should be flagged.
    expect(failures).toHaveLength(4);
    expect(failures.map((f) => f.expectation.type).sort()).toEqual([
      "contains",
      "max_latency_ms",
      "not_contains",
      "regex",
    ]);
  });

  it("treats invalid regex as a failure rather than throwing", async () => {
    const cases: PromptEvalCase[] = [
      {
        id: "bad-regex",
        message: "x",
        expectations: [{ type: "regex", pattern: "(unclosed" }],
      },
    ];
    const report = await evaluatePrompt({ prompt: "p", cases, runner: passingRunner });
    expect(report.passed).toBe(false);
    expect(report.cases[0]?.failures[0]?.reason).toMatch(/invalid regex/);
  });

  it("formatReport produces a legible per-case summary", async () => {
    const cases: PromptEvalCase[] = [
      {
        id: "c1",
        message: "where is my order",
        expectations: [{ type: "contains", value: "order" }],
      },
      {
        id: "c2",
        message: "hi",
        expectations: [{ type: "contains", value: "missing" }],
      },
    ];
    const report = await evaluatePrompt({ prompt: "p", cases, runner: passingRunner });
    const text = formatReport(report);
    expect(text).toMatch(/1\/2 cases passed/);
    expect(text).toMatch(/PASS c1/);
    expect(text).toMatch(/FAIL c2/);
    expect(text).toMatch(/expected output to contain "missing"/);
  });

  it("buyer-concierge.json golden parses and runs against the deterministic stub used in the CLI", async () => {
    // Re-implement the same stub as in scripts/promptEval.ts so the
    // shape of the golden is exercised end-to-end.
    const stubRunner: PromptEvalRunner = async ({ prompt, message }) => {
      const lower = message.toLowerCase();
      let text = "I will help you with your request.";
      if (lower.includes("order")) text += " Let me look up your order.";
      if (lower.includes("credit card") || lower.includes("card")) {
        text = "I cannot share payment card details.";
      }
      if (lower.includes("sue") || lower.includes("lawyer")) {
        text = "Let me escalate this to a human agent for review.";
      }
      return { text: `${text} [prompt:${prompt.length}b]`, latencyMs: 5 };
    };

    const goldenPath = path.resolve(__dirname, "../../golden/buyer-concierge.json");
    const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as {
      cases: PromptEvalCase[];
    };
    const report = await evaluatePrompt({
      prompt: "buyer-concierge candidate prompt body",
      cases: golden.cases,
      runner: stubRunner,
    });
    expect(report.passed).toBe(true);
    expect(report.total).toBeGreaterThanOrEqual(3);
  });
});
