# ADR-014: Single-Human-Approval Autonomy Ceiling for v1

- **Status**: Accepted
- **Date**: 2026-04-30
- **Deciders**: Architecture WG, Security Eng, Product (Trust & Safety)

## Context

The AI Backbone (Part 14) agents can invoke tools that move money, modify accounts, send external messages, or take down listings. Autonomous execution of these actions without human oversight poses:

1. **Financial risk**: A prompt injection or model error could initiate an unintended refund or payment.
2. **Reputational risk**: An erroneous auto-takedown could remove a legitimate vendor's listing.
3. **Regulatory risk**: CBN and NDPC frameworks require human accountability for consequential financial and data-affecting decisions.
4. **Trust risk**: Early users must be able to trust that Epplaa's AI does not act unilaterally on their accounts.

## Decision

For v1, no agent may execute an action that touches **money, accounts, or external communications** without a human approval event via the Approval Bus (§14.7.3).

This ceiling is enforced mechanically at two levels:
1. **ToolRegistry**: Tools in the money/account/messaging categories have `approvalThreshold: 'single-human'` as a hardcoded default. This field cannot be overridden via agent configuration or LLM output.
2. **AgentRuntime.dispatchTool()**: Checks `approvalThreshold` before executing any tool; this check is in the application layer, not the LLM layer.

**Affected tool categories (non-exhaustive)**:
- All `payment.*` tools
- `order.return_request`
- `order.create_confirmed` (draft is exempt; confirmed is not)
- `listing.auto_takedown`
- `listing.flag_for_review`
- Any tool sending SMS, email, or push notifications to external recipients

**Raising the ceiling** requires:
1. A new ADR superseding this one, accepted by Architecture WG vote.
2. Six months of production data demonstrating the KPI targets in §14.14.1 (AI Sprint 7 ROI gate).
3. A red-team evaluation of the proposed autonomous action classes.

## Consequences

**Easier**
- Clear accountability: every consequential action has a named human approver in the audit log.
- Regulatory posture: the approval requirement satisfies the "human in the loop" requirement under CBN's emerging AI guidance.
- Trust: users and vendors can verify that no irreversible action was taken without human review.

**Harder**
- UX: approval latency (up to 15 minutes) is visible to the user; we must communicate this transparently.
- Operations: a human approval queue must be staffed; SLA must be defined and monitored.

## Alternatives considered

- **No autonomy ceiling** — rejected: unacceptable financial and reputational risk for v1.
- **Dual-human approval** — considered for payment tools; rejected as over-engineering for v1; revisit if CBN requires it.
- **Time-bounded autonomy** (allow up to N actions per day without approval) — rejected: creates a predictable attack surface for prompt injection.

## Re-evaluation triggers

- Month-6 ROI gate (AI Sprint 7) passes: 3/5 headline KPIs met.
- Architecture WG vote with production data and red-team sign-off.

## Cross-references

- ADR-010 (runtime enforcement mechanism)
- §14.7 (tool registry — approval threshold field)
- §14.7.3 (approval bus)
- §14.11 (autonomy ceiling documentation)
- §14.14.1 (AI Sprint 7 — autonomy review)
