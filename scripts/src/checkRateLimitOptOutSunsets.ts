/**
 * checkRateLimitOptOutSunsets — scheduled inventory-sweep that pages
 * on-call when any production deploy listed in
 * `docs/runbooks/rate-limit-store-opt-outs.md` has an `Expected sunset`
 * date in the past.
 *
 * Why this exists (task #97):
 * The opt-out inventory at `docs/runbooks/rate-limit-store-opt-outs.md`
 * is the canonical list of production deploys that have set
 * `RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION=1` to bypass the
 * boot-time hard failure documented in `rate-limit-store.md`. Each row
 * carries an "Expected sunset" date by which the opt-out is supposed
 * to be removed (Redis wired or deploy retired). Until this probe
 * shipped, the only enforcement of those sunsets was the honour
 * system — there was nothing in CI or scheduled jobs that re-read the
 * inventory and shouted when a sunset date had slipped into the past.
 *
 * A single missed sunset means a production deploy keeps running on
 * the bypassable per-process bucket indefinitely, which is exactly the
 * regression the inventory exists to prevent. This probe closes the
 * loop: a daily scheduler parses the markdown table, compares each
 * `Expected sunset` against today, and exits non-zero (so the
 * surrounding GitHub Actions workflow forwards the failure to Sentry
 * the same way the other rate-limit probes do) when any row is
 * overdue.
 *
 * Usage (CI cron, ad-hoc verify):
 *
 *   pnpm --filter @workspace/scripts exec tsx \
 *     src/checkRateLimitOptOutSunsets.ts
 *
 * Optional env vars:
 *   INVENTORY_PATH   Override the markdown path. Defaults to
 *                    docs/runbooks/rate-limit-store-opt-outs.md
 *                    relative to the repo root. Useful for tests and
 *                    for hosting the inventory elsewhere in the
 *                    future.
 *   TODAY            ISO-8601 date (YYYY-MM-DD) used as "today" for
 *                    the comparison. Defaults to the current UTC
 *                    date. Exposed so tests can pin the clock and so
 *                    operators can rehearse the page condition by
 *                    pretending it is the future.
 *
 * Exit codes (chosen so an external wrapper can wire alerting on "any
 * non-zero" without distinguishing — but the codes are still distinct
 * for log triage; matches `checkProductionHostnamePattern.ts` and
 * `checkHealthzDegraded.ts`):
 *   0  no overdue rows (or the inventory is the placeholder/empty
 *      state with no real opt-outs configured)
 *   1  probe error (file missing, malformed table, unparseable
 *      `Expected sunset` value, etc.) — does not necessarily mean a
 *      sunset is overdue; the probe itself failed and a human should
 *      look
 *   2  page on-call: at least one row's `Expected sunset` is in the
 *      past
 *
 * The script writes a single JSON line to stdout describing what it
 * observed so the surrounding wrapper (cron log, Sentry event
 * transformer, etc.) can include it in the page body. Errors go to
 * stderr.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * This file lives at scripts/src/checkRateLimitOptOutSunsets.ts. We
 * resolve __dirname-equivalent from import.meta.url because the
 * surrounding package is ESM (`"type": "module"`) and the CommonJS
 * `__dirname` global is not defined in that scope.
 */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Default inventory path, resolved relative to the repo root.
 * Computed from this file's location (scripts/src/) so the script
 * works regardless of the CWD it is invoked from. The tests override
 * this via the `INVENTORY_PATH` env var rather than depending on the
 * resolved default.
 */
export const DEFAULT_INVENTORY_PATH = path.resolve(
  MODULE_DIR,
  "..",
  "..",
  "docs",
  "runbooks",
  "rate-limit-store-opt-outs.md",
);

/** Heading that introduces the active opt-outs table. The parser
 *  finds this exact line and only inspects the first markdown table
 *  that appears after it, so a future addition of unrelated tables
 *  to the document (e.g. a "Historic opt-outs" section) does not
 *  accidentally get scanned. */
export const ACTIVE_OPT_OUTS_HEADING = "## Active opt-outs";

/** Placeholder cell value used in the inventory when there are no
 *  active opt-outs. Skipped by the parser so a healthy "empty" file
 *  is not mistaken for a malformed row. */
const PLACEHOLDER_DEPLOY_NAME = "_(none)_";

/**
 * One row of the parsed inventory table. The column names mirror the
 * markdown table headers in `docs/runbooks/rate-limit-store-opt-outs.md`
 * so a triage operator can match the JSON line back to the file
 * verbatim.
 */
export interface InventoryRow {
  deployName: string;
  hostnamePattern: string;
  owner: string;
  reason: string;
  optedOutSince: string;
  expectedSunset: string;
  notes: string;
}

/**
 * Parse the markdown file's "Active opt-outs" table into structured
 * rows. The placeholder row (deploy name `_(none)_`) is skipped — a
 * file in that state is healthy and should produce zero rows here.
 *
 * Throws when the table is missing entirely or when a row has the
 * wrong number of cells, since either condition means the file shape
 * has drifted from what this probe knows how to inspect and silently
 * passing would mask exactly the regression it exists to catch.
 */
export function parseInventoryTable(markdown: string): InventoryRow[] {
  const lines = markdown.split(/\r?\n/);
  const headingIdx = lines.findIndex(
    (line) => line.trim() === ACTIVE_OPT_OUTS_HEADING,
  );
  if (headingIdx === -1) {
    throw new Error(
      `inventory file is missing the '${ACTIVE_OPT_OUTS_HEADING}' heading — the file shape has drifted and this probe can no longer locate the table`,
    );
  }
  // Walk forward from the heading until we find the first markdown
  // table (a line beginning with '|'). Skip blank lines and any prose
  // between the heading and the table.
  let cursor = headingIdx + 1;
  while (cursor < lines.length && !lines[cursor]!.trimStart().startsWith("|")) {
    cursor++;
  }
  if (cursor >= lines.length) {
    throw new Error(
      `inventory file has the '${ACTIVE_OPT_OUTS_HEADING}' heading but no markdown table follows it`,
    );
  }
  // The first | line is the header row, the second is the separator
  // (---|---|...), and the rest are data rows until the first
  // non-table line (blank or starting with something other than |).
  const headerLine = lines[cursor]!;
  const separatorLine = lines[cursor + 1] ?? "";
  if (!separatorLine.trimStart().startsWith("|")) {
    throw new Error(
      `inventory table is malformed — the line after the header is not a table separator (got '${separatorLine}')`,
    );
  }
  const headerCells = splitMarkdownRow(headerLine);
  const expectedHeaders = [
    "Deploy name",
    "`HOSTNAME` (regex match)",
    "Owner",
    "Reason",
    "Opted-out since",
    "Expected sunset",
    "Notes",
  ];
  if (headerCells.length !== expectedHeaders.length) {
    throw new Error(
      `inventory table header has ${headerCells.length} columns but expected ${expectedHeaders.length} (${expectedHeaders.join(", ")})`,
    );
  }
  for (let i = 0; i < expectedHeaders.length; i++) {
    if (headerCells[i] !== expectedHeaders[i]) {
      throw new Error(
        `inventory table column ${i + 1} is '${headerCells[i]}' but expected '${expectedHeaders[i]}' — schema drift; update this probe in the same change that renames the column`,
      );
    }
  }
  const rows: InventoryRow[] = [];
  for (let i = cursor + 2; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trimStart().startsWith("|")) break;
    const cells = splitMarkdownRow(line);
    if (cells.length !== expectedHeaders.length) {
      throw new Error(
        `inventory table row ${rows.length + 1} has ${cells.length} cells but expected ${expectedHeaders.length}: '${line}'`,
      );
    }
    if (cells[0] === PLACEHOLDER_DEPLOY_NAME) {
      // Healthy "no active opt-outs" state — skip silently.
      continue;
    }
    rows.push({
      deployName: cells[0]!,
      hostnamePattern: cells[1]!,
      owner: cells[2]!,
      reason: cells[3]!,
      optedOutSince: cells[4]!,
      expectedSunset: cells[5]!,
      notes: cells[6]!,
    });
  }
  return rows;
}

/**
 * Split a markdown table row line into its cell values, dropping the
 * leading and trailing pipes and trimming surrounding whitespace.
 * Backslash-escaped pipes (`\|`) are preserved as literal pipes in
 * the cell, since the markdown convention uses them to escape table
 * delimiters inside cell content (e.g. a regex with `|` alternation).
 */
export function splitMarkdownRow(line: string): string[] {
  const trimmed = line.trim();
  // Strip outer pipes only — internal pipes (escaped or not) are
  // handled by the splitter below.
  const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch === "\\" && inner[i + 1] === "|") {
      current += "|";
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

/**
 * Sanitise the `TODAY` env var into an ISO date string. Falls back to
 * the current UTC date when missing or malformed; tests pin the value
 * explicitly so the fallback is exercised only in production.
 *
 * Returns the canonical YYYY-MM-DD form so any downstream comparison
 * is lexicographic-equivalent to chronological for ISO dates.
 */
export function resolveToday(raw: string | undefined, now: Date): string {
  if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    // Validate that the date is real (e.g. reject 2025-02-30) by
    // round-tripping through Date. An invalid date round-trips to NaN.
    const parsed = new Date(`${raw}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime())) {
      const reformatted = parsed.toISOString().slice(0, 10);
      if (reformatted === raw) return raw;
    }
  }
  return now.toISOString().slice(0, 10);
}

export type SunsetCheckOutcome = "ok" | "overdue" | "probe_error";

export interface OverdueRow {
  deployName: string;
  owner: string;
  expectedSunset: string;
  daysOverdue: number;
  hostnamePattern: string;
  reason: string;
  notes: string;
}

export interface SunsetCheckResult {
  outcome: SunsetCheckOutcome;
  /** Human-readable reason — included verbatim in the structured log
   *  line so the on-call page body explains *why* it fired. */
  reason: string;
  /** The ISO date string used as "today" in the comparison. */
  today: string;
  /** The number of active (non-placeholder) rows considered. */
  activeRowCount: number;
  /** Rows with an `Expected sunset` strictly before `today`. Empty
   *  when outcome is `ok`. */
  overdue: OverdueRow[];
}

/**
 * Pure evaluator: decide whether the parsed inventory should page
 * on-call. Separated from the IO layer so tests can pin the date
 * without touching the filesystem.
 *
 * Decision matrix:
 *   any row's `Expected sunset` is not a valid YYYY-MM-DD  -> probe_error
 *   any row's `Expected sunset` < today                    -> overdue (page)
 *   otherwise                                              -> ok
 *
 * Overdue rows are sorted oldest-sunset-first so the page body
 * leads with the longest-overdue deploy. Ties (same sunset date) are
 * sorted by deploy name for stable output.
 */
export function evaluateInventory(
  rows: InventoryRow[],
  today: string,
): SunsetCheckResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    return {
      outcome: "probe_error",
      reason: `today (${today}) is not a valid YYYY-MM-DD string — refusing to evaluate sunsets against an unparseable date`,
      today,
      activeRowCount: rows.length,
      overdue: [],
    };
  }
  const overdue: OverdueRow[] = [];
  for (const row of rows) {
    const sunset = row.expectedSunset;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sunset)) {
      return {
        outcome: "probe_error",
        reason: `row for deploy '${row.deployName}' has an unparseable Expected sunset value '${sunset}' — fix the inventory file or update this probe in the same change`,
        today,
        activeRowCount: rows.length,
        overdue: [],
      };
    }
    // Validate that the date is real. Reject 2025-02-30 and similar
    // calendar-impossible values rather than silently treating them
    // as the next-rolled-over date — the file is wrong, not the date.
    const sunsetDate = new Date(`${sunset}T00:00:00Z`);
    if (
      Number.isNaN(sunsetDate.getTime()) ||
      sunsetDate.toISOString().slice(0, 10) !== sunset
    ) {
      return {
        outcome: "probe_error",
        reason: `row for deploy '${row.deployName}' has Expected sunset '${sunset}' which does not round-trip as a real calendar date`,
        today,
        activeRowCount: rows.length,
        overdue: [],
      };
    }
    if (sunset < today) {
      const todayDate = new Date(`${today}T00:00:00Z`);
      const daysOverdue = Math.floor(
        (todayDate.getTime() - sunsetDate.getTime()) / 86_400_000,
      );
      overdue.push({
        deployName: row.deployName,
        owner: row.owner,
        expectedSunset: row.expectedSunset,
        daysOverdue,
        hostnamePattern: row.hostnamePattern,
        reason: row.reason,
        notes: row.notes,
      });
    }
  }
  if (overdue.length === 0) {
    return {
      outcome: "ok",
      reason:
        rows.length === 0
          ? "no active opt-outs in the inventory — nothing to check"
          : `all ${rows.length} active opt-out(s) have an Expected sunset on or after ${today}`,
      today,
      activeRowCount: rows.length,
      overdue: [],
    };
  }
  overdue.sort((a, b) => {
    if (a.expectedSunset !== b.expectedSunset) {
      return a.expectedSunset < b.expectedSunset ? -1 : 1;
    }
    return a.deployName < b.deployName ? -1 : 1;
  });
  const summary = overdue
    .map(
      (r) =>
        `${r.deployName} (owner: ${r.owner}, sunset: ${r.expectedSunset}, ${r.daysOverdue} day(s) overdue)`,
    )
    .join("; ");
  return {
    outcome: "overdue",
    reason: `${overdue.length} of ${rows.length} active opt-out(s) have an Expected sunset before ${today}: ${summary}. Either remove the opt-out env var on the deploy and delete the row, or extend the row with a fresh sunset and a one-line 'why extended' note (see docs/runbooks/rate-limit-store-opt-outs.md).`,
    today,
    activeRowCount: rows.length,
    overdue,
  };
}

/**
 * Map an evaluation outcome to a process exit code. Centralised so
 * the test suite and the runner stay in sync.
 */
export function exitCodeFor(outcome: SunsetCheckOutcome): 0 | 1 | 2 {
  if (outcome === "overdue") return 2;
  if (outcome === "probe_error") return 1;
  return 0;
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
    now?: () => Date;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
  } = {},
): Promise<0 | 1 | 2> {
  const env = deps.env ?? process.env;
  const readFileImpl =
    deps.readFileImpl ?? ((file: string) => readFileSync(file, "utf8"));
  const now = deps.now ?? (() => new Date());
  const stdout =
    deps.stdout ?? ((line: string) => process.stdout.write(line + "\n"));
  const stderr =
    deps.stderr ?? ((line: string) => process.stderr.write(line + "\n"));

  const inventoryPath = env.INVENTORY_PATH || DEFAULT_INVENTORY_PATH;
  const today = resolveToday(env.TODAY, now());

  let markdown: string;
  try {
    markdown = readFileImpl(inventoryPath);
  } catch (err) {
    stderr(
      JSON.stringify({
        check: "rate_limit_opt_out_sunsets",
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
        check: "rate_limit_opt_out_sunsets",
        outcome: "probe_error",
        inventoryPath,
        error: `failed to parse inventory table: ${(err as Error).message}`,
      }),
    );
    return 1;
  }

  const result = evaluateInventory(rows, today);
  stdout(
    JSON.stringify({
      check: "rate_limit_opt_out_sunsets",
      outcome: result.outcome,
      reason: result.reason,
      today: result.today,
      activeRowCount: result.activeRowCount,
      overdue: result.overdue,
      inventoryPath,
    }),
  );
  return exitCodeFor(result.outcome);
}

const isDirectInvocation =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /checkRateLimitOptOutSunsets(\.[mc]?[jt]s)?$/.test(process.argv[1]);

if (isDirectInvocation) {
  void main().then(
    (code) => {
      process.exit(code);
    },
    (err: unknown) => {
      // Defensive: any unexpected throw exits 1 (probe error) rather
      // than 0, so the cron wrapper still sees a failure.
      process.stderr.write(
        `checkRateLimitOptOutSunsets crashed: ${(err as Error).message}\n`,
      );
      process.exit(1);
    },
  );
}
