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

# Third-party provider credentials. Each line is a separate sub-key
# under one Vault path so a single ExternalSecret can mirror all of
# them as one Kubernetes Secret (matches
# infra/helm/api-monolith/values.yaml `api-monolith-providers`).
# Keys default to REPLACE_ME so a fresh environment boots with
# explicit "this isn't configured yet" sentinels rather than empty
# strings the app might mistake for "feature disabled".
vault kv put secret/epplaa/api-monolith-providers \
  paystack_secret_key="${PAYSTACK_SECRET_KEY:-REPLACE_ME}" \
  flutterwave_secret_key="${FLUTTERWAVE_SECRET_KEY:-REPLACE_ME}" \
  flutterwave_webhook_hash="${FLUTTERWAVE_WEBHOOK_HASH:-REPLACE_ME}" \
  postmark_api_token="${POSTMARK_API_TOKEN:-REPLACE_ME}" \
  sendgrid_api_key="${SENDGRID_API_KEY:-REPLACE_ME}" \
  africastalking_api_key="${AFRICASTALKING_API_KEY:-REPLACE_ME}" \
  termii_api_key="${TERMII_API_KEY:-REPLACE_ME}" \
  fcm_service_account_json="${FCM_SERVICE_ACCOUNT_JSON:-REPLACE_ME}" \
  vapid_public_key="${VAPID_PUBLIC_KEY:-REPLACE_ME}" \
  vapid_private_key="${VAPID_PRIVATE_KEY:-REPLACE_ME}" \
  hive_api_key="${HIVE_API_KEY:-REPLACE_ME}" \
  photodna_api_key="${PHOTODNA_API_KEY:-REPLACE_ME}" \
  sightengine_api_secret="${SIGHTENGINE_API_SECRET:-REPLACE_ME}" \
  gig_api_key="${GIG_API_KEY:-REPLACE_ME}" \
  gig_webhook_secret="${GIG_WEBHOOK_SECRET:-REPLACE_ME}" \
  shipbubble_api_key="${SHIPBUBBLE_API_KEY:-REPLACE_ME}" \
  shipbubble_webhook_secret="${SHIPBUBBLE_WEBHOOK_SECRET:-REPLACE_ME}" \
  okhi_api_key="${OKHI_API_KEY:-REPLACE_ME}" \
  cf_stream_api_token="${CF_STREAM_API_TOKEN:-REPLACE_ME}" \
  cf_stream_webhook_secret="${CF_STREAM_WEBHOOK_SECRET:-REPLACE_ME}"

# Operator-controlled tokens. INTERNAL_API_KEY is generated locally
# (no third-party origin); HEALTHZ_REHEARSAL_TOKEN is generated and
# co-rotated with the rehearsal workflow's stored secret per the
# production-secrets runbook.
vault kv put secret/epplaa/api-monolith-internal \
  internal_api_key="${INTERNAL_API_KEY:-$(gen)}" \
  healthz_rehearsal_token="${HEALTHZ_REHEARSAL_TOKEN:-$(gen)}"

vault kv put secret/epplaa/agent-service \
  litellm_master_key="${LITELLM_MASTER_KEY:-$(gen)}" \
  langfuse_public_key="${LANGFUSE_PUBLIC_KEY:-REPLACE_ME}" \
  langfuse_secret_key="${LANGFUSE_SECRET_KEY:-REPLACE_ME}" \
  database_url="${AGENT_DATABASE_URL:-postgresql://epplaa@pg-api-monolith-rw.postgres-system:5432/epplaa_agent}"

vault kv put secret/epplaa/cluster/cloudflared \
  tunnel_token="${TUNNEL_TOKEN:?TUNNEL_TOKEN must be set — comes from Terraform module.cloudflare.tunnel_token output}"

echo "Seeded secrets at:"
vault kv list secret/epplaa
