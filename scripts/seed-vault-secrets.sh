#!/usr/bin/env bash
# Seeds initial Vault secrets for a fresh environment.
#
# Idempotent in the "key exists" sense: writes are version-creation-policy
# default, so re-running creates a new version (audit-friendly).
#
# Required env:
#   VAULT_ADDR   e.g. https://vault.staging.epplaa.com
#   VAULT_TOKEN  Vault token with write access to secret/epplaa/*
#
# Optional env (otherwise the script generates safe defaults):
#   SESSION_SECRET, MFA_ENCRYPTION_KEY, MFA_BACKUP_PEPPER
#   DATABASE_URL, REDIS_URL
#   CLERK_SECRET_KEY, CLERK_PUBLISHABLE_KEY
#   SENTRY_DSN
#   LITELLM_MASTER_KEY, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY

set -euo pipefail

: "${VAULT_ADDR:?must be set}"
: "${VAULT_TOKEN:?must be set}"

gen() { openssl rand -hex 32; }

vault kv put secret/epplaa/api-monolith \
  session_secret="${SESSION_SECRET:-$(gen)}" \
  mfa_encryption_key="${MFA_ENCRYPTION_KEY:-$(gen)}" \
  mfa_backup_pepper="${MFA_BACKUP_PEPPER:-$(gen)}" \
  database_url="${DATABASE_URL:-postgresql://epplaa@pg-api-monolith-rw.postgres-system:5432/epplaa}" \
  redis_url="${REDIS_URL:-redis://redis-master.data:6379}" \
  clerk_secret_key="${CLERK_SECRET_KEY:-REPLACE_ME}" \
  clerk_publishable_key="${CLERK_PUBLISHABLE_KEY:-REPLACE_ME}" \
  sentry_dsn="${SENTRY_DSN:-}"

vault kv put secret/epplaa/agent-service \
  litellm_master_key="${LITELLM_MASTER_KEY:-$(gen)}" \
  langfuse_public_key="${LANGFUSE_PUBLIC_KEY:-REPLACE_ME}" \
  langfuse_secret_key="${LANGFUSE_SECRET_KEY:-REPLACE_ME}" \
  database_url="${AGENT_DATABASE_URL:-postgresql://epplaa@pg-api-monolith-rw.postgres-system:5432/epplaa_agent}"

vault kv put secret/epplaa/cluster/cloudflared \
  tunnel_token="${TUNNEL_TOKEN:?TUNNEL_TOKEN must be set — comes from Terraform module.cloudflare.tunnel_token output}"

echo "Seeded secrets at:"
vault kv list secret/epplaa
