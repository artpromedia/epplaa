# PCI DSS Cardholder Data Flow (CDF)

- **Status**: Initial draft (Phase 0 of v4.2 amendment); finalised
  in Phase 10.
- **Target self-assessment level**: SAQ-A (the lowest tier).
- **Owner**: Security Eng, signed off by Finance / Compliance.

## 1. Posture statement

Epplaa **does not store, process, or transmit primary account number
(PAN) data on its own infrastructure**. All card-data capture is
performed by Paystack and Flutterwave hosted-payment-page redirects
or iframes. The Epplaa origin and the Epplaa origin's databases are
out of PCI scope; only the redirect link and the webhook callback are
in scope, both of which are covered by SAQ-A.

This stance is the explicit reason payment-service (Phase 4 step 6)
exists as a separate extraction: it concentrates everything that
*does* touch the PCI scope (webhook receipt, payment-status events,
refund initiation) into one service whose hardening, audit, and
threat-model coverage can be deepest.

## 2. CDF diagram (textual; replace with rendered diagram in Phase 10)

```
   Buyer browser / RN app
            │
            │ 1. tap "Pay"
            ▼
   apps/web  ─────────────►  Paystack / Flutterwave
   apps/mobile               hosted payment page (iframe or redirect)
                                       │
                                       │ 2. card details entered
                                       │    *DIRECTLY INTO PROVIDER*
                                       │    (not into Epplaa)
                                       │
                                       │ 3. provider authorises with
                                       │    issuer + scheme
                                       │
                                       ▼
                             Provider stores PAN
                             (Epplaa never sees it)
                                       │
                                       │ 4. redirect back to
                                       │    apps/web/payment/return
                                       │    with reference token
                                       │
                                       │ 5. signed webhook to
                                       │    payment-service
                                       │    /webhook endpoint
                                       │
                                       ▼
                            payment-service
                            stores: reference, last4, brand,
                                    transaction_id, amount, status,
                                    provider_account_id,
                                    idempotency_key
                            does NOT store: PAN, CVV, expiry
```

## 3. Data tags

The payment-service Postgres schema is annotated as follows
(verified by the data-dictionary generator in Phase 10):

| Column | Tag | Notes |
| :--- | :--- | :--- |
| `pan` | — | not present in schema |
| `cvv` | — | not present in schema |
| `expiry` | — | not present in schema |
| `provider_reference` | `payment` | identifier supplied by provider |
| `last4` | `payment` | allowed by SAQ-A (card-suffix display) |
| `brand` | `payment` | scheme name (Visa / MC / Verve) |
| `amount`, `currency` | `internal` | |
| `status`, `idempotency_key` | `internal` | |
| `buyer_user_id` | `pii` | foreign key to identity-service |

## 4. SAQ-A controls in scope

Per PCI DSS v4 SAQ-A, the controls below apply. Each row will be
filled in (control owner, evidence reference, last verified date) by
the Phase 10 PR.

| Control | Owner | Evidence | Last verified |
| :--- | :--- | :--- | :---: |
| 2.2.6 — Vendor defaults removed on systems in CDF | SRE/Plat | (TBD) | — |
| 6.4.3 — Scripts on payment pages inventoried + integrity-checked | Frontend | (TBD) | — |
| 8.3 — Strong authentication for any access to admin tooling that touches payment routing | Sec | MFA-elevation contract test (`mfa.contract.test.ts`); to be moved to OPA | — |
| 9.4.1 — Physical security of any media — N/A (no on-prem media in CDF) | — | — | — |
| 11.6.1 — Tamper-detection on payment pages (HTML, JS) | Frontend | (TBD) | — |
| 12.3 — Risk assessment annually | Sec | `docs/risk-register.md` | — |
| 12.8 — Service-provider list maintained | Fin | (TBD) | — |
| 12.10 — Incident response plan | SRE/Plat | `docs/runbooks/` (in progress) | — |

## 5. Out of SAQ-A scope (and why)

- **Buyer browsers / mobile apps** — payment fields are rendered by
  the *provider's* iframe or hosted page, so Epplaa client code
  carries only the redirect glue. This is the explicit SAQ-A
  boundary.
- **Postgres in payment-service** — stores no cardholder data per §3.
- **Redpanda** — no cardholder data flows; only payment-status
  events with reference tokens.

## 6. Things that would force a scope expansion (and how we avoid them)

| Tempting feature | PCI consequence | Decision |
| :--- | :--- | :--- |
| Tokenized card-on-file managed by Epplaa | Moves us to SAQ-A-EP at minimum | **No.** Use provider-managed tokenisation. |
| In-app card-entry form (collect → submit to provider) | Moves us to SAQ-A-EP | **No.** Use redirect or provider iframe only. |
| Reading PAN from any webhook field | Moves us to SAQ-D | **No.** Webhook receivers reject any payload containing PAN-shaped numbers; tested in CI. |

## 7. Annual cadence

This document is reviewed at minimum annually and on every change to
payment-service or the integration surface with Paystack/Flutterwave.
Reviews are signed by Finance / Compliance per `docs/raci.md`.
