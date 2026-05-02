# Vault bootstrap runbook

Owner: Platform / SRE on-call.
Audience: cluster operators with break-glass access.

This runbook covers the **first-time** initialisation of Vault on a fresh
k3s cluster, the Kubernetes auth-method wiring that ExternalSecrets relies
on, and the initial seeding of the `secret/epplaa/api-monolith` and
`secret/epplaa/agent-service` paths. Steady-state operations (rotation,
break-glass) live in separate runbooks.

## Preconditions

- `infra/argocd/applications/platform/03-vault.yaml` is synced (Vault pods
  running, but **uninitialised** and **sealed**).
- An operator has the `kubectl` kubeconfig for the cluster.
- The `vault` CLI is installed locally (≥ 1.18).

## 1. Initialise

```sh
kubectl -n vault exec vault-0 -- vault operator init \
  -key-shares=5 -key-threshold=3 -format=json > vault-init.json
```

Distribute the 5 unseal keys to the executive recovery custodians per
docs/raci.md; nothing in this runbook references them again. The
`root_token` is stored in 1Password under "Vault root — <env>".

## 2. Unseal (per pod)

```sh
for i in 0 1 2; do
  for key in $(jq -r '.unseal_keys_b64[0,1,2]' vault-init.json); do
    kubectl -n vault exec vault-$i -- vault operator unseal "$key"
  done
done
```

Auto-unseal via Hetzner KMS is not native; we run a dedicated single-node
"seal Vault" outside the cluster that the prod Vault treats as a transit
seal target. Bootstrap that single-node Vault first and update
`infra/helm/vault/values.yaml#seal.transit.address`.

## 3. Enable Kubernetes auth + KV v2

```sh
export VAULT_ADDR=https://vault.<env>.epplaa.com
export VAULT_TOKEN=<root_token>

vault auth enable kubernetes
vault write auth/kubernetes/config \
  kubernetes_host="https://kubernetes.default.svc" \
  kubernetes_ca_cert=@/var/run/secrets/kubernetes.io/serviceaccount/ca.crt \
  token_reviewer_jwt=@/var/run/secrets/kubernetes.io/serviceaccount/token

vault secrets enable -version=2 -path=secret kv
```

## 4. Bind ExternalSecrets

```sh
vault policy write external-secrets - <<EOF
path "secret/data/epplaa/*" { capabilities = ["read"] }
path "secret/metadata/epplaa/*" { capabilities = ["read"] }
EOF

vault write auth/kubernetes/role/external-secrets \
  bound_service_account_names=external-secrets \
  bound_service_account_namespaces=external-secrets \
  policies=external-secrets ttl=1h
```

This matches `infra/helm/external-secrets/templates/clustersecretstore.yaml`
(role `external-secrets`, ServiceAccount `external-secrets/external-secrets`).

## 5. Seed initial secrets

Pre-existing secrets (currently in CI environment vars) move into Vault
in this step. Migrate **one group at a time** so a misconfigured ExternalSecret
fails fast instead of taking everything down.

Recommended order, matching the Phase D2 plan:

1. `secret/epplaa/api-monolith` — MFA + Session
2. `secret/epplaa/api-monolith` — DATABASE_URL, REDIS_URL
3. `secret/epplaa/api-monolith` — Clerk, Sentry
4. `secret/epplaa/api-monolith-providers` — third-party provider creds
   (payments, email, SMS/OTP, push, moderation, shipping, streaming).
   See **Vault path inventory** below for the full list.
5. `secret/epplaa/api-monolith-internal` — INTERNAL_API_KEY,
   HEALTHZ_REHEARSAL_TOKEN.
6. `secret/epplaa/agent-service` — LiteLLM master, Langfuse keys

```sh
vault kv put secret/epplaa/api-monolith \
  session_secret="$(openssl rand -hex 32)" \
  mfa_encryption_key="$(openssl rand -hex 32)" \
  mfa_backup_pepper="$(openssl rand -hex 32)" \
  database_url="postgresql://..." \
  redis_url="redis://:..." \
  clerk_secret_key="..." \
  clerk_publishable_key="..." \
  sentry_dsn="..."
```

Verify the ExternalSecret reconciles:

```sh
kubectl -n services get externalsecret api-monolith-api-monolith-core -o yaml
kubectl -n services get secret api-monolith-api-monolith-core -o yaml
```

The `Secret` should have all the keys listed under
`infra/helm/api-monolith/values.yaml#vault.secrets[0].keys`.

## 6. Sentinel: rotate one secret

Confirm the rotation pipeline works end-to-end before declaring done:

```sh
vault kv put secret/epplaa/api-monolith \
  -version-creation-policy=force \
  session_secret="$(openssl rand -hex 32)"

# Force ExternalSecrets to refetch (or wait up to refreshInterval=1h):
kubectl -n services annotate externalsecret api-monolith-api-monolith-core \
  force-sync="$(date +%s)" --overwrite

# Pods should restart on the secret hash annotation change managed by Helm.
kubectl -n services rollout status deployment api-monolith
```

If the pods don't restart, the `checksum/config` annotation in
`infra/helm/api-monolith/templates/deployment.yaml` isn't picking up the
secret change — verify Helm is rendering the ExternalSecret hash into
the annotation.

## 7. Hand-off

- Rotate the root token via `vault token revoke <root_token>`. Recovery
  is via the unseal keys + a fresh `operator generate-root` flow.
- Add a Sentry Cron monitor `vault-rotation-quarterly` (declare in
  `scripts/src/sentryMonitors.config.ts`) — paged when the four
  high-blast-radius secrets above haven't rotated in 90 days.

## Failure modes

| Symptom | Cause | Action |
| :--- | :--- | :--- |
| ExternalSecret stuck `SecretSyncError` | Vault role policy missing path | Re-run step 4 with the missing path |
| Pods loop-restart after rotation | App reads secret only at boot | Confirmed expected — rolling restart is the rotation. |
| Vault sealed after node reboot | Transit seal Vault unreachable | Restore seal Vault first, then `vault operator unseal` is no longer needed |

## Vault path inventory (rollout completion)

The api-monolith reads its secrets from three Vault paths, mirrored
into Kubernetes Secrets by ExternalSecrets per
`infra/helm/api-monolith/values.yaml#vault.secrets`. Each path is its
own ExternalSecret resource so rotation cadences don't bleed across
groups (rotating Postmark doesn't churn pods reading Paystack).

### `secret/epplaa/api-monolith` — core (high blast radius)

| Vault property | Env var the app reads | Notes |
| --- | --- | --- |
| `database_url` | `DATABASE_URL` | Postgres connection string. Rotation requires the DB password to be updated in lockstep. |
| `session_secret` | `SESSION_SECRET` | Generated via `openssl rand -hex 32`. Rotation invalidates all sessions. |
| `mfa_encryption_key` | `MFA_ENCRYPTION_KEY` | Generated via `openssl rand -hex 32`. Rotation requires re-encrypting MFA secrets in `mfa_credentials`. |
| `mfa_backup_pepper` | `MFA_BACKUP_PEPPER` | Generated via `openssl rand -hex 32`. Rotation invalidates existing backup-code hashes. |
| `redis_url` | `REDIS_URL` | Includes embedded password. Rotated with the Redis instance. |
| `clerk_secret_key` | `CLERK_SECRET_KEY` | From the Clerk dashboard. Rotate via the Clerk console then update Vault. |
| `clerk_publishable_key` | `CLERK_PUBLISHABLE_KEY` | Pair with `clerk_secret_key`. |
| `sentry_dsn` | `SENTRY_DSN` | From the Sentry project's Client Keys page. |

### `secret/epplaa/api-monolith-providers` — third-party API creds

Grouped per integration. The rotation runbook can target a single
provider without touching the other groups.

| Vault property | Env var | Provider |
| --- | --- | --- |
| `paystack_secret_key` | `PAYSTACK_SECRET_KEY` | Paystack (primary payments) |
| `flutterwave_secret_key` | `FLUTTERWAVE_SECRET_KEY` | Flutterwave (failover payments) |
| `flutterwave_webhook_hash` | `FLUTTERWAVE_WEBHOOK_HASH` | Flutterwave webhook HMAC |
| `postmark_api_token` | `POSTMARK_API_TOKEN` | Postmark (primary transactional email) |
| `sendgrid_api_key` | `SENDGRID_API_KEY` | SendGrid (failover email) |
| `africastalking_api_key` | `AFRICASTALKING_API_KEY` | Africa's Talking (primary SMS/OTP) |
| `termii_api_key` | `TERMII_API_KEY` | Termii (failover SMS) |
| `fcm_service_account_json` | `FCM_SERVICE_ACCOUNT_JSON` | Firebase Cloud Messaging (mobile push) |
| `vapid_public_key` | `VAPID_PUBLIC_KEY` | Web Push (browser) |
| `vapid_private_key` | `VAPID_PRIVATE_KEY` | Web Push private key |
| `hive_api_key` | `HIVE_API_KEY` | Hive (primary moderation) |
| `photodna_api_key` | `PHOTODNA_API_KEY` | PhotoDNA (CSAM hash matching) |
| `sightengine_api_secret` | `SIGHTENGINE_API_SECRET` | Sightengine (image moderation) |
| `gig_api_key` | `GIG_API_KEY` | GIG Logistics (NG last-mile) |
| `gig_webhook_secret` | `GIG_WEBHOOK_SECRET` | GIG webhook HMAC |
| `shipbubble_api_key` | `SHIPBUBBLE_API_KEY` | ShipBubble (multi-carrier shipping) |
| `shipbubble_webhook_secret` | `SHIPBUBBLE_WEBHOOK_SECRET` | ShipBubble webhook HMAC |
| `okhi_api_key` | `OKHI_API_KEY` | OKHI (3-word delivery addresses) |
| `cf_stream_api_token` | `CF_STREAM_API_TOKEN` | Cloudflare Stream (live + replay origin) |
| `cf_stream_webhook_secret` | `CF_STREAM_WEBHOOK_SECRET` | Cloudflare Stream webhook HMAC |

### `secret/epplaa/api-monolith-internal` — operator-controlled tokens

| Vault property | Env var | Notes |
| --- | --- | --- |
| `internal_api_key` | `INTERNAL_API_KEY` | Generated via `openssl rand -hex 32`. Used to gate internal-network calls between services. |
| `healthz_rehearsal_token` | `HEALTHZ_REHEARSAL_TOKEN` | Generated and co-rotated with the rehearsal workflow's stored secret. See [`production-secrets.md`](./production-secrets.md). |

### `secret/epplaa/agent-service`

| Vault property | Env var | Notes |
| --- | --- | --- |
| `litellm_master_key` | `LITELLM_MASTER_KEY` | Master key for the LiteLLM gateway. |
| `langfuse_public_key` | `LANGFUSE_PUBLIC_KEY` | Langfuse observability. |
| `langfuse_secret_key` | `LANGFUSE_SECRET_KEY` | Langfuse observability secret. |
| `database_url` | `DATABASE_URL` | Agent-service Postgres conn string (separate DB from api-monolith). |

### Seeding

Use [`scripts/seed-vault-secrets.sh`](../../scripts/seed-vault-secrets.sh)
for both fresh-environment bootstrap and `REPLACE_ME` placeholder
seeding. The script is idempotent and writes every Vault path; per-key
overrides are read from environment variables of the same name (see
the script's header for the full list). A typical staging bootstrap:

```sh
export VAULT_ADDR=https://vault.staging.epplaa.com
export VAULT_TOKEN=<root_token_or_admin_token>
export TUNNEL_TOKEN=<from-terraform-output>
export PAYSTACK_SECRET_KEY=<from-paystack-dashboard>
# … other provider creds as available …
./scripts/seed-vault-secrets.sh
```

Anything not provided as an env override gets `REPLACE_ME` (or a
generated random hex for the keys the script can safely auto-fill —
session_secret, mfa_*, internal_api_key, healthz_rehearsal_token).
The app's own validation surfaces missing real values via the readyz
provider probes; `REPLACE_ME` is *not* treated as configured.

## Rollout-completion CI guard

[`scripts/src/checkVaultSecretCoverage.ts`](../../scripts/src/checkVaultSecretCoverage.ts)
walks every `process.env.<NAME>` reference in
`services/api-monolith/src` and asserts that every secret-shaped name
(matching the patterns in
[`scripts/src/vaultSecretCoverage.config.ts`](../../scripts/src/vaultSecretCoverage.config.ts):
`_KEY$`, `_SECRET$`, `_TOKEN$`, `_PASSWORD$`, `_DSN$`, `_HASH$`,
`_CREDENTIAL(S)?$`, `_SERVICE_ACCOUNT(_JSON)?$`, plus the explicit
`SESSION_SECRET`) is either declared in
`infra/helm/api-monolith/values.yaml` under `vault.secrets[*].keys[*]`
or on the explicit allowlist with a documented reason.

The check runs in CI on every PR via
[`.github/workflows/check-vault-secret-coverage.yml`](../../.github/workflows/check-vault-secret-coverage.yml)
and on every push to `main`. A failing run names the missing secrets
with file:line references and prints two remediation paths (Vault
wiring or allowlist).

Local rehearsal:

```sh
pnpm --filter @workspace/scripts run check-vault-secret-coverage
```

The expected output on a healthy tree is:

```
[checkVaultSecretCoverage] scanned N file(s), found N env reference(s); N secret-shaped name(s).
[checkVaultSecretCoverage] covered=N, allowlisted=0, missing=0
[checkVaultSecretCoverage] OK — every secret-shaped env var is Vault-backed or allowlisted.
```

Any change to either side of the contract — the api-monolith source,
the values file, the verifier itself, or its config — re-runs the
check; the path filters in the workflow YAML guarantee that.
