/**
 * syncSentryOptOutAuditFilter — keep the rate-limit opt-out Sentry
 * alert rules' `hostname:` regex filter in sync with the inventory at
 * `docs/runbooks/rate-limit-store-opt-outs.md` (task #108).
 *
 * Why this exists
 * ---------------
 * The `rate_limit_store_memory_in_production_via_opt_out` warn tag is
 * routed through two Sentry issue alerts (see
 * `docs/runbooks/rate-limit-store.md` Wire alerts section):
 *
 *   1. Audit notification (inventoried hosts) — `hostname:` regex
 *      MATCHES (`re`) the union of every `HOSTNAME (regex match)`
 *      row in the inventory. Routed as a notification, not a page.
 *   2. Page on unknown host (uninventoried hosts) — `hostname:`
 *      regex does NOT MATCH (`nre`) any inventory row. Routed as a
 *      page.
 *
 * Both rules' `hostname:` filter `value` is hand-pasted in the Sentry
 * UI in the same change that adds a row to the inventory file. That
 * hand-paste is the alerting chain's single point of failure: a
 * forgotten paste means a freshly-sanctioned opt-out's first warn-on-
 * boot pages on-call as if it were a misuse, exactly the wrong
 * outcome.
 *
 * Task #97 already shipped a tested parser for the inventory
 * (`scripts/src/checkRateLimitOptOutSunsets.ts` exposes
 * `parseInventoryTable` and `InventoryRow`). Task #98 added a weekly
 * drift rehearsal that pages on divergence after the fact. This
 * script closes the loop *proactively*: it can either auto-sync the
 * Sentry rules from the inventory (default scheduled mode) or fail
 * loudly on divergence without writing (PR-time check mode), so the
 * inventory PR + the Sentry rule update become a single atomic step
 * that operators can't forget.
 *
 * What it touches on Sentry's side
 * --------------------------------
 * Only the `hostname:` filter `value` field on each of the two rules
 * is owned by this syncer. Everything else on the rule body — name,
 * actions (PagerDuty / Slack routing), other conditions, frequency,
 * environment, owners, the filter's `id` and `match` mode — is
 * preserved verbatim from the existing rule on update. This mirrors
 * how `syncSentryIssueAlerts.ts` preserves operator-added actions on
 * the secret-alert rules.
 *
 * The match mode (`re` for audit, `nre` for page) is *checked*, not
 * rewritten — a flipped mode is treated as drift and surfaced via
 * exit code 1 (probe error) so an operator decides which side is
 * correct, rather than a sync silently flipping the page rule into
 * audit-only.
 *
 * Modes (env)
 * -----------
 *   default            Auto-sync. PUT each rule whose hostname filter
 *                      diverges from the inventory.
 *   CHECK_ONLY=1       Read-only divergence check (suitable for PRs).
 *                      Exits non-zero on any divergence; never PUTs.
 *   DRY_RUN=1          Logs the PUT body it WOULD send for any
 *                      divergent rule, exits 0 without hitting the
 *                      Sentry write API. Still requires SENTRY_AUTH_TOKEN
 *                      because we still GET the live rule bodies.
 *
 * Required env (auto-sync / DRY_RUN / CHECK_ONLY all need these):
 *   SENTRY_AUTH_TOKEN                       Internal-integration token
 *                                           with `alerts:read` (and
 *                                           `alerts:write` for the
 *                                           write modes).
 *   SENTRY_ORG                              Sentry org slug.
 *   SENTRY_PROJECT                          Sentry project slug.
 *   RATE_LIMIT_OPT_OUT_AUDIT_RULE_ID        Numeric id of the
 *                                           "audit notification" rule.
 *   RATE_LIMIT_OPT_OUT_PAGE_RULE_ID         Numeric id of the
 *                                           "page on unknown host" rule.
 *
 * Optional env:
 *   SENTRY_BASE_URL                         Defaults to https://sentry.io.
 *   INVENTORY_PATH                          Override the inventory
 *                                           markdown path (defaults to
 *                                           docs/runbooks/rate-limit-store-opt-outs.md
 *                                           relative to the repo root).
 *   EMPTY_INVENTORY_PLACEHOLDER             Regex written into the
 *                                           hostname filter when the
 *                                           inventory is empty (no
 *                                           active opt-outs). Sentry's
 *                                           filter `value` field can't
 *                                           be left blank, so we use
 *                                           an explicit "matches no
 *                                           real host" regex. Defaults
 *                                           to `^__no_inventoried_opt_outs__$`.
 *
 * Exit codes (mirror checkRateLimitOptOutSunsets.ts):
 *   0  in sync (no change), sync succeeded, dry-run completed, or
 *      auto-sync but the rules already matched the inventory.
 *   1  probe error: missing config, inventory parse failure, Sentry
 *      API error (auth, network, 5xx), malformed rule body, flipped
 *      match mode, missing hostname filter, etc.
 *   2  drift detected (CHECK_ONLY mode) OR a write attempt failed
 *      (auto-sync mode). The surrounding wrapper should treat both
 *      as "page on-call" — drift means the inventory PR landed
 *      without updating the rule; failed write means the auto-sync
 *      itself didn't take effect, so the rule is still drifting.
 *
 * The script writes a single JSON line to stdout describing what it
 * observed/changed so the surrounding wrapper (cron log, Sentry
 * forwarder, GitHub step summary) can include it verbatim. Errors go
 * to stderr.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseInventoryTable,
  type InventoryRow,
} from "./checkRateLimitOptOutSunsets.js";

/**
 * This file lives at scripts/src/syncSentryOptOutAuditFilter.ts. We
 * resolve the default inventory path relative to it so the script
 * works regardless of the CWD it is invoked from.
 */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_INVENTORY_PATH = path.resolve(
  MODULE_DIR,
  "..",
  "..",
  "docs",
  "runbooks",
  "rate-limit-store-opt-outs.md",
);

/** Default sentinel written into the hostname filter when the
 *  inventory is in its empty/placeholder state. Sentry's TaggedEventFilter
 *  rejects an empty `value` (the rule body fails server-side validation),
 *  so we can't simply blank the field — the audit rule has to keep
 *  *something* in there that just refuses to match any real host. The
 *  string is intentionally not a valid hostname so an operator
 *  scanning the Sentry UI sees "oh, no opt-outs are inventoried"
 *  instead of a stale union from a previous active state. */
export const EMPTY_INVENTORY_DEFAULT_VALUE =
  "^__no_inventoried_opt_outs__$";

/** Logical name of a managed rule. Used in stdout / report shapes
 *  so operators see "audit-notification drifted" rather than the bare
 *  numeric Sentry rule id. */
export type ManagedRuleName = "audit-notification" | "page-on-unknown-host";

/** What match mode each managed rule should be using. A flipped mode
 *  is surfaced as a probe error rather than silently auto-corrected:
 *  flipping `re` <-> `nre` would invert paging vs notifying for every
 *  inventoried host, and the syncer can't safely guess which side is
 *  the operator's intent. */
export const EXPECTED_MATCH_MODES: Record<ManagedRuleName, "re" | "nre"> = {
  "audit-notification": "re",
  "page-on-unknown-host": "nre",
};

/** Sentry rule body shape we touch. Other fields are preserved
 *  verbatim — the syncer only edits the hostname-keyed filter's
 *  `value`. The index signature is intentional: Sentry returns many
 *  fields we don't care about (owners, dateAdded, lastTriggered,
 *  …) and they all need to round-trip through PUT untouched. */
export interface SentryRuleBody {
  conditions?: unknown;
  filters?: unknown;
  [k: string]: unknown;
}

/** Strip surrounding backticks from a hostname cell. The inventory
 *  conventionally backticks the regex for readability
 *  (e.g. `` `^api-canary-[a-z0-9]+$` ``) but the canonical
 *  Sentry-side form is the bare regex. */
function stripBackticks(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith("`") && t.endsWith("`")) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Split a regex string on TOP-LEVEL `|` — i.e. `|` characters that
 * are not inside a `[...]` character class or a `(...)` group, and
 * are not escaped with `\`. Mirrors the splitter in the sibling
 * drift rehearsal (`checkRateLimitOptOutInventoryDrift.ts`) so the
 * two scripts agree on what counts as one alternative vs two.
 *
 * Hostname regexes in this inventory are simple anchored patterns
 * and the docs only sanction `|` as an alternation between sibling
 * hostnames — so this is the right granularity to compare on.
 */
export function splitOnTopLevelPipe(regex: string): string[] {
  const out: string[] = [];
  let buf = "";
  let bracketDepth = 0;
  let parenDepth = 0;
  for (let i = 0; i < regex.length; i++) {
    const ch = regex[i];
    if (ch === "\\" && i + 1 < regex.length) {
      buf += ch + regex[i + 1];
      i += 1;
      continue;
    }
    if (ch === "[") bracketDepth += 1;
    else if (ch === "]" && bracketDepth > 0) bracketDepth -= 1;
    else if (ch === "(" && bracketDepth === 0) parenDepth += 1;
    else if (ch === ")" && bracketDepth === 0 && parenDepth > 0)
      parenDepth -= 1;
    if (ch === "|" && bracketDepth === 0 && parenDepth === 0) {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out;
}

/**
 * Compute the canonical regex alternative set + the joined union
 * string for a list of inventory rows. The set is order-insensitive
 * and dedupe-aware so two inventory rows that happen to repeat the
 * same hostname pattern only contribute one alternative. The joined
 * union is the value we write into Sentry's `hostname:` filter.
 *
 * Throws when a row has an empty hostname cell — every active
 * opt-out is required to declare an anchored regex (the inventory
 * column docs spell this out), and a sync that silently dropped an
 * empty cell would either page on the deploy (because its hostname
 * isn't in the union) or leave the page rule's `nre` filter blank
 * (which is the "match all" case — every host gets paged).
 */
export function computeInventoryHostnameUnion(rows: InventoryRow[]): {
  alternatives: string[];
  union: string;
} {
  const alternatives: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const cell = stripBackticks(row.hostnamePattern);
    if (cell === "" || cell === "—" || cell === "-") {
      throw new Error(
        `inventory row for deploy '${row.deployName}' has an empty / placeholder hostname cell ('${row.hostnamePattern}') — every active opt-out must declare an anchored regex in the HOSTNAME column`,
      );
    }
    for (const alt of splitOnTopLevelPipe(cell)) {
      const trimmed = alt.trim();
      if (trimmed === "") continue;
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      alternatives.push(trimmed);
    }
  }
  return { alternatives, union: alternatives.join("|") };
}

/** Result of locating a rule's hostname-keyed filter entry. */
export interface HostnameFilterLocation {
  /** Which array we found it in (Sentry stores tag filters under
   *  either `filters` or `conditions`). */
  arrayName: "filters" | "conditions";
  /** Position within that array. */
  index: number;
  /** Current `match` value (e.g. `re`, `nre`). */
  matchMode: string;
  /** Current `value` string (the regex union as Sentry sees it). */
  value: string;
}

/**
 * Find the single hostname-keyed filter entry on a Sentry rule body.
 *
 * Returns `null` when no such entry exists at all — the caller
 * surfaces that as a probe error: a managed rule without a hostname
 * filter is structurally wrong and the syncer can't safely add one
 * (it doesn't know where in the operator-curated rule shape it
 * belongs).
 *
 * Throws when more than one hostname-keyed entry exists or when they
 * disagree on the match mode — both are misconfigurations and a
 * sync that picked one arbitrarily would mask the bug.
 */
export function findHostnameFilter(
  rule: SentryRuleBody,
): HostnameFilterLocation | null {
  if (typeof rule !== "object" || rule === null) {
    throw new Error("Sentry rule body is not an object");
  }
  const matches: HostnameFilterLocation[] = [];
  for (const arrayName of ["filters", "conditions"] as const) {
    const arr = rule[arrayName];
    if (!Array.isArray(arr)) continue;
    for (let i = 0; i < arr.length; i++) {
      const entry = arr[i];
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as { key?: unknown; match?: unknown; value?: unknown };
      const key = typeof e.key === "string" ? e.key : "";
      if (key.toLowerCase() !== "hostname") continue;
      const matchMode = typeof e.match === "string" ? e.match : "";
      const value = typeof e.value === "string" ? e.value : "";
      matches.push({ arrayName, index: i, matchMode, value });
    }
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(
      `Sentry rule has ${matches.length} hostname-keyed filter entries — expected exactly 1; refusing to guess which one to overwrite`,
    );
  }
  return matches[0]!;
}

/**
 * Produce a new rule body with the hostname filter's `value` field
 * replaced by `desiredValue`. Everything else (name, actions,
 * environment, owners, the filter's `id` / `match` / other fields,
 * other entries in the same array) is preserved verbatim.
 *
 * The original rule body is not mutated — callers can compare
 * before/after for logging.
 */
export function withUpdatedHostnameValue(
  rule: SentryRuleBody,
  location: HostnameFilterLocation,
  desiredValue: string,
): SentryRuleBody {
  const cloned: SentryRuleBody = { ...rule };
  const arr = cloned[location.arrayName];
  if (!Array.isArray(arr)) {
    // Defensive: should be unreachable given findHostnameFilter
    // already located the entry, but the type-narrowing is worth it.
    throw new Error(
      `expected ${location.arrayName} to be an array on the cloned rule body`,
    );
  }
  const newArr = arr.slice();
  const oldEntry = newArr[location.index];
  if (typeof oldEntry !== "object" || oldEntry === null) {
    throw new Error(
      `expected ${location.arrayName}[${location.index}] to be an object on the cloned rule body`,
    );
  }
  newArr[location.index] = {
    ...(oldEntry as Record<string, unknown>),
    value: desiredValue,
  };
  cloned[location.arrayName] = newArr;
  return cloned;
}

/** Per-rule decision result for the report. */
export type RuleDecision =
  | {
      outcome: "in_sync";
      observedValue: string;
      desiredValue: string;
    }
  | {
      outcome: "would_update" | "updated";
      observedValue: string;
      desiredValue: string;
    }
  | {
      outcome: "drift";
      observedValue: string;
      desiredValue: string;
      reason: string;
    }
  | {
      outcome: "probe_error";
      reason: string;
    }
  | {
      outcome: "sync_failed";
      observedValue: string;
      desiredValue: string;
      reason: string;
    };

/** Aggregated per-rule report entry. */
export interface RuleReport {
  name: ManagedRuleName;
  ruleId: string;
  expectedMatchMode: "re" | "nre";
  observedMatchMode: string | null;
  decision: RuleDecision;
}

/** Top-level outcome reported to stdout + reflected in the exit code. */
export type SyncOutcome =
  | "in_sync"
  | "synced"
  | "would_sync"
  | "drift"
  | "sync_failed"
  | "probe_error";

export interface SyncReport {
  check: "rate_limit_opt_out_audit_filter_sync";
  outcome: SyncOutcome;
  reason: string;
  inventoryPath: string;
  inventoryAlternatives: string[];
  desiredValue: string;
  mode: "auto-sync" | "check-only" | "dry-run";
  rules: RuleReport[];
}

/**
 * Decide what action to take for a single rule given its observed
 * filter and the desired value. Pure — no IO. Used by the live sync
 * path AND by the dry-run / check-only paths.
 */
export function decideRuleAction(
  observed: HostnameFilterLocation | null,
  expectedMatchMode: "re" | "nre",
  desiredValue: string,
): RuleDecision {
  if (observed === null) {
    return {
      outcome: "probe_error",
      reason:
        "rule body has no hostname-keyed filter entry — refusing to add one (the syncer doesn't know where it belongs in the operator-curated rule shape; add the filter once in the Sentry UI and re-run)",
    };
  }
  if (observed.matchMode !== expectedMatchMode) {
    return {
      outcome: "probe_error",
      reason: `rule's hostname filter match mode is '${observed.matchMode}' but expected '${expectedMatchMode}'. A flipped mode would invert paging vs notifying — fix the rule manually before re-running the syncer.`,
    };
  }
  if (observed.value === desiredValue) {
    return {
      outcome: "in_sync",
      observedValue: observed.value,
      desiredValue,
    };
  }
  return {
    outcome: "would_update",
    observedValue: observed.value,
    desiredValue,
  };
}

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; ok: boolean; text: () => Promise<string> }>;

function ruleUrl(
  baseUrl: string,
  org: string,
  project: string,
  ruleId: string,
): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/0/projects/${encodeURIComponent(
    org,
  )}/${encodeURIComponent(project)}/rules/${encodeURIComponent(ruleId)}/`;
}

/**
 * GET a single Sentry rule body by id. Returns the raw rule object
 * Sentry returned. Throws on non-2xx so the caller can surface it
 * as a probe error.
 */
export async function getRule(
  baseUrl: string,
  org: string,
  project: string,
  ruleId: string,
  authToken: string,
  fetchImpl: FetchLike,
): Promise<SentryRuleBody> {
  const url = ruleUrl(baseUrl, org, project, ruleId);
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
      `failed to fetch Sentry rule id=${ruleId} (HTTP ${res.status}): ${body}`,
    );
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Sentry rule id=${ruleId} response is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(
      `Sentry rule id=${ruleId} response is not an object (got ${typeof parsed})`,
    );
  }
  return parsed as SentryRuleBody;
}

/**
 * PUT a Sentry rule body by id. Returns whether the call succeeded
 * and the HTTP status. Does not throw on 4xx/5xx — the caller
 * decides whether to abort the whole sync or continue with the next
 * rule (today's policy is "report failure but try the other rule").
 */
export async function putRule(
  baseUrl: string,
  org: string,
  project: string,
  ruleId: string,
  authToken: string,
  body: SentryRuleBody,
  fetchImpl: FetchLike,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const url = ruleUrl(baseUrl, org, project, ruleId);
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, error: `fetch failed: ${(err as Error).message}` };
  }
  if (!res.ok) {
    let respBody = "";
    try {
      respBody = await res.text();
    } catch {
      respBody = "<failed to read response body>";
    }
    return {
      ok: false,
      status: res.status,
      error: `HTTP ${res.status}: ${respBody}`,
    };
  }
  return { ok: true, status: res.status };
}

/** Map a top-level outcome to a process exit code. Centralised so
 *  the test suite and the runner stay in sync. */
export function exitCodeFor(outcome: SyncOutcome): 0 | 1 | 2 {
  if (outcome === "in_sync" || outcome === "synced" || outcome === "would_sync")
    return 0;
  if (outcome === "drift" || outcome === "sync_failed") return 2;
  return 1;
}

/**
 * CLI entrypoint. Exported so tests can drive it with mocked
 * dependencies, but the bottom of the file actually invokes it when
 * the module is run directly.
 */
export async function main(
  deps: {
    env?: NodeJS.ProcessEnv;
    readFileImpl?: (file: string) => string;
    fetchImpl?: FetchLike;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
  } = {},
): Promise<0 | 1 | 2> {
  const env = deps.env ?? process.env;
  const readFileImpl =
    deps.readFileImpl ?? ((file: string) => readFileSync(file, "utf8"));
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as FetchLike);
  const stdout =
    deps.stdout ?? ((line: string) => process.stdout.write(line + "\n"));
  const stderr =
    deps.stderr ?? ((line: string) => process.stderr.write(line + "\n"));

  const checkOnly = env.CHECK_ONLY === "1";
  const dryRun = env.DRY_RUN === "1";
  if (checkOnly && dryRun) {
    stderr(
      JSON.stringify({
        check: "rate_limit_opt_out_audit_filter_sync",
        outcome: "probe_error",
        error:
          "CHECK_ONLY=1 and DRY_RUN=1 are mutually exclusive — pick one (CHECK_ONLY exits 2 on drift, DRY_RUN exits 0 after logging the intended PUT)",
      }),
    );
    return 1;
  }
  const mode: SyncReport["mode"] = checkOnly
    ? "check-only"
    : dryRun
      ? "dry-run"
      : "auto-sync";

  const baseUrl = env.SENTRY_BASE_URL ?? "https://sentry.io";
  const org = env.SENTRY_ORG;
  const project = env.SENTRY_PROJECT;
  const auditRuleId = env.RATE_LIMIT_OPT_OUT_AUDIT_RULE_ID;
  const pageRuleId = env.RATE_LIMIT_OPT_OUT_PAGE_RULE_ID;
  const authToken = env.SENTRY_AUTH_TOKEN;
  const inventoryPath = env.INVENTORY_PATH || DEFAULT_INVENTORY_PATH;
  const emptyPlaceholder =
    env.EMPTY_INVENTORY_PLACEHOLDER && env.EMPTY_INVENTORY_PLACEHOLDER !== ""
      ? env.EMPTY_INVENTORY_PLACEHOLDER
      : EMPTY_INVENTORY_DEFAULT_VALUE;

  const missing: string[] = [];
  if (!org || org.trim() === "") missing.push("SENTRY_ORG");
  if (!project || project.trim() === "") missing.push("SENTRY_PROJECT");
  if (!auditRuleId || auditRuleId.trim() === "")
    missing.push("RATE_LIMIT_OPT_OUT_AUDIT_RULE_ID");
  if (!pageRuleId || pageRuleId.trim() === "")
    missing.push("RATE_LIMIT_OPT_OUT_PAGE_RULE_ID");
  if (!authToken || authToken.trim() === "") missing.push("SENTRY_AUTH_TOKEN");
  if (missing.length > 0) {
    stderr(
      JSON.stringify({
        check: "rate_limit_opt_out_audit_filter_sync",
        outcome: "probe_error",
        error: `missing required env: ${missing.join(", ")}`,
      }),
    );
    return 1;
  }

  let markdown: string;
  try {
    markdown = readFileImpl(inventoryPath);
  } catch (err) {
    stderr(
      JSON.stringify({
        check: "rate_limit_opt_out_audit_filter_sync",
        outcome: "probe_error",
        inventoryPath,
        error: `failed to read inventory: ${(err as Error).message}`,
      }),
    );
    return 1;
  }

  let rows: InventoryRow[];
  try {
    rows = parseInventoryTable(markdown);
  } catch (err) {
    stderr(
      JSON.stringify({
        check: "rate_limit_opt_out_audit_filter_sync",
        outcome: "probe_error",
        inventoryPath,
        error: `failed to parse inventory table: ${(err as Error).message}`,
      }),
    );
    return 1;
  }

  let alternatives: string[];
  let computedUnion: string;
  try {
    const computed = computeInventoryHostnameUnion(rows);
    alternatives = computed.alternatives;
    computedUnion = computed.union;
  } catch (err) {
    stderr(
      JSON.stringify({
        check: "rate_limit_opt_out_audit_filter_sync",
        outcome: "probe_error",
        inventoryPath,
        error: `failed to compute hostname union: ${(err as Error).message}`,
      }),
    );
    return 1;
  }

  // Empty inventory: no active opt-outs. We still need to keep the
  // Sentry filter populated with *something* so a stale union from a
  // previous active state can't silently rot in the rule. The
  // sentinel regex matches no real host, which is the correct
  // behaviour for both rules:
  //   - audit-notification (`re`): never fires => quiet (no
  //     inventoried hosts to audit).
  //   - page-on-unknown-host (`nre`): fires for any warn-emitting
  //     host (every host is "unknown" because nothing is inventoried),
  //     which is the right outcome — somebody set the opt-out env
  //     var on a deploy that isn't on the inventory.
  const desiredValue = computedUnion === "" ? emptyPlaceholder : computedUnion;
  const inventoryIsEmpty = computedUnion === "";

  const ruleConfigs: { name: ManagedRuleName; id: string }[] = [
    { name: "audit-notification", id: auditRuleId! },
    { name: "page-on-unknown-host", id: pageRuleId! },
  ];

  const reports: RuleReport[] = [];
  for (const cfg of ruleConfigs) {
    const expectedMatchMode = EXPECTED_MATCH_MODES[cfg.name];
    let body: SentryRuleBody;
    try {
      body = await getRule(
        baseUrl,
        org!,
        project!,
        cfg.id,
        authToken!,
        fetchImpl,
      );
    } catch (err) {
      reports.push({
        name: cfg.name,
        ruleId: cfg.id,
        expectedMatchMode,
        observedMatchMode: null,
        decision: {
          outcome: "probe_error",
          reason: (err as Error).message,
        },
      });
      continue;
    }

    let location: HostnameFilterLocation | null;
    try {
      location = findHostnameFilter(body);
    } catch (err) {
      reports.push({
        name: cfg.name,
        ruleId: cfg.id,
        expectedMatchMode,
        observedMatchMode: null,
        decision: {
          outcome: "probe_error",
          reason: (err as Error).message,
        },
      });
      continue;
    }

    const decision = decideRuleAction(
      location,
      expectedMatchMode,
      desiredValue,
    );

    if (
      decision.outcome === "in_sync" ||
      decision.outcome === "probe_error"
    ) {
      reports.push({
        name: cfg.name,
        ruleId: cfg.id,
        expectedMatchMode,
        observedMatchMode: location?.matchMode ?? null,
        decision,
      });
      continue;
    }

    // From here on `decision.outcome === "would_update"` and
    // `location` is non-null (otherwise decideRuleAction would have
    // returned probe_error).
    if (location === null) {
      // Defensive: unreachable.
      reports.push({
        name: cfg.name,
        ruleId: cfg.id,
        expectedMatchMode,
        observedMatchMode: null,
        decision: {
          outcome: "probe_error",
          reason: "internal: would_update with no hostname filter location",
        },
      });
      continue;
    }

    if (mode === "check-only") {
      // Surface drift; don't write.
      reports.push({
        name: cfg.name,
        ruleId: cfg.id,
        expectedMatchMode,
        observedMatchMode: location.matchMode,
        decision: {
          outcome: "drift",
          observedValue: decision.observedValue,
          desiredValue: decision.desiredValue,
          reason: `hostname filter value drifted from the inventory union; re-run without CHECK_ONLY=1 (or update the rule in the Sentry UI to match) to resolve`,
        },
      });
      continue;
    }

    if (mode === "dry-run") {
      const intended = withUpdatedHostnameValue(
        body,
        location,
        desiredValue,
      );
      stdout(
        `[syncSentryOptOutAuditFilter][dry-run] would PUT ${cfg.name} rule id=${cfg.id} (${ruleUrl(baseUrl, org!, project!, cfg.id)})`,
      );
      stdout(
        `  observed hostname value: ${JSON.stringify(decision.observedValue)}`,
      );
      stdout(
        `  desired  hostname value: ${JSON.stringify(decision.desiredValue)}`,
      );
      stdout(`  intended PUT body: ${JSON.stringify(intended)}`);
      reports.push({
        name: cfg.name,
        ruleId: cfg.id,
        expectedMatchMode,
        observedMatchMode: location.matchMode,
        decision: {
          outcome: "would_update",
          observedValue: decision.observedValue,
          desiredValue: decision.desiredValue,
        },
      });
      continue;
    }

    // auto-sync: actually PUT.
    const intended = withUpdatedHostnameValue(body, location, desiredValue);
    stdout(
      `[syncSentryOptOutAuditFilter] PUT ${cfg.name} rule id=${cfg.id} ...`,
    );
    const result = await putRule(
      baseUrl,
      org!,
      project!,
      cfg.id,
      authToken!,
      intended,
      fetchImpl,
    );
    if (!result.ok) {
      stderr(
        `[syncSentryOptOutAuditFilter] FAILED ${cfg.name} (id=${cfg.id}): ${result.error ?? "unknown error"}`,
      );
      reports.push({
        name: cfg.name,
        ruleId: cfg.id,
        expectedMatchMode,
        observedMatchMode: location.matchMode,
        decision: {
          outcome: "sync_failed",
          observedValue: decision.observedValue,
          desiredValue: decision.desiredValue,
          reason: `Sentry rule PUT failed: ${result.error ?? "unknown error"}`,
        },
      });
      continue;
    }
    stdout(
      `[syncSentryOptOutAuditFilter]   OK (HTTP ${result.status}) — hostname value updated`,
    );
    reports.push({
      name: cfg.name,
      ruleId: cfg.id,
      expectedMatchMode,
      observedMatchMode: location.matchMode,
      decision: {
        outcome: "updated",
        observedValue: decision.observedValue,
        desiredValue: decision.desiredValue,
      },
    });
  }

  // Summarise the per-rule outcomes into one top-level outcome.
  // `probe_error` is reserved for misconfiguration / structural
  // issues (no hostname filter, flipped match mode, GET failed,
  // parse failed) — exit 1. `sync_failed` is specifically a PUT
  // that returned non-2xx in auto-sync mode — exit 2, because the
  // rule is still drifting and on-call must intervene.
  const probeErrors = reports.filter(
    (r) => r.decision.outcome === "probe_error",
  );
  const writeFailures = reports.filter(
    (r) => r.decision.outcome === "sync_failed",
  );
  const drifts = reports.filter((r) => r.decision.outcome === "drift");
  const updates = reports.filter((r) => r.decision.outcome === "updated");
  const wouldUpdates = reports.filter(
    (r) => r.decision.outcome === "would_update",
  );

  let outcome: SyncOutcome;
  let reason: string;
  if (probeErrors.length > 0) {
    outcome = "probe_error";
    reason = `probe error on ${probeErrors.length} of ${reports.length} rule(s): ${probeErrors
      .map(
        (r) =>
          `${r.name}: ${(r.decision as { reason: string }).reason}`,
      )
      .join("; ")}`;
  } else if (writeFailures.length > 0) {
    outcome = "sync_failed";
    reason = `auto-sync failed on ${writeFailures.length} of ${reports.length} rule(s): ${writeFailures
      .map(
        (r) =>
          `${r.name}: ${(r.decision as { reason: string }).reason}`,
      )
      .join("; ")}. The rule is still drifting from the inventory — re-run after fixing the cause.`;
  } else if (drifts.length > 0) {
    outcome = "drift";
    reason = `CHECK_ONLY mode detected drift on ${drifts.length} of ${reports.length} rule(s): ${drifts
      .map((r) => r.name)
      .join(", ")}. Run the auto-sync workflow (or update the Sentry rule in the UI) to resolve.`;
  } else if (mode === "dry-run") {
    outcome = "would_sync";
    reason =
      wouldUpdates.length === 0
        ? `dry-run: every rule already matches the inventory (${alternatives.length} regex(es)${inventoryIsEmpty ? "; inventory is empty so the placeholder sentinel is in use" : ""})`
        : `dry-run: would PUT ${wouldUpdates.length} of ${reports.length} rule(s) to match the inventory (${alternatives.length} regex(es)${inventoryIsEmpty ? "; inventory is empty so the placeholder sentinel would be written" : ""})`;
  } else if (updates.length > 0) {
    outcome = "synced";
    reason = `auto-synced ${updates.length} of ${reports.length} rule(s) from the inventory (${alternatives.length} regex(es)${inventoryIsEmpty ? "; inventory is empty so the placeholder sentinel was written" : ""})`;
  } else {
    outcome = "in_sync";
    reason = `every rule already matches the inventory (${alternatives.length} regex(es)${inventoryIsEmpty ? "; inventory is empty so the placeholder sentinel is in use" : ""})`;
  }

  const report: SyncReport = {
    check: "rate_limit_opt_out_audit_filter_sync",
    outcome,
    reason,
    inventoryPath,
    inventoryAlternatives: [...alternatives].sort(),
    desiredValue,
    mode,
    rules: reports,
  };
  stdout(JSON.stringify(report));
  return exitCodeFor(outcome);
}

const isDirectInvocation =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /syncSentryOptOutAuditFilter(\.[mc]?[jt]s)?$/.test(process.argv[1]);

if (isDirectInvocation) {
  void main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(
        `syncSentryOptOutAuditFilter crashed: ${(err as Error).message}\n`,
      );
      process.exit(1);
    },
  );
}
