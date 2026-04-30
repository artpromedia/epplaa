# Epplaa

Nigerian-first live-commerce and social-marketplace platform.

## Architecture

The authoritative architecture baseline is:

**[docs/architecture/v4.2/Epplaa_Architecture_Sprint_Plan_v4.2.md](docs/architecture/v4.2/Epplaa_Architecture_Sprint_Plan_v4.2.md)**

Companion documents:

| Document | Path |
| :--- | :--- |
| v4.2 change summary | [docs/architecture/v4.2/README.md](docs/architecture/v4.2/README.md) |
| v4.2 amendment (non-AI deviations from v4.1) | [docs/architecture/v4.2-amendment.md](docs/architecture/v4.2-amendment.md) |
| Architecture Decision Records | [docs/adr/README.md](docs/adr/README.md) |
| Risk Register | [docs/risk-register.md](docs/risk-register.md) · [AI Backbone risks](docs/risk-register/ai-backbone-risks.md) |
| Sprint Plan | [docs/sprints/README.md](docs/sprints/README.md) · [AI Sprints](docs/sprint-plan/ai-sprints.md) |
| Integration Directory | [docs/integrations/ai-backbone-vendors.md](docs/integrations/ai-backbone-vendors.md) |
| Threat Model | [docs/threat-model.md](docs/threat-model.md) |
| Glossary | [docs/glossary.md](docs/glossary.md) |

## Services

| Service | Path | Description |
| :--- | :--- | :--- |
| API Monolith | [services/api-monolith/](services/api-monolith/) | Express API server (strangler-fig source) |
| Agent Service | [services/agent-service/](services/agent-service/) | Agentic AI Backbone runtime (v4.2 Part 14) |

## Getting started

```bash
# Requires Node 24 and pnpm
node --version   # should output v24.x.x
pnpm --version   # should output 10.x.x or later

pnpm install
pnpm run typecheck
pnpm run test
```

## Contributing

See [SPRINTS.md](SPRINTS.md) for the current sprint focus and [docs/adr/README.md](docs/adr/README.md) for how architectural decisions are made.
