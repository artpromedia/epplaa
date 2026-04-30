/**
 * checkRateLimitOptOutInventoryDrift — scheduled rehearsal that
 * asserts the Sentry alert rules wired off the
 * `rate_limit_store_memory_in_production_via_opt_out` warn tag have
 * a `hostname` filter whose regex union matches the inventory file at
 * `docs/runbooks/rate-limit-store-opt-outs.md`.
 *
 * Why this exists (task #98):
 * The Sentry rule wiring documented in
 * `docs/runbooks/rate-limit-store.md` (Wire alerts section) splits
 * the warn-tag traffic into two issue alerts:
 *
 *   1. Audit notification (inventoried hosts) — `hostname:` regex
 *      MATCHES the union of every `HOSTNAME (regex match)` row in
 *      the inventory. Routed as a notification, not a page.
 *   2. Page on unknown host (uninventoried hosts) — `hostname:`
 *      regex does NOT match any inventory row. Routed as a page.
 *
 * The hostname regex union is hand-pasted into the Sentry rule UI in
 * the same change that adds a row to the inventory file. That
 * hand-pasted union is the single point of failure: if a canary
 * deploy gets a new hostname suffix, or somebody updates the
 * inventory but forgets the Sentry rule, on-call gets paged for a
 * deploy that was actually sanctioned.
 *
 * This probe reads the inventory file and a JSON descriptor of the
 * two Sentry rules' hostname filters (fetched by the surrounding
 * workflow via Sentry's rule API) and asserts the regex set in each
 * rule matches the inventory. A drift fails the probe loudly long
 * before a real opt-out warn fires, and the surrounding rehearsal
 * workflow forwards the failure to Sentry so the rate-limit owners
 * are notified.
 *
 * Usage (CI cron, ad-hoc verify):
 *
 *   INVENTORY_PATH=docs/runbooks/rate-limit-store-opt-outs.md \
 *   SENTRY_RULES_PATH=/tmp/sentry-rate-limit-rules.json \
 *     pnpm --filter @workspace/api-server exec tsx \
 *       src/scripts/checkRateLimitOptOutInventoryDrift.ts
 *
 * Exit codes (mirror checkHealthzDegraded.ts / checkProductionHostnamePattern.ts):
 *   0  in_sync — inventory regex union matches every Sentry rule's
 *      hostname filter
 *   1  probe error (missing files, malformed inventory table or
 *      Sentry rule JSON, bad shape) — the probe itself failed and a
 *      human should look
 *   2  page on-call: drift detected between the inventory file and at
 *      least one Sentry rule's hostname filter
 *
 * The script writes a single JSON line to stdout describing what it
 * observed so the surrounding wrapper (cron log, Sentry event
 * transformer, etc.) can include it in the page body. Errors go to
 * stderr.
 */
import { readFileSync } from "node:fs";

/** Output JSON shape for stdout/stderr. Kept narrow so the
 *  surrounding wrapper (Sentry event transformer, GitHub step
 *  summary) can include the whole line verbatim in the page body. */
export interface DriftReport {
  check: "rate_limit_opt_out_inventory_drift";
  outcome: DriftOutcome;
  reason: string;
  inventoryPath: string;
  inventoryRegexes: string[];
  rules: RuleComparison[];
}

export type DriftOutcome = "in_sync" | "drift" | "probe_error";

export interface RuleComparison {
  name: string;
  expectedMatchMode: ExpectedMatchMode;
  observedMatchMode: string | null;
  observedRegexes: string[];
  /** Regexes in the inventory but not in this rule's hostname filter. */
  missingFromRule: string[];
  /** Regexes in this rule's hostname filter but not in the inventory. */
  extraInRule: string[];
  matchModeMismatch: boolean;
  inSync: boolean;
}

/** "re" = positive regex match (audit notification rule).
 *  "nre" = negated regex match (page on unknown host rule). */
export type ExpectedMatchMode = "re" | "nre";

/**
 * Pure parser: extract the `HOSTNAME (regex match)` column from the
 * `## Active opt-outs` markdown table.
 *
 * Skips:
 *   - The header row and `| --- | --- | …` separator row.
 *   - The placeholder row used when no deploys are opted out (the
 *     "Deploy name" cell is `_(none)_` or the hostname cell is the
 *     single em-dash `—` / a hyphen `-`).
 *
 * Returns the canonical regex *alternatives* — i.e. each row's
 * hostname pattern is split on top-level `|` so a row that already
 * unions multiple hostnames for the same deploy contributes each
 * alternative to the inventory set. This matches how the union is
 * encoded into Sentry (one big alternation joined by `|`), so a
 * set-equality comparison against Sentry's split regex is meaningful.
 *
 * Top-level `|` means: not inside `[...]` or `(...)`. Hostname regexes
 * in this inventory are simple anchored patterns and the docs only
 * sanction `|` as an alternation between sibling hostnames — so this
 * is the right granularity to compare on.
 */
export function parseInventoryHostnames(markdown: string): {
  regexes: string[];
  rowCount: number;
} {
  // Locate the `## Active opt-outs` section. The table immediately
  // following its heading is the source of truth.
  const sectionMatch = markdown.match(/^##\s+Active opt-outs\s*$/m);
  if (!sectionMatch || sectionMatch.index === undefined) {
    throw new Error(
      "inventory file is missing the `## Active opt-outs` section heading",
    );
  }
  const after = markdown.slice(sectionMatch.index + sectionMatch[0].length);
  // Stop at the next `## ` heading (e.g. `### Column definitions`
  // is a sibling that lives below the table; we don't want to walk
  // into it).
  const stopAt = after.search(/^##\s+/m);
  const sectionBody = stopAt === -1 ? after : after.slice(0, stopAt);

  const lines = sectionBody.split("\n");
  // Strict markdown table detection: a header row (starts with `|`),
  // followed by a separator row (`| --- | --- …`), followed by N
  // data rows (each starts with `|`).
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (!line.startsWith("|")) continue;
    const next = (lines[i + 1] ?? "").trim();
    // The separator row has only `-`, `:`, `|`, and whitespace.
    if (next.startsWith("|") && /^[|\-:\s]+$/.test(next) && /-{3,}/.test(next)) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    throw new Error(
      "inventory file's `## Active opt-outs` section has no markdown table (header + `| --- |` separator row not found)",
    );
  }

  // Confirm column ordering: the second column is the hostname regex.
  const headerCells = splitTableRow(lines[headerIdx] ?? "");
  if (headerCells.length < 2) {
    throw new Error(
      "inventory table header has fewer than 2 columns — expected `Deploy name | HOSTNAME (regex match) | …`",
    );
  }
  const hostnameHeader = headerCells[1] ?? "";
  if (!/HOSTNAME/i.test(hostnameHeader) || !/regex/i.test(hostnameHeader)) {
    throw new Error(
      `inventory table's 2nd column header is "${hostnameHeader}" — expected something containing "HOSTNAME" and "regex" (e.g. "HOSTNAME (regex match)"). The script keys off column position so a re-ordering would silently change which column it reads.`,
    );
  }

  const regexes: string[] = [];
  let rowCount = 0;
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) {
      // First non-table line ends the data rows.
      if (trimmed === "") continue;
      break;
    }
    const cells = splitTableRow(line);
    if (cells.length < 2) continue;
    const deployName = (cells[0] ?? "").trim();
    const hostname = (cells[1] ?? "").trim();
    rowCount += 1;

    // Skip the documented placeholder row used when there are no
    // active opt-outs. Two heuristics so a small future tweak to the
    // placeholder text doesn't accidentally get ingested as a real
    // entry:
    //   - Deploy name cell wrapped in `_..._` italics OR literally
    //     `_(none)_`.
    //   - Hostname cell is just an em-dash (`—`) or a hyphen (`-`).
    const isPlaceholderDeploy =
      deployName === "_(none)_" ||
      /^_.*_$/.test(deployName) ||
      deployName === "" ||
      deployName === "—" ||
      deployName === "-";
    const isPlaceholderHost =
      hostname === "—" || hostname === "-" || hostname === "";
    if (isPlaceholderDeploy && isPlaceholderHost) {
      // Pure placeholder — don't count it in the active set.
      rowCount -= 1;
      continue;
    }
    if (isPlaceholderHost) {
      throw new Error(
        `inventory row for deploy "${deployName}" has an empty / placeholder hostname cell ("${hostname}") — every active opt-out must declare an anchored regex in the HOSTNAME column`,
      );
    }

    // Strip surrounding backticks if the regex was wrapped for
    // readability (`^api-canary-[a-z0-9]+$`). Inventory authors are
    // free to backtick or not; the canonical compared form is the
    // raw regex.
    const stripped = stripBackticks(hostname);
    for (const alt of splitOnTopLevelPipe(stripped)) {
      const trimmedAlt = alt.trim();
      if (trimmedAlt === "") continue;
      regexes.push(trimmedAlt);
    }
  }

  return { regexes, rowCount };
}

function splitTableRow(line: string): string[] {
  // Markdown table rows look like `| a | b | c |`. Trim the leading
  // and trailing pipes before splitting so the first/last element
  // isn't an empty-string artefact. Respect the markdown convention
  // that `\|` inside a cell is an escaped pipe (NOT a column
  // separator) — this matters for the hostname column where a row
  // that unions multiple hostnames-for-one-deploy with `|` (per the
  // inventory column docs) has to escape the pipes to keep the row
  // a valid markdown table.
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  const cells: string[] = [];
  let buf = "";
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "\\" && trimmed[i + 1] === "|") {
      // Unescape and append the literal pipe so the cell content
      // matches what the author intended.
      buf += "|";
      i += 1;
      continue;
    }
    if (ch === "|") {
      cells.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  cells.push(buf);
  return cells;
}

function stripBackticks(s: string): string {
  const t = s.trim();
  if (t.startsWith("`") && t.endsWith("`") && t.length >= 2) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Split a regex string on TOP-LEVEL `|` — i.e. `|` characters that
 * are not inside a `[...]` character class or a `(...)` group, and
 * are not escaped with `\`. Hostname regexes in this inventory are
 * simple anchored patterns so this lightweight scanner is enough.
 *
 * Canonical version lives in scripts/src/checkRateLimitOptOutSunsets.ts (task #222). Any changes here must be mirrored there.
 */
export function splitOnTopLevelPipe(regex: string): string[] {
  const out: string[] = [];
  let buf = "";
  let bracketDepth = 0;
  let parenDepth = 0;
  for (let i = 0; i < regex.length; i++) {
    const ch = regex[i];
    if (ch === "\\" && i + 1 < regex.length) {
      // Escaped character — copy verbatim, don't interpret next.
      buf += ch + regex[i + 1];
      i += 1;
      continue;
    }
    if (ch === "[") bracketDepth += 1;
    else if (ch === "]" && bracketDepth > 0) bracketDepth -= 1;
    else if (ch === "(" && bracketDepth === 0) parenDepth += 1;
    else if (ch === ")" && bracketDepth === 0 && parenDepth > 0) parenDepth -= 1;
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

/** Shape of a single Sentry rule descriptor passed to this script.
 *  The surrounding workflow extracts this from Sentry's rule API
 *  response (the issue alert rule body) and feeds it in via the
 *  rules JSON file — see the workflow file for the extraction. */
export interface SentryRuleDescriptor {
  /** Human-friendly label included in the drift report (e.g.
   *  "audit-notification" or "page-on-unknown-host"). */
  name: string;
  /** What match mode this rule should be using (positive vs negated
   *  regex). Asserted against what we observe in the rule body so a
   *  rule that flipped from `re` to `nre` (and would now page on the
   *  wrong set of hosts) is caught. */
  expectedMatchMode: ExpectedMatchMode;
  /** The Sentry rule body — the raw `conditions` / `filters` arrays
   *  as returned by Sentry's rule API. */
  rule: SentryRuleBody;
}

export interface SentryRuleBody {
  conditions?: unknown;
  filters?: unknown;
  [k: string]: unknown;
}

export interface SentryRulesFile {
  rules: SentryRuleDescriptor[];
}

interface SentryHostnameFilter {
  matchMode: string | null;
  /** The raw regex string from the rule's `value` field. */
  raw: string;
  /** The regex split on top-level `|` for set-equality comparison. */
  alternatives: string[];
}

/**
 * Extract the hostname filter from a Sentry rule body.
 *
 * The rule's `conditions` and `filters` arrays both can contain
 * `TaggedEventFilter`-shaped entries (`key`, `match`, `value`). We
 * union both arrays and pick every entry whose `key` is `hostname`
 * (case-insensitive). All such entries' `value` strings are
 * concatenated with `|` to form the observed regex union.
 *
 * Returns `null` when no hostname filter is found at all — the
 * comparator treats that as "observed empty set", which is in-sync
 * iff the inventory is also empty.
 *
 * Throws when the rule body is the wrong shape entirely (not an
 * object). A malformed rule is a probe error, not a drift event.
 */
export function extractSentryHostnameFilter(
  rule: SentryRuleBody,
): SentryHostnameFilter | null {
  if (typeof rule !== "object" || rule === null) {
    throw new Error("Sentry rule body is not an object");
  }
  const candidates: unknown[] = [];
  for (const arrName of ["conditions", "filters"] as const) {
    const arr = rule[arrName];
    if (Array.isArray(arr)) candidates.push(...arr);
  }
  const matched: { matchMode: string; value: string }[] = [];
  for (const entry of candidates) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as { key?: unknown; match?: unknown; value?: unknown };
    const key = typeof e.key === "string" ? e.key : "";
    if (key.toLowerCase() !== "hostname") continue;
    const matchMode = typeof e.match === "string" ? e.match : "";
    const value = typeof e.value === "string" ? e.value : "";
    matched.push({ matchMode, value });
  }
  if (matched.length === 0) return null;

  // If multiple hostname-keyed entries appear, they all must use the
  // same match mode — mixing `re` and `nre` on the same key would be
  // a misconfiguration and the comparator can't pick a sensible
  // expected mode for it.
  const modes = new Set(matched.map((m) => m.matchMode));
  if (modes.size > 1) {
    throw new Error(
      `Sentry rule has multiple hostname-keyed entries with conflicting match modes: ${[
        ...modes,
      ].join(", ")} — fix the rule before running this probe`,
    );
  }
  const matchMode = matched[0]?.matchMode ?? null;
  const raw = matched.map((m) => m.value).join("|");
  const alternatives = splitOnTopLevelPipe(raw)
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return { matchMode, raw, alternatives };
}

/**
 * Compare an inventory regex set against a single Sentry rule's
 * hostname filter. Returns the per-rule slice of the drift report.
 *
 * In-sync iff:
 *   - The set of regex alternatives in Sentry equals the set in the
 *     inventory (order-insensitive, dedupe-aware), AND
 *   - The match mode observed equals the expected mode.
 *
 * Empty-inventory case:
 *   - Inventory is empty (no active opt-outs). Sentry's rule should
 *     either not have a hostname filter at all, OR have one whose
 *     alternatives set is empty. Anything else is "extra in Sentry"
 *     and treated as drift (a stale Sentry filter for a deploy that
 *     was removed from the inventory).
 *   - The match mode check is skipped when there's no hostname
 *     filter at all (there's nothing to mismatch).
 */
export function compareRuleAgainstInventory(
  inventoryRegexes: string[],
  descriptor: SentryRuleDescriptor,
): RuleComparison {
  const inventorySet = new Set(inventoryRegexes);
  const filter = extractSentryHostnameFilter(descriptor.rule);

  if (filter === null) {
    const inSync = inventorySet.size === 0;
    return {
      name: descriptor.name,
      expectedMatchMode: descriptor.expectedMatchMode,
      observedMatchMode: null,
      observedRegexes: [],
      missingFromRule: [...inventorySet].sort(),
      extraInRule: [],
      matchModeMismatch: false,
      inSync,
    };
  }

  const observedSet = new Set(filter.alternatives);
  const missingFromRule: string[] = [];
  for (const r of inventorySet) {
    if (!observedSet.has(r)) missingFromRule.push(r);
  }
  const extraInRule: string[] = [];
  for (const r of observedSet) {
    if (!inventorySet.has(r)) extraInRule.push(r);
  }
  const matchModeMismatch =
    filter.matchMode !== null && filter.matchMode !== descriptor.expectedMatchMode;
  const inSync =
    missingFromRule.length === 0 &&
    extraInRule.length === 0 &&
    !matchModeMismatch;

  return {
    name: descriptor.name,
    expectedMatchMode: descriptor.expectedMatchMode,
    observedMatchMode: filter.matchMode,
    observedRegexes: [...observedSet].sort(),
    missingFromRule: missingFromRule.sort(),
    extraInRule: extraInRule.sort(),
    matchModeMismatch,
    inSync,
  };
}

/** Aggregate per-rule comparisons into the overall drift outcome. */
export function summariseComparisons(
  inventoryPath: string,
  inventoryRegexes: string[],
  comparisons: RuleComparison[],
): DriftReport {
  const allInSync = comparisons.every((c) => c.inSync);
  if (allInSync) {
    return {
      check: "rate_limit_opt_out_inventory_drift",
      outcome: "in_sync",
      reason:
        comparisons.length === 0
          ? "no Sentry rules supplied — nothing to compare against the inventory"
          : `inventory (${inventoryRegexes.length} regex(es)) matches every Sentry rule's hostname filter`,
      inventoryPath,
      inventoryRegexes: [...inventoryRegexes].sort(),
      rules: comparisons,
    };
  }
  const offenders = comparisons.filter((c) => !c.inSync).map((c) => c.name);
  return {
    check: "rate_limit_opt_out_inventory_drift",
    outcome: "drift",
    reason: `Sentry rule(s) [${offenders.join(", ")}] have a hostname filter that does not match the inventory at ${inventoryPath}. Either re-paste the union into the Sentry rule UI to match the inventory, or update the inventory to reflect the deploys that are actually opted out. See docs/runbooks/rate-limit-store-opt-outs.md.`,
    inventoryPath,
    inventoryRegexes: [...inventoryRegexes].sort(),
    rules: comparisons,
  };
}

export function exitCodeFor(outcome: DriftOutcome): 0 | 1 | 2 {
  if (outcome === "drift") return 2;
  if (outcome === "probe_error") return 1;
  return 0;
}

const DEFAULT_INVENTORY_PATH = "docs/runbooks/rate-limit-store-opt-outs.md";

/** Validate a parsed Sentry rules JSON file and return its descriptor
 *  list. Throws on shape errors so the caller can surface them as a
 *  probe error rather than silently treating a malformed file as
 *  "no rules to compare". */
export function parseSentryRulesFile(parsed: unknown): SentryRuleDescriptor[] {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Sentry rules file is not a JSON object");
  }
  const rules = (parsed as { rules?: unknown }).rules;
  if (!Array.isArray(rules)) {
    throw new Error(
      "Sentry rules file has no top-level `rules` array — expected `{ \"rules\": [{ name, expectedMatchMode, rule }, …] }`",
    );
  }
  const out: SentryRuleDescriptor[] = [];
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (typeof r !== "object" || r === null) {
      throw new Error(`rules[${i}] is not an object`);
    }
    const rec = r as Record<string, unknown>;
    const name = rec.name;
    const expectedMatchMode = rec.expectedMatchMode;
    const rule = rec.rule;
    if (typeof name !== "string" || name === "") {
      throw new Error(`rules[${i}].name must be a non-empty string`);
    }
    if (expectedMatchMode !== "re" && expectedMatchMode !== "nre") {
      throw new Error(
        `rules[${i}].expectedMatchMode must be "re" or "nre", got ${JSON.stringify(expectedMatchMode)}`,
      );
    }
    if (typeof rule !== "object" || rule === null) {
      throw new Error(`rules[${i}].rule must be an object`);
    }
    out.push({
      name,
      expectedMatchMode,
      rule: rule as SentryRuleBody,
    });
  }
  return out;
}

/**
 * CLI entrypoint. Exported so tests can drive it with mocked
 * dependencies, but the bottom of the file actually invokes it when
 * the module is run directly.
 */
export async function main(
  deps: {
    env?: NodeJS.ProcessEnv;
    readFile?: (path: string) => string;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
  } = {},
): Promise<0 | 1 | 2> {
  const env = deps.env ?? process.env;
  const readFile =
    deps.readFile ?? ((p: string) => readFileSync(p, { encoding: "utf8" }));
  const stdout =
    deps.stdout ?? ((line: string) => process.stdout.write(line + "\n"));
  const stderr =
    deps.stderr ?? ((line: string) => process.stderr.write(line + "\n"));

  const inventoryPath =
    env.INVENTORY_PATH && env.INVENTORY_PATH.trim() !== ""
      ? env.INVENTORY_PATH
      : DEFAULT_INVENTORY_PATH;
  const sentryRulesPath = env.SENTRY_RULES_PATH;
  if (!sentryRulesPath || sentryRulesPath.trim() === "") {
    stderr(
      JSON.stringify({
        check: "rate_limit_opt_out_inventory_drift",
        outcome: "probe_error",
        error:
          "SENTRY_RULES_PATH is required (path to a JSON file describing the Sentry rules to compare against the inventory)",
      }),
    );
    return 1;
  }

  let inventoryMarkdown: string;
  try {
    inventoryMarkdown = readFile(inventoryPath);
  } catch (err) {
    stderr(
      JSON.stringify({
        check: "rate_limit_opt_out_inventory_drift",
        outcome: "probe_error",
        inventoryPath,
        error: `failed to read inventory file: ${(err as Error).message}`,
      }),
    );
    return 1;
  }

  let inventoryRegexes: string[];
  try {
    inventoryRegexes = parseInventoryHostnames(inventoryMarkdown).regexes;
  } catch (err) {
    stderr(
      JSON.stringify({
        check: "rate_limit_opt_out_inventory_drift",
        outcome: "probe_error",
        inventoryPath,
        error: `failed to parse inventory: ${(err as Error).message}`,
      }),
    );
    return 1;
  }

  let rulesRaw: string;
  try {
    rulesRaw = readFile(sentryRulesPath);
  } catch (err) {
    stderr(
      JSON.stringify({
        check: "rate_limit_opt_out_inventory_drift",
        outcome: "probe_error",
        sentryRulesPath,
        error: `failed to read Sentry rules file: ${(err as Error).message}`,
      }),
    );
    return 1;
  }

  let descriptors: SentryRuleDescriptor[];
  try {
    descriptors = parseSentryRulesFile(JSON.parse(rulesRaw));
  } catch (err) {
    stderr(
      JSON.stringify({
        check: "rate_limit_opt_out_inventory_drift",
        outcome: "probe_error",
        sentryRulesPath,
        error: `failed to parse Sentry rules file: ${(err as Error).message}`,
      }),
    );
    return 1;
  }

  let comparisons: RuleComparison[];
  try {
    comparisons = descriptors.map((d) =>
      compareRuleAgainstInventory(inventoryRegexes, d),
    );
  } catch (err) {
    stderr(
      JSON.stringify({
        check: "rate_limit_opt_out_inventory_drift",
        outcome: "probe_error",
        error: `failed to compare rules against inventory: ${(err as Error).message}`,
      }),
    );
    return 1;
  }

  const report = summariseComparisons(
    inventoryPath,
    inventoryRegexes,
    comparisons,
  );
  stdout(JSON.stringify(report));
  return exitCodeFor(report.outcome);
}

const isDirectInvocation =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /checkRateLimitOptOutInventoryDrift(\.[mc]?[jt]s)?$/.test(process.argv[1]);

if (isDirectInvocation) {
  void main().then(
    (code) => {
      process.exit(code);
    },
    (err: unknown) => {
      process.stderr.write(
        `checkRateLimitOptOutInventoryDrift crashed: ${(err as Error).message}\n`,
      );
      process.exit(1);
    },
  );
}
