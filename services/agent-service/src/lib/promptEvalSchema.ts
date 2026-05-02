/**
 * Shared zod schema for prompt-eval cases.
 *
 * Used by both the CLI (scripts/promptEval.ts) and the
 * /admin/prompts/:ref/activate gate so the wire formats stay aligned.
 */

import { z } from "zod";

export const promptEvalExpectationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("contains"),
    value: z.string(),
    caseInsensitive: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("not_contains"),
    value: z.string(),
    caseInsensitive: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("regex"),
    pattern: z.string(),
    flags: z.string().optional(),
  }),
  z.object({
    type: z.literal("max_latency_ms"),
    value: z.number().positive(),
  }),
]);

export const promptEvalCaseSchema = z.object({
  id: z.string().min(1),
  message: z.string().min(1),
  expectations: z.array(promptEvalExpectationSchema).min(1),
});

export const promptEvalGoldenSchema = z.object({
  agent: z.string(),
  description: z.string().optional(),
  cases: z.array(promptEvalCaseSchema).min(1),
});
