# Epplaa Admin Console

Internal operator console for Epplaa Trust &amp; Safety, finance ops, and support.

## Access &amp; auth

- Authentication is handled by Clerk (same instance as the buyer app).
  Set `VITE_CLERK_PUBLISHABLE_KEY` to enable sign-in.
- Authorization is enforced **server-side** by `requireRole(...)` middleware
  against the `user_roles` table. The frontend only checks roles to choose
  what to render; bypassing the UI gets you nothing past the API.
- Roles: `admin`, `moderator`, `finance_ops`, `support`. `admin` implies all.
- **MFA is required**: enable TOTP and/or WebAuthn in the Clerk dashboard
  and mark MFA as required for users in the admin Clerk org. The console
  itself relies on Clerk's session enforcement; the backend trusts the
  Clerk JWT and the `user_roles` row, so MFA is the perimeter.

## Bootstrap

Set the env variable `EPPLAA_ADMIN_USER_IDS` on the API server to a
comma-separated list of Clerk user ids. On boot, those users are granted
the `admin` role (idempotent).

## Pages

- **Dashboard** – queue counters, SLA-due, provider health
- **Cases** – moderation cases (reports/scans/disputes); transition / assign / decide
- **Disputes** – disputed returns; refund / partial / deny (writes payout actions when funds clawed back)
- **Payouts** – seller payout queue with hold / release / clawback + history
- **Takedowns** – issue and audit takedowns
- **Users &amp; roles** – grant / revoke roles by Clerk user id (admin-only)
- **Scan bench** – run the active moderation provider against arbitrary text

## Audit

Every mutation is appended to the hash-chained `audit_events` log alongside
the route's `auditMutations` middleware. Decisions also write structured
`payout_actions` rows where applicable.
