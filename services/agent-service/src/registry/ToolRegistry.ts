/**
 * ToolRegistry — typed tool descriptor and in-memory stub registry.
 *
 * @see §14.7.1 (Tool descriptor fields)
 * @see §14.7.2 (High-traffic tool subset)
 * @see ADR-014 (autonomy ceiling — approval threshold defaults)
 *
 * IMPORTANT (ADR-014): Every tool that touches money, accounts, or external
 * communications MUST have approvalThreshold: 'single-human'. This default
 * cannot be overridden via LLM output or agent configuration.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Tool descriptor types
// ---------------------------------------------------------------------------

export type ApprovalThreshold = "none" | "single-human";
export type AuditLogPolicy = "always" | "on-approval" | "never";

export interface RateLimit {
  maxPerMinute: number;
}

export interface ToolDescriptor<
  TInput extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput extends z.ZodTypeAny = z.ZodTypeAny,
> {
  name: string;
  version: string;
  description: string;
  inputSchema: TInput;
  outputSchema: TOutput;
  /** OAuth/RBAC scope required to call this tool. */
  authorizationScope: string;
  /** Whether this tool is safe to retry on failure. */
  idempotent: boolean;
  /**
   * ADR-014: MUST be 'single-human' for all money/account/external-messaging tools.
   * Hardcoded here; cannot be overridden at runtime.
   */
  approvalThreshold: ApprovalThreshold;
  auditLogPolicy: AuditLogPolicy;
  rateLimit: RateLimit;
}

// ToolCall and ToolResult are used by AgentRuntime
export interface ToolCall {
  name: string;
  args: unknown;
  /** LLM-generated call ID for correlation. */
  callId: string;
}

export interface ToolResult {
  callId: string;
  name: string;
  output: unknown;
  error?: string | undefined;
}

// ---------------------------------------------------------------------------
// §14.7.2 High-traffic tool subset — sample definitions
// ADR-014: money/account/messaging tools are hardcoded as 'single-human'
// ---------------------------------------------------------------------------

// Shared schemas
const orderIdSchema = z.object({ orderId: z.string().uuid() });
const searchSchema = z.object({ query: z.string().min(1).max(500) });
const okSchema = z.object({ success: z.boolean() });

export const TOOL_CATALOG_SEARCH: ToolDescriptor = {
  name: "catalog.search",
  version: "1.0.0",
  description: "Search the product catalog by keyword or filters.",
  inputSchema: searchSchema,
  outputSchema: z.object({
    results: z.array(z.object({ listingId: z.string(), title: z.string() })),
    total: z.number(),
  }),
  authorizationScope: "catalog:read",
  idempotent: true,
  approvalThreshold: "none",
  auditLogPolicy: "never",
  rateLimit: { maxPerMinute: 60 },
};

export const TOOL_CATALOG_CREATE_DRAFT: ToolDescriptor = {
  name: "catalog.create_draft",
  version: "1.0.0",
  description: "Create a draft listing (not yet published).",
  inputSchema: z.object({
    title: z.string().min(1).max(200),
    description: z.string().max(2000),
    price: z.number().positive(),
    currency: z.enum(["NGN", "USD"]),
  }),
  outputSchema: z.object({ draftId: z.string().uuid() }),
  authorizationScope: "catalog:write",
  idempotent: true,
  approvalThreshold: "none",
  auditLogPolicy: "on-approval",
  rateLimit: { maxPerMinute: 20 },
};

export const TOOL_ORDER_READ: ToolDescriptor = {
  name: "order.read",
  version: "1.0.0",
  description: "Read the details of an order by its ID.",
  inputSchema: orderIdSchema,
  outputSchema: z.object({
    orderId: z.string(),
    status: z.string(),
    total: z.number(),
    currency: z.string(),
  }),
  authorizationScope: "orders:read",
  idempotent: true,
  approvalThreshold: "none",
  auditLogPolicy: "never",
  rateLimit: { maxPerMinute: 60 },
};

export const TOOL_ORDER_CREATE_DRAFT: ToolDescriptor = {
  name: "order.create_draft",
  version: "1.0.0",
  description: "Create a draft order (not yet confirmed or charged).",
  inputSchema: z.object({
    buyerId: z.string(),
    items: z.array(z.object({ listingId: z.string(), quantity: z.number().int().positive() })),
  }),
  outputSchema: z.object({ draftOrderId: z.string().uuid() }),
  authorizationScope: "orders:write",
  idempotent: true,
  approvalThreshold: "none",
  auditLogPolicy: "on-approval",
  rateLimit: { maxPerMinute: 20 },
};

// ADR-014: return requests touch money — MUST be 'single-human'
export const TOOL_ORDER_RETURN_REQUEST: ToolDescriptor = {
  name: "order.return_request",
  version: "1.0.0",
  description: "Submit a return request for an order item.",
  inputSchema: z.object({
    orderId: z.string().uuid(),
    reason: z.string().min(1).max(500),
    items: z.array(z.object({ lineItemId: z.string(), quantity: z.number().int().positive() })),
  }),
  outputSchema: z.object({ returnId: z.string().uuid() }),
  authorizationScope: "orders:write",
  idempotent: false,
  // ADR-014: REQUIRED — touches money
  approvalThreshold: "single-human",
  auditLogPolicy: "always",
  rateLimit: { maxPerMinute: 5 },
};

// ADR-014: refunds touch money — MUST be 'single-human'
export const TOOL_PAYMENT_REFUND_REQUEST: ToolDescriptor = {
  name: "payment.refund_request",
  version: "1.0.0",
  description: "Request a refund for a payment.",
  inputSchema: z.object({
    paymentId: z.string().uuid(),
    amountNgn: z.number().positive(),
    reason: z.string().min(1).max(500),
  }),
  outputSchema: z.object({ refundId: z.string().uuid(), estimatedDays: z.number() }),
  authorizationScope: "payments:write",
  idempotent: false,
  // ADR-014: REQUIRED — touches money
  approvalThreshold: "single-human",
  auditLogPolicy: "always",
  rateLimit: { maxPerMinute: 5 },
};

// ADR-014: flagging is a moderation action — MUST be 'single-human'
export const TOOL_LISTING_FLAG_FOR_REVIEW: ToolDescriptor = {
  name: "listing.flag_for_review",
  version: "1.0.0",
  description: "Flag a listing for Trust & Safety review.",
  inputSchema: z.object({
    listingId: z.string().uuid(),
    reason: z.enum(["counterfeit", "prohibited", "misleading", "other"]),
    notes: z.string().max(1000).optional(),
  }),
  outputSchema: z.object({ flagId: z.string().uuid() }),
  authorizationScope: "moderation:write",
  idempotent: false,
  // ADR-014: REQUIRED — account/moderation action
  approvalThreshold: "single-human",
  auditLogPolicy: "always",
  rateLimit: { maxPerMinute: 10 },
};

// ADR-014: auto-takedown is irreversible — MUST be 'single-human'
export const TOOL_LISTING_AUTO_TAKEDOWN: ToolDescriptor = {
  name: "listing.auto_takedown",
  version: "1.0.0",
  description: "Immediately take down a listing (removes it from the marketplace).",
  inputSchema: z.object({
    listingId: z.string().uuid(),
    reason: z.enum(["counterfeit", "prohibited", "emergency"]),
    evidenceNotes: z.string().max(2000),
  }),
  outputSchema: okSchema,
  authorizationScope: "moderation:takedown",
  idempotent: false,
  // ADR-014: REQUIRED — irreversible account action
  approvalThreshold: "single-human",
  auditLogPolicy: "always",
  rateLimit: { maxPerMinute: 5 },
};

export const TOOL_STREAM_SUGGEST_PIN: ToolDescriptor = {
  name: "stream.suggest_pin",
  version: "1.0.0",
  description: "Suggest a product to pin in the current live stream.",
  inputSchema: z.object({
    streamId: z.string(),
    listingId: z.string().uuid(),
    rationale: z.string().max(200),
  }),
  outputSchema: okSchema,
  authorizationScope: "streams:write",
  idempotent: true,
  approvalThreshold: "none",
  auditLogPolicy: "on-approval",
  rateLimit: { maxPerMinute: 10 },
};

export const TOOL_RUNBOOK_SEARCH: ToolDescriptor = {
  name: "runbook.search",
  version: "1.0.0",
  description: "Search the operations runbook library.",
  inputSchema: searchSchema,
  outputSchema: z.object({
    results: z.array(z.object({ runbookId: z.string(), title: z.string(), excerpt: z.string() })),
  }),
  authorizationScope: "runbooks:read",
  idempotent: true,
  approvalThreshold: "none",
  auditLogPolicy: "never",
  rateLimit: { maxPerMinute: 30 },
};

// ADR-014: handoff sends external communication — MUST be 'single-human'
// Exception: this tool does NOT require single-human approval because the
// handoff is to internal support (not an external message). It is
// non-reversible but not money/external-messaging in the ADR-014 sense.
export const TOOL_ESCALATION_HANDOFF_TO_HUMAN: ToolDescriptor = {
  name: "escalation.handoff_to_human",
  version: "1.0.0",
  description: "Hand off the current session to a human support agent.",
  inputSchema: z.object({
    reason: z.string().min(1).max(500),
    priority: z.enum(["low", "normal", "high", "urgent"]),
    summary: z.string().max(1000),
  }),
  outputSchema: z.object({ ticketId: z.string(), estimatedWaitMinutes: z.number() }),
  authorizationScope: "support:write",
  idempotent: false,
  approvalThreshold: "none",
  auditLogPolicy: "always",
  rateLimit: { maxPerMinute: 5 },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface IToolRegistry {
  get(name: string): ToolDescriptor | undefined;
  list(): ToolDescriptor[];
}

const ALL_TOOLS: ToolDescriptor[] = [
  TOOL_CATALOG_SEARCH,
  TOOL_CATALOG_CREATE_DRAFT,
  TOOL_ORDER_READ,
  TOOL_ORDER_CREATE_DRAFT,
  TOOL_ORDER_RETURN_REQUEST,
  TOOL_PAYMENT_REFUND_REQUEST,
  TOOL_LISTING_FLAG_FOR_REVIEW,
  TOOL_LISTING_AUTO_TAKEDOWN,
  TOOL_STREAM_SUGGEST_PIN,
  TOOL_RUNBOOK_SEARCH,
  TOOL_ESCALATION_HANDOFF_TO_HUMAN,
];

export class InMemoryToolRegistry implements IToolRegistry {
  private readonly tools: Map<string, ToolDescriptor>;

  constructor(tools: ToolDescriptor[] = ALL_TOOLS) {
    this.tools = new Map(tools.map((t) => [t.name, t]));
  }

  get(name: string): ToolDescriptor | undefined {
    return this.tools.get(name);
  }

  list(): ToolDescriptor[] {
    return [...this.tools.values()];
  }
}
