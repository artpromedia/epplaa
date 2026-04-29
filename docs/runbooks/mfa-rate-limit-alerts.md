# Runbook: MFA rate-limit burst alerts

The api-server caps the mutating MFA routes — `setup`, `verify`,
`backup-code` consume, `regenerate-backup-codes`, and `disable` — at a
small per-user hourly quota. Limits are declared in
`artifacts/api-server/src/routes/mfa.ts`:

| Limiter name      | Routes                                              | Cap (per hour, per identity) |
| ----------------- | --------------------------------------------------- | ---------------------------- |
| `mfa_setup`       | `POST /api/me/mfa/setup`                            | 10                           |
| `mfa_verify`      | `POST /api/me/mfa/verify`, `…/backup-code`          | 20                           |
| `mfa_sensitive`   | `POST /api/me/mfa/disable`, `…/regenerate-backup-codes` | 5 each (per-route)        |

When a user exhausts a bucket they get a clean `429 rate_limited`. The
existing forensic table `rate_limit_events` captures every 429 for
post-incident review, but on its own that's a passive record — nothing
reads it in real time.

## What this alert detects

`MfaAbuseWatcher`
(`artifacts/api-server/src/lib/rate-limit/mfaAbuseWatcher.ts`) sits
inside the apiRateLimit 429 path and tracks per-identity 429 counts on
the `mfa_*` limiters in a sliding window. When a single identity
crosses the threshold inside the window it pages operators via:

- A structured warn log keyed off
  `"mfa_rate_limit_burst_detected"` — visible in the log aggregator
  even when Sentry is off.
- A Sentry `captureMessage` with `level: "warning"` and tags
  `subsystem=rate_limit`, `alert=mfa_rate_limit_burst`. The fingerprint
  is `["mfa_rate_limit_burst", <identity>]` so every burst from the
  same identity rolls up into ONE Sentry issue. Sentry's default
  new-issue notification fires on the first event so the alert lands
  even without a project-specific rule.

The `extra` payload includes the `identity` (e.g. `user:u_abc123` or
`ip:1.2.3.4`), the offending `route` and `limiter` name, the observed
`count`, and the configured `threshold` / `windowMs` / `cooldownMs` —
everything triage needs to lock the account and contact the user
without grepping the database.

## Threshold & tuning

| Env var                            | Default        | What it controls                                              |
| ---------------------------------- | -------------- | ------------------------------------------------------------- |
| `MFA_RATE_LIMIT_ALERT_THRESHOLD`   | `3`            | Number of MFA 429s within the window to fire the alert        |
| `MFA_RATE_LIMIT_ALERT_WINDOW_MS`   | `900000` (15m) | Sliding-window length                                         |
| `MFA_RATE_LIMIT_ALERT_COOLDOWN_MS` | `1800000` (30m) | Per-identity throttle between alerts for the same identity   |

Why these numbers: the MFA route caps themselves are 5 / 10 / 20 per
**hour** per identity. Three 429s in 15 minutes against the MFA
mutation surface means a caller is hammering it well past the
legitimate ceiling — either an account-takeover attempt or a
client-side runaway loop. Both are operator-actionable.

The cooldown gates BOTH the Sentry capture and the structured warn
log together — they emit as one alert event per identity per
cooldown window. The full forensic timeline of every individual 429
(including the suppressed-by-cooldown ones) lives in the
`rate_limit_events` audit table, which is the canonical source for
post-incident review and is queryable by `identity` + `ts`.

## Recommended response

When you receive an `mfa_rate_limit_burst_detected` page:

1. **Look up the identity in the Sentry `extra`.**
   - `user:<userId>` — a signed-in account is the suspect. Cross-check
     `user_sessions` / Clerk to see which device + IP started the
     burst. Forensic detail is in the `rate_limit_events` table, keyed
     on `identity = 'user:<userId>'`, ordered by `ts DESC`.
   - `ip:<addr>` — anonymous caller. Check whether the IP has touched
     other sensitive routes recently before deciding whether to block
     it network-side.

2. **Lock the account if the identity is a signed-in user.**
   - Disable Clerk sign-in for the user (admin console → Users →
     Suspend), AND
   - Mark MFA `disabled` for the user via the admin console so a
     compromised secondary factor can't be used for re-entry, AND
   - Invalidate any active sessions the account holds.

3. **Contact the user out-of-band** (registered email / phone). The
   security-event email pipeline (`docs/runbooks/production-secrets.md`
   → email provider section) is the authoritative channel — do NOT
   notify via the in-app inbox alone, the attacker controls the
   browser if they made it past step 1.

4. **Capture forensic evidence** before clearing the alert: copy the
   relevant `rate_limit_events` rows (last 24h for that identity) into
   the incident ticket. Retention is 90 days
   (`docs/runbooks/rate-limit-store.md` → retention section), so don't
   leave investigation longer than that.

5. **Resolve the Sentry issue** once the account is locked and the
   user contacted. The fingerprint is per-identity, so the issue will
   re-open on a fresh burst — that's the desired behaviour.

## Wire alerts (optional fan-out)

The Sentry `subsystem=rate_limit` + `alert=mfa_rate_limit_burst` tag
combination is intentionally compatible with the existing rate-limit
alert routing. If you want Slack / PagerDuty paging on top of the
Sentry default rule, add a Sentry alert rule with:

- **Filter:** event tag `alert` equals `mfa_rate_limit_burst`
- **Action:** route to the `#oncall-trust-safety` Slack channel and/or
  the `trust-safety` PagerDuty service.

No additional environment variables are required — the existing
incident-notifier wiring (Slack/PagerDuty webhooks for the
`rate_limit_store_degraded` channel,
`docs/runbooks/rate-limit-store.md`) is intentionally NOT reused here
because that channel pages infra on-call; MFA-burst alerts belong to
trust & safety.

## Memory / footprint

The watcher keeps an in-process `Map<identity, bucket>`. A periodic
sweep (cadence = `MFA_RATE_LIMIT_ALERT_WINDOW_MS`) drops buckets whose
entries have aged out of the window AND whose cooldown has lapsed, so
a steady churn of distinct attacker identities does not grow memory
unboundedly. A bucket is only ever created on a 429, which is itself
rate-limited by the per-route caps, so the worst-case cardinality is
bounded by the number of distinct identities that can attack within
one window.

Multi-replica posture: the watcher is per-replica (in-process). Each
replica only sees the 429s that hit it, so a co-ordinated attack
spread across replicas may see its 429 count split across the
watchers. The threshold is conservative enough that a real
compromise burst still trips at least one replica — and the per-replica
Sentry events all roll up into the same fingerprint, so triage sees a
single issue. If we ever need cross-replica aggregation, the natural
upgrade is to read the `rate_limit_events` table from a scheduled job
instead of in-process state.

## Implementation pointers

- Watcher: `artifacts/api-server/src/lib/rate-limit/mfaAbuseWatcher.ts`
- Wiring (429 hook): `artifacts/api-server/src/middlewares/apiRateLimit.ts`
  (search for `mfaAbuseWatcher.record`)
- MFA limiter declarations:
  `artifacts/api-server/src/routes/mfa.ts` (`mfa_sensitive`,
  `mfa_setup`, `mfa_verify`)
- Sweep timer: `artifacts/api-server/src/app.ts`
  (search for `startMfaAbuseWatcherSweepTimer`)
- Tests:
  `artifacts/api-server/src/lib/rate-limit/mfaAbuseWatcher.test.ts`
  + the `apiRateLimit MFA-burst watcher wiring` block in
  `artifacts/api-server/src/middlewares/apiRateLimit.test.ts`
