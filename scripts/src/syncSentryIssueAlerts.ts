/**
 * Release-time sync of Sentry issue alert rules for the production-
 * secret presence checks (task #96).
 *
 * For every entry in `productionSecretAlerts.config.ts` whose `sentry`
 * routing is enabled (canonical or backstop), idempotently upsert the
 * matching Sentry issue alert rule via Sentry's project rules API so
 * the Sentry-side rule list is regenerated from this repo rather than
 * maintained by hand in the Sentry UI.
 *
 * Sibling of `syncSentryMonitors.ts` (task #77), uses the same env-var
 * contract / dry-run flag / exit codes so the release pipeline only
 * has one operational surface area to learn.
 *
 * Why a list-then-upsert flow (vs the monitor PUT-by-slug)
 * --------------------------------------------------------
 * Sentry's monitor API supports slug-scoped PUT for create-or-update
 * idempotency. The issue rules API does not — rules are addressed by
 * a numeric `id` that Sentry assigns on POST, and there is no
 * deterministic slug field. To stay idempotent we:
 *
 *   1. GET the project's full rule list once.
 *   2. For each desired rule, look up the existing rule by exact
 *      `name` match (the `sentryRuleNameFor()` helper produces a
 *      stable, tag-scoped name with the `[managed:<tag>]` prefix).
 *   3. PUT to update an existing match, or POST to create a new one.
 *
 * The syncer deliberately does NOT delete unmanaged rules — operators
 * routinely add hand-tuned rules in the Sentry UI (action target
 * overrides, integration-specific routing, …) and a release-time
 * delete sweep would silently nuke them. Removing a rule from the
 * code config is therefore an explicit two-step: delete the entry,
 * then delete the rule in the Sentry UI by hand. The runbook
 * documents this.
 *
 * Rule shape
 * ----------
 * Each rule is configured to fire on the FIRST event Sentry sees with
 * `message:<tag>` in the production environment. The action is a
 * single `NotifyEventAction` (the project's default issue-owner
 * notification), because the actual on-call routing target is a
 * project-specific integration ID (Slack channel, PagerDuty service,
 * Opsgenie team) that lives in the Sentry UI rather than this repo.
 * Operators are expected to add the routing target action *once* per
 * rule after the first sync; the syncer preserves any extra actions
 * an operator added (it only overwrites the fields it owns: name,
 * environment, conditions, filters, frequency, actionMatch).
 *
 * Usage:
 *
 *   SENTRY_AUTH_TOKEN=... \
 *   SENTRY_ORG=... \
 *   SENTRY_PROJECT=... \
 *     pnpm --filter @workspace/scripts run sync-sentry-issue-alerts
 *
 * Env vars:
 *
 *   SENTRY_AUTH_TOKEN  required. Internal-integration token with
 *                      `project:write` scope on the named project.
 *   SENTRY_ORG         required. Org slug.
 *   SENTRY_PROJECT     required. Project slug — issue rules are
 *                      project-scoped (unlike monitors, which can be
 *                      org-default).
 *   SENTRY_BASE_URL    optional. Defaults to https://sentry.io.
 *   RUNBOOK_URL        optional. Public URL of the production-secrets
 *                      runbook used to render the deep link inside
 *                      each rule's name suffix. Defaults to the
 *                      relative repo path so the rule still tells
 *                      operators where to look even on first sync.
 *   DRY_RUN            optional. When set to "1", logs the payloads
 *                      it WOULD send and the create-vs-update
 *                      decision, then exits 0 without hitting Sentry.
 *
 * Exit codes:
 *   0  every rule upserted (or successfully dry-run logged)
 *   1  config / auth misconfiguration (missing env)
 *   2  one or more upserts failed — re-run after fixing the cause.
 */
import {
  PRODUCTION_SECRET_ALERTS,
  selectSentryAlerts,
  sentryRuleNameFor,
  type ProductionSecretAlertConfig,
} from "./productionSecretAlerts.config.js";

/**
 * Marker field on the managed notify action. Used by `mergeActions()`
 * to recognise (and strip) prior copies of our own action when an
 * existing rule is updated, so re-runs don't accumulate duplicate
 * notify actions and the field stays a stable identifier of "this
 * action was placed by the syncer".
 */
export const MANAGED_NOTIFY_ACTION_ID =
  "sentry.rules.actions.notify_event.NotifyEventAction";
export const MANAGED_NOTIFY_ACTION_MARKER = "runbook";

/** Subset of the Sentry rule shape we own. Other fields (e.g.
 *  operator-added PagerDuty / Slack / Opsgenie actions) are preserved
 *  on update via `mergeActions()`. */
export interface SentryRulePayload {
  name: string;
  /** "any" — first-seen and regression are mutually-exclusive Sentry
   *  events for the same issue (an event can't be both "first seen"
   *  and "regression" simultaneously), so the rule must fire if EITHER
   *  matches. Using "all" here would mean the rule never fires.
   *  filterMatch stays "all" because the message-contains filter is
   *  the single gate that scopes the rule to this specific tag. */
  actionMatch: "any";
  filterMatch: "all";
  /** Re-fire window in minutes. 30 mirrors Sentry's default and
   *  prevents a thundering-herd of pages from a single misconfigured
   *  deploy that boots multiple replicas in quick succession. */
  frequency: number;
  /** Restrict to the production environment. Sentry creates the
   *  environment lazily on first event; we don't pre-create. */
  environment: string;
  conditions: Array<{ id: string; [key: string]: unknown }>;
  filters: Array<{ id: string; match: string; value: string }>;
  /** Default notification action. Operators can add additional
   *  routing actions (PagerDuty, Slack, Opsgenie) in the Sentry UI;
   *  the syncer's update path preserves those. */
  actions: Array<{ id: string; [key: string]: unknown }>;
}

export function buildPayload(
  alert: ProductionSecretAlertConfig,
  runbookUrl: string,
): SentryRulePayload {
  return {
    name: sentryRuleNameFor(alert),
    actionMatch: "any",
    filterMatch: "all",
    frequency: 30,
    environment: "production",
    conditions: [
      // Page on the first event seen — these warnings are rare and
      // should never be debounced. A noisy / re-firing instance is
      // a signal the deploy is crash-looping, which is itself an
      // alert worth keeping.
      {
        id: "sentry.rules.conditions.first_seen_event.FirstSeenEventCondition",
      },
      // Also page if the issue regresses (was resolved, now back).
      // Catches the case where an operator marks the issue resolved
      // before the underlying secret has been re-set.
      {
        id: "sentry.rules.conditions.regression_event.RegressionEventCondition",
      },
    ],
    filters: [
      // Match the tag inside the structured message. The api-server
      // helpers all emit `<tag>: <human-readable reason>`, so a
      // `co` (contains) match keeps the rule resilient to the
      // reason-string drifting.
      {
        id: "sentry.rules.filters.message.MessageFilter",
        match: "co",
        value: alert.messageTag,
      },
    ],
    actions: [
      // Sentry's "send a notification (for new issues)" action. This
      // hits the project's default mail / integration target. Real
      // on-call routing (PagerDuty service, Slack channel) is added
      // by the operator in the UI; `mergeActions()` preserves those
      // operator-added actions on every PUT so this script never
      // overwrites them.
      {
        id: MANAGED_NOTIFY_ACTION_ID,
        // Marker field: lets `mergeActions()` recognise and strip the
        // previous copy of our own action when re-syncing, so we
        // don't accumulate duplicates on each release. Also rendered
        // in the email/Slack body so on-call sees the runbook deep
        // link in the page.
        [MANAGED_NOTIFY_ACTION_MARKER]: `${runbookUrl}${alert.runbookAnchor}`,
      },
    ],
  };
}

/**
 * Merge our managed actions with any operator-added actions on the
 * existing Sentry rule.
 *
 * Sentry's `PUT /api/0/projects/<o>/<p>/rules/<id>/` is a full
 * replacement of the rule body — fields we omit are wiped. So if an
 * operator added a PagerDuty / Slack / Opsgenie notify action via
 * the Sentry UI after the first sync (the documented routing step),
 * a naive PUT of just our managed action would silently strip it and
 * cause a pager regression on the very next release.
 *
 * Strategy:
 *
 *   1. Take the existing rule's `actions[]` (treated as opaque
 *      operator-owned configuration).
 *   2. Filter out any prior copy of OUR managed action (recognised
 *      by `id === MANAGED_NOTIFY_ACTION_ID` AND the presence of the
 *      `MANAGED_NOTIFY_ACTION_MARKER` field) so re-syncs don't
 *      accumulate duplicates and a runbook-URL change still takes
 *      effect.
 *   3. Prepend our freshly-built managed action.
 *
 * The `runbook` marker field is the discriminator because operator-
 * added NotifyEventActions wouldn't normally carry that exact string
 * key — it's the same field the Sentry UI ignores as informational,
 * which is why we picked it.
 */
export function mergeActions(
  managed: SentryRulePayload["actions"],
  existing: SentryRuleSummary | undefined,
): SentryRulePayload["actions"] {
  if (!existing) return managed;
  const raw = existing.actions;
  if (!Array.isArray(raw)) return managed;
  const preserved = (raw as Array<Record<string, unknown>>).filter((a) => {
    if (
      a &&
      a.id === MANAGED_NOTIFY_ACTION_ID &&
      Object.prototype.hasOwnProperty.call(a, MANAGED_NOTIFY_ACTION_MARKER)
    ) {
      return false;
    }
    return true;
  });
  return [
    ...managed,
    ...(preserved as SentryRulePayload["actions"]),
  ];
}

export interface SentryRuleSummary {
  id: string | number;
  name: string;
  /** Sentry returns extra fields we don't care about; the index
   *  signature makes the test fixtures less verbose. The `actions`
   *  field is read by `mergeActions()` to preserve operator-added
   *  routing actions on update. */
  [key: string]: unknown;
}

interface UpsertResult {
  alertTag: string;
  /** "create" when the rule didn't exist; "update" when an existing
   *  rule was matched by name. */
  action: "create" | "update";
  ok: boolean;
  status?: number;
  error?: string;
}

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; ok: boolean; text: () => Promise<string> }>;

function projectRulesUrl(baseUrl: string, org: string, project: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/0/projects/${encodeURIComponent(
    org,
  )}/${encodeURIComponent(project)}/rules/`;
}

async function readJson(
  res: Awaited<ReturnType<FetchLike>>,
): Promise<unknown> {
  const text = await res.text();
  if (text === "") return null;
  return JSON.parse(text);
}

/**
 * GET the project's full rule list. Sentry paginates rules but the
 * default page size (100) is well above the count of managed rules
 * we declare here, so a single page is enough. If a future scaling
 * problem hits this, swap to walking the `Link: <…>; rel="next"`
 * header — for now the simple call keeps the syncer dependency-free.
 */
export async function listRules(
  baseUrl: string,
  org: string,
  project: string,
  authToken: string,
  fetchImpl: FetchLike,
): Promise<SentryRuleSummary[]> {
  const url = projectRulesUrl(baseUrl, org, project);
  const res = await fetchImpl(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "<no body>");
    throw new Error(
      `failed to list Sentry rules (HTTP ${res.status}): ${body}`,
    );
  }
  const parsed = await readJson(res);
  if (!Array.isArray(parsed)) {
    throw new Error(
      `unexpected Sentry rules-list response: expected array, got ${typeof parsed}`,
    );
  }
  return parsed as SentryRuleSummary[];
}

export async function upsertRule(
  baseUrl: string,
  org: string,
  project: string,
  authToken: string,
  payload: SentryRulePayload,
  existing: SentryRuleSummary | undefined,
  fetchImpl: FetchLike,
): Promise<{ ok: boolean; status?: number; error?: string; action: "create" | "update" }> {
  const action: "create" | "update" = existing ? "update" : "create";
  const baseRulesUrl = projectRulesUrl(baseUrl, org, project);
  const url = existing
    ? `${baseRulesUrl}${encodeURIComponent(String(existing.id))}/`
    : baseRulesUrl;
  // On UPDATE, preserve any operator-added actions (PagerDuty / Slack
  // / Opsgenie) that the operator wired in the Sentry UI after the
  // first sync. See `mergeActions()` for the merge contract. CREATE
  // sends only the managed action — there can't be operator-added
  // actions on a rule that doesn't exist yet.
  const finalPayload: SentryRulePayload = existing
    ? { ...payload, actions: mergeActions(payload.actions, existing) }
    : payload;
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(url, {
      method: existing ? "PUT" : "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(finalPayload),
    });
  } catch (err) {
    return {
      ok: false,
      action,
      error: `fetch failed: ${(err as Error).message}`,
    };
  }
  if (!res.ok) {
    let body = "";
    try {
      body = await res.text();
    } catch {
      body = "<failed to read response body>";
    }
    return {
      ok: false,
      action,
      status: res.status,
      error: `HTTP ${res.status}: ${body}`,
    };
  }
  return { ok: true, action, status: res.status };
}

export async function main(
  deps: {
    env?: NodeJS.ProcessEnv;
    alerts?: readonly ProductionSecretAlertConfig[];
    fetchImpl?: FetchLike;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
  } = {},
): Promise<0 | 1 | 2> {
  const env = deps.env ?? process.env;
  const alerts = selectSentryAlerts(deps.alerts ?? PRODUCTION_SECRET_ALERTS);
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as FetchLike);
  const stdout =
    deps.stdout ?? ((line: string) => process.stdout.write(line + "\n"));
  const stderr =
    deps.stderr ?? ((line: string) => process.stderr.write(line + "\n"));

  if (alerts.length === 0) {
    stdout(
      "[syncSentryIssueAlerts] no Sentry-routed alerts declared; nothing to sync.",
    );
    return 0;
  }

  const dryRun = env.DRY_RUN === "1";
  const baseUrl = env.SENTRY_BASE_URL ?? "https://sentry.io";
  const org = env.SENTRY_ORG;
  const project = env.SENTRY_PROJECT;
  const authToken = env.SENTRY_AUTH_TOKEN;
  const runbookUrl = env.RUNBOOK_URL ?? "docs/runbooks/production-secrets.md";

  if (!org || org.trim() === "") {
    stderr("SENTRY_ORG is required");
    return 1;
  }
  if (!project || project.trim() === "") {
    stderr("SENTRY_PROJECT is required");
    return 1;
  }
  if (!dryRun && (!authToken || authToken.trim() === "")) {
    stderr(
      "SENTRY_AUTH_TOKEN is required (set DRY_RUN=1 to skip the API call)",
    );
    return 1;
  }

  let existingRules: SentryRuleSummary[] = [];
  if (!dryRun) {
    try {
      existingRules = await listRules(
        baseUrl,
        org,
        project,
        authToken!,
        fetchImpl,
      );
    } catch (err) {
      stderr(`[syncSentryIssueAlerts] ${(err as Error).message}`);
      return 2;
    }
  }

  const failures: UpsertResult[] = [];
  for (const alert of alerts) {
    const payload = buildPayload(alert, runbookUrl);
    const existing = existingRules.find((r) => r.name === payload.name);
    const action: "create" | "update" = existing ? "update" : "create";

    if (dryRun) {
      stdout(
        `[syncSentryIssueAlerts][dry-run] would ${action} rule "${payload.name}" -> ${projectRulesUrl(baseUrl, org, project)}${existing ? `${existing.id}/` : ""}`,
      );
      stdout(`  payload: ${JSON.stringify(payload)}`);
      continue;
    }

    stdout(
      `[syncSentryIssueAlerts] ${action} "${payload.name}" (${alert.severity}) ...`,
    );
    const result = await upsertRule(
      baseUrl,
      org,
      project,
      authToken!,
      payload,
      existing,
      fetchImpl,
    );
    if (!result.ok) {
      stderr(
        `[syncSentryIssueAlerts] FAILED ${alert.messageTag}: ${result.error ?? "unknown error"}`,
      );
      failures.push({
        alertTag: alert.messageTag,
        action: result.action,
        ok: false,
        status: result.status,
        error: result.error,
      });
    } else {
      stdout(`[syncSentryIssueAlerts]   OK (HTTP ${result.status})`);
    }
  }

  if (failures.length > 0) {
    stderr(
      `[syncSentryIssueAlerts] ${failures.length} of ${alerts.length} upserts failed; re-run after fixing the cause.`,
    );
    return 2;
  }
  if (dryRun) {
    stdout(
      `[syncSentryIssueAlerts] dry-run complete; ${alerts.length} payload(s) logged.`,
    );
  } else {
    stdout(
      `[syncSentryIssueAlerts] ${alerts.length} rule(s) reconciled into ${baseUrl} org=${org} project=${project}.`,
    );
  }
  return 0;
}

const isDirectInvocation =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /syncSentryIssueAlerts(\.[mc]?[jt]s)?$/.test(process.argv[1]);

if (isDirectInvocation) {
  void main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(
        `syncSentryIssueAlerts crashed: ${(err as Error).message}\n`,
      );
      process.exit(1);
    },
  );
}
