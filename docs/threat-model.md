# Threat Model — Epplaa Platform

- **Status**: Initial draft (Phase 0 of v4.2 amendment)
- **Methodology**: STRIDE per service trust boundary
- **Owner**: Security Eng

This is the seed threat model. It enumerates the trust boundaries
that exist *today* in the monolith and reserves a section for each
service that will be extracted in Phase 4. Each per-service section
will be deepened as that service is extracted, in the same PR that
moves its code.

## 1. Trust boundaries

### 1.1 External actors

| Actor | Trust level | Boundary |
| :--- | :--- | :--- |
| Buyer (Nigerian end user, web/mobile) | Untrusted | TLS, Clerk session, MFA on sensitive ops |
| Seller / host (live streamer) | Authenticated, semi-trusted | Clerk session + seller-role claim |
| Manufacturer (VN/CN/JP/TW) | Authenticated, semi-trusted | Clerk session + manufacturer-role claim |
| Admin / T&S operator | Authenticated, MFA-elevated | Clerk session + admin-role + MFA-elevation |
| Payment provider (Paystack, Flutterwave) | Trusted callback-only | Webhook signature verification |
| Fulfillment partner (Shipbubble, OkHi, GIG) | Trusted API-only | mTLS or signed webhook |
| Cloudflare edge | Trusted | Internal mTLS to origin |

### 1.2 Internal trust boundaries

- Cloudflare → Traefik ingress
- Traefik → service mesh (Linkerd-meshed pods)
- Service → Postgres (per-service role; Vault dynamic creds in Phase 3)
- Service → Redpanda (mTLS, ACL per topic)
- Service → Vault (Kubernetes service-account auth)

## 2. STRIDE per current monolith surface

The monolith is treated here as one trust zone; future per-service
threat models will refine these into zone-specific findings.

### Spoofing

- **S-1**: Forged buyer session — Mitigated by Clerk JWT verification
  and short session lifetime.
- **S-2**: Forged payment-provider webhook — Mitigated by HMAC
  signature verification on Paystack/Flutterwave callbacks.
- **S-3**: Forged service-to-service caller (post-extraction) —
  Mitigated by Linkerd mTLS in Phase 3.

### Tampering

- **T-1**: Cart price tampering at checkout — Mitigated by
  server-side recompute of totals against catalog ground truth.
- **T-2**: Order status manipulation by seller — Mitigated by
  state-machine enforcement; seller can transition only allowed
  states.
- **T-3**: In-flight tampering of API requests — Mitigated by TLS
  end-to-end and mesh mTLS east-west.

### Repudiation

- **R-1**: Buyer denies placing an order — Mitigated by signed event
  log of order creation including session ID and IP.
- **R-2**: Admin denies T&S takedown action — Mitigated by audit log
  with MFA-elevated session id + admin actor.

### Information disclosure

- **I-1**: PII exposure via verbose error responses — Mitigated by
  error envelope that strips internal fields in non-debug builds.
- **I-2**: Secret leak via env-var dump — Mitigated by gitleaks in
  CI today; further mitigated by Vault migration in Phase 3.
- **I-3**: Card data exposure (PCI scope) — Mitigated by SAQ-A
  scoping: PAN never touches our infra (redirect/iframe to gateways).
  See `docs/compliance/pci-cdf.md`.

### Denial of service

- **D-1**: Buyer-traffic flood — Mitigated by Cloudflare WAF + rate
  limiting; per-route rate limits in `lib/rate-limit/`.
- **D-2**: Live-stream ingest flood at Lagos edge — Mitigated by
  authenticated stream-key gating + edge-side rate limiting.
- **D-3**: Webhook replay attacks — Mitigated by idempotency keys
  and signed-window timestamp on Paystack/Flutterwave.

### Elevation of privilege

- **E-1**: Buyer→seller role escalation via cart manipulation —
  Mitigated by server-side role attribution from Clerk claims, never
  from request body.
- **E-2**: Admin endpoints accessible without MFA-elevation —
  Mitigated by the existing MFA elevation contract test
  (`mfa.contract.test.ts`); Phase 3 will move this to OPA/Rego.
- **E-3**: Cross-tenant access (seller A reading seller B data) —
  Mitigated by row-level filters keyed on session-derived
  seller_id.

## 3. Per-service threat-model sections (to be deepened in extraction PRs)

Each new service in Phase 4 must add a STRIDE section to this file in
its extraction PR. Sections reserved (placeholder headers only):

- 3.1 notification-service
- 3.2 identity-service
- 3.3 catalog-service
- 3.4 manufacturer-service
- 3.5 cart-service
- 3.6 payment-service *(deepest review; PCI scoping)*
- 3.7 order-service
- 3.8 fulfillment-service
- 3.9 discovery-service
- 3.10 stream-service *(includes WebRTC-specific threats)*
- 3.11 admin-service
- 3.12 analytics-service

## 4. Out of scope (delegated to controls in other docs)

- PCI DSS specifics — `docs/compliance/pci-cdf.md`.
- NDPR data-residency / cross-border transfer — referenced in
  ADR-0003 (Clerk DPA) and to be expanded in `docs/compliance/ndpr.md`
  before launch.
- Insider threat / least-privilege RBAC — `docs/raci.md` and Vault
  policy (Phase 3 of v4.2 amendment).
