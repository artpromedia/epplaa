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
3. `secret/epplaa/api-monolith` — Clerk, Sentry, payment gateway keys
4. `secret/epplaa/agent-service` — LiteLLM master, Langfuse keys

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
