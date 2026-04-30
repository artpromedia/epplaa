# @workspace/agent-service

The **Agentic AI Backbone** runtime for the Epplaa platform.

See **[Part 14 of the v4.2 architecture](../../docs/architecture/v4.2/Epplaa_Architecture_Sprint_Plan_v4.2.md#part-14--agentic-ai-backbone)** for the full specification.

---

## Overview

This service hosts the five v1 AI agents:

| Agent | ID | Purpose |
| :--- | :--- | :--- |
| Vendor Onboarding | `vendor-onboarding` | Guides new vendors through listing creation and compliance |
| Seller Copilot | `seller-copilot` | Assists sellers with catalog, pricing, and fulfilment |
| Buyer Concierge | `buyer-concierge` | Handles buyer queries, returns, and dispute escalation |
| Fraud & Counterfeit | `fraud-counterfeit` | Flags listings and initiates takedown workflows |
| Ops On-Call | `ops-oncall` | Surfaces runbook guidance and escalation paths |

All agents share a single `AgentRuntime` that enforces the §14.3.2 lifecycle:

```
load config → hydrate memory → call gateway → validate tool calls
  → dispatch or wait for approval → emit trace
```

---

## AI Sprint 0 exit criterion

This service is the deliverable for **AI Sprint 0** (scaffolding). The exit criterion is:

- [ ] `tsc --noEmit` passes (`pnpm run typecheck`).
- [ ] Smoke test passes (`pnpm run test`).
- [ ] `.github/workflows/agent-service.yml` CI is green.
- [ ] All ADRs (010–015) committed and cross-referenced.
- [ ] ToolRegistry sample tools match §14.7.2 with ADR-014 approval defaults.

---

## Structure

```
src/
  index.ts                    — HTTP server + OTel init + graceful shutdown
  runtime/
    AgentRuntime.ts           — §14.3.2 request lifecycle
  registry/
    PromptRegistry.ts         — versioned prompt loading (§14.6)
    ToolRegistry.ts           — typed tool descriptors (§14.7) + sample tools
  gateway/
    ModelGateway.ts           — LiteLLM interface (§14.5, ADR-011)
  memory/
    ShortTermMemory.ts        — Redis conversation context (§14.8)
    LongTermMemory.ts         — pgvector semantic retrieval (§14.8)
  approval/
    ApprovalBus.ts            — Kafka/Redpanda producer (§14.7.3, ADR-014)
  agents/
    types.ts                  — AgentConfig interface (§14.4)
    vendor-onboarding.ts      — Vendor Onboarding agent config
    seller-copilot.ts         — Seller Copilot agent config
    buyer-concierge.ts        — Buyer Concierge agent config
    fraud-counterfeit.ts      — Fraud & Counterfeit agent config
    ops-oncall.ts             — Ops On-Call agent config
  safety/
    PromptInjectionDefense.ts — six-layer injection defense (§14.9.1)
    PIIRedaction.ts           — PII redaction pass (§14.9.2)
  __tests__/
    AgentRuntime.test.ts      — AI Sprint 0 smoke test
```

---

## Development

```bash
# From the monorepo root:
pnpm --filter @workspace/agent-service run typecheck
pnpm --filter @workspace/agent-service run test

# Or from this directory:
pnpm run typecheck
pnpm run test
```

---

## Architecture references

| Topic | Document |
| :--- | :--- |
| Full v4.2 spec | `docs/architecture/v4.2/Epplaa_Architecture_Sprint_Plan_v4.2.md` |
| ADR-010 (runtime) | `docs/adr/ADR-010-agent-runtime-pydantic-ai.md` |
| ADR-011 (LLM providers) | `docs/adr/ADR-011-anthropic-primary-openai-secondary.md` |
| ADR-014 (autonomy ceiling) | `docs/adr/ADR-014-single-human-approval-autonomy-ceiling.md` |
| Risk register | `docs/risk-register/ai-backbone-risks.md` |
| Integration directory | `docs/integrations/ai-backbone-vendors.md` |
| AI sprints | `docs/sprint-plan/ai-sprints.md` |
