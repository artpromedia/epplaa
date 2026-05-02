/**
 * Prompt-eval harness — Wave 4 slice 7.
 *
 * Goal: provide a deterministic, CI-runnable check that a prompt under
 * test (typically a candidate prompt sitting in PromptRegistry as
 * `is_active=false`) still satisfies the golden-set expectations
 * defined per agent. This is the gate that sits between an admin
 * creating a draft (slice 4) and the admin flipping `is_active=true`.
 *
 * Design notes:
 *
 * - The harness is *transport-agnostic*: callers inject a `runner`
 *   callable that, given a prompt + user message, returns the model's
 *   text response. In tests we use a deterministic stub; in CI/prod
 *   we'll wrap the real LiteLLM gateway.
 * - Expectations are a closed enum (contains | not_contains | regex |
 *   max_latency_ms) so adding a new check type is intentional.
 * - Failures collect every expectation that didn't match for a case;
 *   we don't short-circuit, so the operator sees the full delta in a
 *   single run.
 */

export type PromptEvalExpectation =
  | { type: "contains"; value: string; caseInsensitive?: boolean }
  | { type: "not_contains"; value: string; caseInsensitive?: boolean }
  | { type: "regex"; pattern: string; flags?: string }
  | { type: "max_latency_ms"; value: number };

export interface PromptEvalCase {
  /** Stable identifier for the case; appears in the report. */
  id: string;
  /** User message fed to the agent under the prompt under test. */
  message: string;
  /** Expectations that MUST all hold for this case to be green. */
  expectations: PromptEvalExpectation[];
}

export interface PromptEvalRunInput {
  /** The prompt text being evaluated (typically the candidate draft). */
  prompt: string;
  message: string;
}

export interface PromptEvalRunOutput {
  text: string;
  latencyMs: number;
}

/** Pluggable runner — stub in tests, real LiteLLM in CI/prod. */
export type PromptEvalRunner = (input: PromptEvalRunInput) => Promise<PromptEvalRunOutput>;

export interface PromptEvalCaseResult {
  caseId: string;
  passed: boolean;
  output: PromptEvalRunOutput;
  failures: Array<{ expectation: PromptEvalExpectation; reason: string }>;
}

export interface PromptEvalReport {
  prompt: string;
  passed: boolean;
  total: number;
  passedCount: number;
  failedCount: number;
  cases: PromptEvalCaseResult[];
}

function checkExpectation(
  expectation: PromptEvalExpectation,
  output: PromptEvalRunOutput,
): { ok: true } | { ok: false; reason: string } {
  switch (expectation.type) {
    case "contains": {
      const haystack = expectation.caseInsensitive ? output.text.toLowerCase() : output.text;
      const needle = expectation.caseInsensitive ? expectation.value.toLowerCase() : expectation.value;
      return haystack.includes(needle)
        ? { ok: true }
        : { ok: false, reason: `expected output to contain "${expectation.value}"` };
    }
    case "not_contains": {
      const haystack = expectation.caseInsensitive ? output.text.toLowerCase() : output.text;
      const needle = expectation.caseInsensitive ? expectation.value.toLowerCase() : expectation.value;
      return !haystack.includes(needle)
        ? { ok: true }
        : { ok: false, reason: `expected output NOT to contain "${expectation.value}"` };
    }
    case "regex": {
      let re: RegExp;
      try {
        re = new RegExp(expectation.pattern, expectation.flags);
      } catch (err) {
        return { ok: false, reason: `invalid regex: ${(err as Error).message}` };
      }
      return re.test(output.text)
        ? { ok: true }
        : { ok: false, reason: `expected output to match /${expectation.pattern}/${expectation.flags ?? ""}` };
    }
    case "max_latency_ms": {
      return output.latencyMs <= expectation.value
        ? { ok: true }
        : {
            ok: false,
            reason: `latency ${output.latencyMs}ms exceeded budget ${expectation.value}ms`,
          };
    }
  }
}

/**
 * Evaluate a prompt against a golden set. Returns a structured report.
 * Never throws on individual case failure — caller decides how to react
 * (CLI exits non-zero; an admin-route gate would refuse activation).
 */
export async function evaluatePrompt(args: {
  prompt: string;
  cases: PromptEvalCase[];
  runner: PromptEvalRunner;
}): Promise<PromptEvalReport> {
  const caseResults: PromptEvalCaseResult[] = [];
  for (const c of args.cases) {
    const output = await args.runner({ prompt: args.prompt, message: c.message });
    const failures: PromptEvalCaseResult["failures"] = [];
    for (const expectation of c.expectations) {
      const result = checkExpectation(expectation, output);
      if (!result.ok) failures.push({ expectation, reason: result.reason });
    }
    caseResults.push({
      caseId: c.id,
      passed: failures.length === 0,
      output,
      failures,
    });
  }
  const passedCount = caseResults.filter((r) => r.passed).length;
  return {
    prompt: args.prompt,
    cases: caseResults,
    total: caseResults.length,
    passedCount,
    failedCount: caseResults.length - passedCount,
    passed: passedCount === caseResults.length,
  };
}

/** Pretty one-line-per-case summary suitable for CI logs. */
export function formatReport(report: PromptEvalReport): string {
  const lines = [
    `prompt-eval: ${report.passedCount}/${report.total} cases passed`,
  ];
  for (const c of report.cases) {
    if (c.passed) {
      lines.push(`  PASS ${c.caseId}`);
    } else {
      lines.push(`  FAIL ${c.caseId}`);
      for (const f of c.failures) {
        lines.push(`    - ${f.reason}`);
      }
    }
  }
  return lines.join("\n");
}
