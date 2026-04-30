# Risk Register — AI Backbone Additions (v4.2 Part 14)

- **Status**: Active
- **Owner**: Architecture WG + AI Platform Eng
- **Parent register**: [`docs/risk-register.md`](../risk-register.md)
- **Cadence**: Reviewed at the start of every AI Sprint.

These six entries supplement the main risk register (R-001 – R-020). They are scored on Likelihood × Impact (1–5 each).

## AI Backbone risks

| ID | Risk | L | I | Score | Owner | Trip-wire metric | Mitigation | Status |
| :--- | :--- | :---: | :---: | :---: | :--- | :--- | :--- | :--- |
| R-AI-001 | **Prompt injection** — adversarial user content hijacks agent tool calls | 4 | 5 | 20 | Security Eng | Any tool call approved by a classifier score < 0.8 or out-of-scope tool call attempt in Langfuse | Structural delimiters + output schema validation + scope enforcement + untrusted-content classifier (§14.9.1); red-team in AI Sprint 8 | Open |
| R-AI-002 | **AI cost runaway** — a prompt loop or traffic spike exhausts the monthly LLM budget | 3 | 4 | 12 | AI Platform Eng | Daily per-agent spend > 120% of cap for 2 consecutive days | Per-agent daily USD cap enforced by LiteLLM gateway; PagerDuty alert at 80% cap; hard reject at 100%; §14.5 | Open |
| R-AI-003 | **Code-switching UX failure** — Tier B language translation quality degrades below usability threshold | 3 | 3 | 9 | Product (Localisation) | Braintrust Tier B eval BLEU score < 0.65 for 3 consecutive nightly runs | Intron + Lelapa as Tier 1 vendors (ADR-015); nightly Braintrust evals; human review sample each sprint | Open |
| R-AI-004 | **Eval quality drift** — agent accuracy regresses without being caught by automated evals | 3 | 4 | 12 | AI Platform Eng | >5% regression in any agent's Braintrust 7-day rolling average precision/recall | Nightly Braintrust eval jobs (§14.10); alert on regression; eval suite updated each sprint | Open |
| R-AI-005 | **Intron vendor concentration** — Intron outage degrades Tier B voice for all agents simultaneously | 2 | 4 | 8 | AI Platform Eng | Intron ASR error rate > 5% for > 15 min | Fallback plan: Tier B voice degrades to text-only on Intron outage; Lelapa translation still available; SLA monitoring in place | Open |
| R-AI-006 | **AI ROI gate failure** — month-6 KPI gate is not met; AI Sprint 7 (autonomy expansion) is blocked | 3 | 3 | 9 | Product / Arch WG | KPI dashboard shows < 3/5 headline targets met at month-6 review | Gate is a designed control (ADR-014); failure means deferral of autonomy expansion, not platform failure; escalate to board if > 2 sprints blocked | Open |

## Trip-wire definitions

### R-AI-001 Prompt injection
- **Trigger**: Any Langfuse trace showing an out-of-scope tool call attempt OR classifier confidence < 0.8 on a tool-calling turn.
- **Response**: Automated alert to Security Eng; session replay reviewed within 24 hours; classifier threshold adjusted if false-positive rate > 10%.

### R-AI-002 AI cost runaway
- **Trigger**: LiteLLM spend tracker: agent daily spend > 120% of cap for 2 consecutive days.
- **Response**: Page AI Platform Eng; investigate session logs for loops; apply temporary rate-limit reduction.

### R-AI-003 Code-switching UX failure
- **Trigger**: Braintrust Tier B eval BLEU score < 0.65 for 3 consecutive nightly runs for any language.
- **Response**: Notify Product (Localisation) and Intron/Lelapa account manager; pause Tier B rollout if score < 0.5.

### R-AI-004 Eval quality drift
- **Trigger**: Any agent's Braintrust precision or recall drops > 5% relative to the 7-day rolling baseline.
- **Response**: AI Platform Eng investigates prompt version change or model update; rollback prompt if correlated; alert Arch WG if no root cause found in 48 hours.

### R-AI-005 Intron vendor concentration
- **Trigger**: Intron ASR error rate > 5% for > 15 consecutive minutes (measured by Langfuse trace error tagging).
- **Response**: Automated fallback to text-only mode for Tier B; notify AI Platform Eng; open incident.

### R-AI-006 AI ROI gate failure
- **Trigger**: Month-6 KPI review shows < 3/5 headline targets met.
- **Response**: Architecture WG review; AI Sprint 7 deferred; findings published to board.

## How to add an AI risk

Open a PR amending this file. An Architecture WG member and an AI Platform Eng lead must both approve. Closed rows are kept for audit.
