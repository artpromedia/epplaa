# infra/terraform/

Terraform code for cloud infrastructure. Empty placeholder until
[Phase 2 of the v4.2 amendment](../../docs/architecture/v4.2-amendment.md#phase-2--infrastructure-as-code-foundation-23-sprints).

## Planned structure

```
infra/terraform/
├── README.md           ← this file
├── providers.tf        ← Hetzner, Cloudflare, Vault, Helm
├── backend.tf          ← remote state (S3-compatible on Hetzner Object Storage)
├── environments/
│   ├── prod/           ← FSN1 primary
│   ├── dr/             ← HEL1 disaster-recovery
│   └── staging/
└── modules/
    ├── k3s-cluster/    ← embedded etcd HA, node pools
    ├── lagos-edge/     ← Lagos PoP for live-stream ingest
    ├── cloudflare-zone/ ← DNS, WAF, Tunnel, Stream
    ├── postgres-cluster/ ← Postgres operator, per-service DB
    └── observability-stack/
```

Hetzner has **no African region**. The Lagos edge tier exists
specifically to keep live-stream ingest latency under 250 ms within
Nigeria; it is a separate Terraform module so its lifecycle is
independent of the FSN1 control plane.

State is held in a remote backend; never in this repo. Plans are
generated in CI; applies are gated on review per
`docs/raci.md`.
