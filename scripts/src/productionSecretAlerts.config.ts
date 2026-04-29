/**
 * Source-of-truth for the production-secret presence-check alerts
 * (task #96).
 *
 * Three boot-time helpers in the api-server emit a unique log message
 * tag on production-shaped boots when a critical secret is unset:
 *
 *   - sentry_dsn_missing_for_production   (lib/sentry.ts)
 *   - clerk_secret_key_missing_for_production
 *                                         (middlewares/clerkProxyMiddleware.ts)
 *   - session_secret_missing_for_production
 *                                         (lib/sessionSecret.ts)
 *
 * Until this file existed, the warnings still fired but no alert rule
 * was wired in Sentry / the log aggregator, so on-call wasn't paged.
 * The intent table below is consumed by:
 *
 *   1. scripts/src/syncSentryIssueAlerts.ts — pushes the Sentry
 *      canonical / backstop entries via Sentry's project rules API at
 *      release time so the rule list is regenerated from this file
 *      rather than maintained by hand in the Sentry UI. Same shape as
 *      the existing Sentry Cron monitor sync (see
 *      `scripts/src/syncSentryMonitors.ts`, task #77).
 *
 *   2. scripts/src/checkSentryIssueAlertSyncCredentials.ts — runs in
 *      CI and fails the build when this file declares a Sentry
 *      canonical/backstop alert but the GitHub vars/secrets the
 *      release-time sync needs are missing. Same pattern as the
 *      existing monitor-sync credentials gate (task #109).
 *
 *   3. scripts/src/printLogAggregatorAlerts.ts — emits ready-to-paste
 *      Datadog Monitor / Loki Alertmanager YAML for an operator. The
 *      log aggregator is not yet centrally provisioned in this repo,
 *      so the printer leaves the actual rule application to the
 *      operator running the script (output is deterministic and
 *      version-controlled-friendly).
 *
 * Routing intent
 * --------------
 * Each entry declares which tools host the *canonical* alert (the one
 * that pages on-call first) versus the *backstop* alert (the one that
 * fires when the canonical pipe is itself the thing that broke). The
 * most important inversion is `sentry_dsn_missing_for_production`:
 * its canonical alert lives in the LOG AGGREGATOR because Sentry
 * cannot tell you Sentry is off — see the runbook for the full
 * rationale.
 *
 * Severity
 * --------
 * sev-1 = page-immediately. Used for the two checks whose failure
 * mode is auth bypass (Clerk) or per-request 5xx storm on
 * checkout/KYC (SESSION_SECRET).
 *
 * sev-2 = page on-call but second-priority. Used for SENTRY_DSN
 * because the failure mode is "every other alert is now blind" rather
 * than "the user-facing flow is broken right now" — it's still
 * urgent, just not in the same way.
 *
 * Adding a new entry
 * ------------------
 * Pick the message tag from the api-server boot-time helper. Set the
 * canonical/backstop booleans based on the failure mode (Sentry can't
 * monitor itself; everything else defaults to Sentry canonical + log-
 * aggregator backstop). Re-run the release-time sync to push the new
 * rule.
 */

export type AlertSeverity = "sev-1" | "sev-2";

export interface AlertRoutingIntent {
  /** True when this tool hosts the alert that pages on-call first. */
  canonical: boolean;
  /** True when this tool hosts a redundant alert that exists to catch
   *  the case where the canonical pipe is itself broken. */
  backstop: boolean;
}

export interface ProductionSecretAlertConfig {
  /** Unique log message tag emitted by the api-server boot-time
   *  helper. Used as the alert filter (`message:"<tag>"`) on every
   *  side. Must match the literal string in the api-server source so
   *  the coverage check can verify wiring end-to-end. */
  messageTag: string;
  /** Human-readable summary used in alert names / descriptions. */
  summary: string;
  /** Severity for paging routing. */
  severity: AlertSeverity;
  /** Anchor in `docs/runbooks/production-secrets.md` so every alert
   *  body can deep-link to the section that explains it. The leading
   *  `#` is included; the renderer prepends the runbook URL. */
  runbookAnchor: string;
  /** Sentry-side routing intent. */
  sentry: AlertRoutingIntent;
  /** Log-aggregator-side routing intent. */
  logAggregator: AlertRoutingIntent;
  /** Path to the api-server source file that owns the boot-time
   *  helper. The coverage check (`syncSentryIssueAlerts.test.ts`)
   *  uses this to assert the `messageTag` literal is actually emitted
   *  by the named helper, so a future rename can't silently
   *  desynchronise the alert from the code. */
  emittedBy: string;
}

/**
 * The three production-secret alerts that this task wires.
 *
 * To add a fourth (e.g. `mfa_encryption_key_missing_for_production`)
 * follow the same pattern as the entries below — the syncer / printer
 * iterate this array, so new entries propagate automatically.
 */
export const PRODUCTION_SECRET_ALERTS: readonly ProductionSecretAlertConfig[] = [
  {
    messageTag: "sentry_dsn_missing_for_production",
    summary:
      "SENTRY_DSN unset on a production-shaped deploy — every Sentry-backed alert is silently disabled.",
    // sev-2: high but not user-facing. The page is "your alert pipe is
    // off", not "your users are 5xx-ing right now".
    severity: "sev-2",
    runbookAnchor: "#sentry_dsn",
    // INVERSION: log aggregator is canonical because Sentry can't
    // tell you Sentry is off. The Sentry-side rule is a backstop —
    // it only fires AFTER the DSN gets restored on a later deploy,
    // at which point operators should treat it as "the previous
    // deploy was flying blind for N hours" rather than the live
    // page.
    sentry: { canonical: false, backstop: true },
    logAggregator: { canonical: true, backstop: false },
    emittedBy: "artifacts/api-server/src/lib/sentry.ts",
  },
  {
    messageTag: "clerk_secret_key_missing_for_production",
    summary:
      "CLERK_SECRET_KEY unset on a production-shaped deploy — auth bypass on /api/__clerk, /auth/otp/verify, Socket.IO.",
    // sev-1: silent auth regression on the entire production deploy.
    severity: "sev-1",
    runbookAnchor: "#clerk_secret_key",
    sentry: { canonical: true, backstop: false },
    logAggregator: { canonical: false, backstop: true },
    emittedBy: "artifacts/api-server/src/middlewares/clerkProxyMiddleware.ts",
  },
  {
    messageTag: "session_secret_missing_for_production",
    summary:
      "SESSION_SECRET unset/short on a production-shaped deploy — KYC uploads, shipping quote signing, address verification all 5xx on first request.",
    // sev-1: per-request 5xx storms on checkout / KYC the moment a
    // user hits an affected route. Imminent revenue + onboarding
    // impact.
    severity: "sev-1",
    runbookAnchor: "#session_secret",
    sentry: { canonical: true, backstop: false },
    logAggregator: { canonical: false, backstop: true },
    emittedBy: "artifacts/api-server/src/lib/sessionSecret.ts",
  },
] as const;

/**
 * Filter helper used by the Sentry sync script. Returns every alert
 * that opts Sentry in for either canonical or backstop routing.
 *
 * Pure function — no I/O — so the test suite can drive it with inline
 * fixtures and the syncer can reuse the same predicate for both the
 * "create" and "delete unmanaged" passes (the second is a future
 * extension; today the syncer only upserts).
 */
export function selectSentryAlerts(
  alerts: readonly ProductionSecretAlertConfig[],
): readonly ProductionSecretAlertConfig[] {
  return alerts.filter((a) => a.sentry.canonical || a.sentry.backstop);
}

/**
 * Filter helper used by the log-aggregator printer. Returns every
 * alert that opts the log aggregator in for either canonical or
 * backstop routing.
 */
export function selectLogAggregatorAlerts(
  alerts: readonly ProductionSecretAlertConfig[],
): readonly ProductionSecretAlertConfig[] {
  return alerts.filter(
    (a) => a.logAggregator.canonical || a.logAggregator.backstop,
  );
}

/**
 * Stable Sentry rule name for an alert. Used as the de-duplication
 * key when reconciling existing project rules with the desired set
 * during sync — Sentry's rules API does not have slug-based PUT
 * semantics for issue rules, so the syncer matches by exact name.
 *
 * The `[managed:<tag>]` prefix is intentional:
 *   - `[managed:` lets an operator easily grep the Sentry UI for
 *     "rules that are owned by this repo" vs hand-created rules.
 *   - `<tag>` makes the de-dup key tag-scoped so two alerts sharing a
 *     summary string would still get distinct names.
 */
export function sentryRuleNameFor(alert: ProductionSecretAlertConfig): string {
  return `[managed:${alert.messageTag}] Production secret presence check`;
}
