# ADR-0010: Secrets — Vault replaces environment variables

- **Status**: Accepted
- **Date**: 2026-04-30
- **Deciders**: Architecture WG, Security Eng, Platform Eng

## Context

The current code base reads secrets from environment variables
(Paystack keys, Flutterwave keys, Clerk secret keys, MFA encryption
key, MFA backup pepper, Sentry auth tokens, DB credentials). On
Replit, env vars are set in the workspace UI; in CI, they are GitHub
Actions secrets; in production-target Hetzner k3s, they would be
Kubernetes `Secret` objects. None of these provide:

- Time-bounded credentials (every secret is long-lived).
- Centralised rotation.
- Per-service access policy.
- Audit trail of who read which secret when.

The v4.1 spec calls for HashiCorp Vault as the secrets backbone.

## Decision

Adopt **HashiCorp Vault** (HCP-managed or self-hosted in the cluster
— deferred decision; Helm chart skeleton placed at
`infra/helm/vault/`) as the secrets backbone for production workloads.

Migration is staged, one secret group per phase to bound risk:

1. **Phase 3a** — Paystack + Flutterwave secrets (highest blast
   radius; on-the-wire to external regulators).
2. **Phase 3b** — Notification provider keys (SMS, email, push).
3. **Phase 3c** — Database credentials (introduces Vault dynamic
   secrets for Postgres roles).
4. **Phase 3d** — Clerk secret keys, MFA encryption key, MFA backup
   pepper, Sentry tokens.

Mechanism: services receive secrets via the `vault-agent-injector`
sidecar pattern — Vault Agent renders templated secret files into a
shared volume that the service reads at startup, with auto-renewal.
No service holds a long-lived Vault token; service identity is
provided by the Kubernetes service-account auth method.

For local development, secrets continue to come from `.env` files and
Replit secrets; Vault is *not* in the developer hot path. The
`packages/config` library exposes a single `getSecret(name)` API that
returns from env locally and from the Vault-rendered file in
production.

## Consequences

**Easier**
- Centralised rotation: rotating Paystack means changing one Vault
  secret, not chasing every deployment surface.
- Audit trail: Vault logs every read, with the requesting service
  identity, to a dedicated audit device.
- Per-service ACLs: notification-service cannot read payment-service
  secrets even if the pod is compromised.
- Dynamic DB credentials: each service gets its own, short-lived
  Postgres role; DB-credential leakage stops being a long-tail risk.

**Harder**
- Vault is itself a critical dependency; downtime affects every
  service's ability to renew secrets. Mitigated by HA topology
  (3-node Raft) and by Vault Agent's local-cache behaviour during
  short outages.
- A new operator skill set: unsealing, namespace policy, audit-device
  configuration, disaster recovery of the seal.

## Alternatives considered

- **External Secrets Operator + GCP Secret Manager / AWS Secrets
  Manager** — rejected: introduces a US-cloud dependency for
  Nigerian-resident PII-adjacent secrets and a separate vendor
  relationship.
- **SealedSecrets (Bitnami)** — rejected: GitOps-friendly but does
  not solve dynamic credentials, audit, or per-service ACLs at the
  granularity we need.
- **Doppler / 1Password Secrets Automation** — rejected: SaaS
  trade-offs and weaker dynamic-credential story than Vault.
- **Stay on Kubernetes Secrets only** — rejected: long-lived, no
  rotation, no audit, no dynamic credentials.

## Re-evaluation triggers

- Vault operational burden materially exceeds the value delivered
  (e.g., we cannot find a Platform Eng who can run it).
- HCP Vault EU-resident pricing changes the self-hosted vs managed
  trade-off.
- A regulator (NDPC, CBN) issues a control that Vault cannot satisfy
  but a successor product can.
