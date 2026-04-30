/**
 * checkRateLimitOptOutPrInventory — PR-time CI gate that fails any
 * pull request which adds or modifies a deploy config to set
 * `RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION="1"` in its production
 * env without also editing the opt-out inventory at
 * `docs/runbooks/rate-limit-store-opt-outs.md` in the same PR.
 *
 * Why this exists (task #116):
 * Until this probe shipped, the only thing that caught the failure
 * mode "operator set the opt-out env var on a deploy but forgot to
 * add a row to the inventory" was the runtime page-on-unknown-host
 * Sentry rule wired in task #93 — i.e. the deploy ships, the warn
 * fires from the new host, the page-on-unknown-host rule matches
 * (because the inventory is missing the row), and on-call gets paged
 * for what is in fact a sanctioned deploy whose author just forgot
 * to do the paperwork. The weekly drift rehearsal added in task #98
 * catches the *inverse* case (inventory edited but Sentry rule's
 * hand-pasted regex union not refreshed) but it does NOT catch the
 * "env var changed in deploy config without a corresponding inventory
 * row" case at PR review time.
 *
 * This check shifts that failure from a runtime page to a CI failure
 * the author can fix before merging. It is the same shape as the
 * existing PR-time `check-sentry-monitors` gate in `.github/workflows/ci.yml`
 * (also a PR-blocking config-drift detector), but lives in its own
 * workflow file so it can be gated by a single repo variable kill
 * switch (`vars.RATE_LIMIT_OPT_OUT_PR_CHECK_ENABLED`) without
 * disabling unrelated CI steps.
 *
 * Trigger condition (per the task):
 *   The check fails iff a deploy config file in the PR's HEAD has
 *   `RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION = "1"` set inside a
 *   `[services.production.*.env]` table AND the same env var was
 *   NOT already set to "1" at the BASE_REF (i.e. the PR is
 *   newly-opting-in or flipping the value to "1") AND the inventory
 *   file is NOT in the PR's changed-files list.
 *
 * Pass-through cases (intentionally not flagged):
 *   - PR removes the env var, or sets it to anything other than "1"
 *     (e.g. "0", unset). Sets `isOptedOutAtHead=false`, no inventory
 *     edit required by this gate. The drift rehearsal will catch a
 *     stale inventory row left behind in a separate channel.
 *   - PR touches a deploy config but the env var was already "1" at
 *     BASE and is still "1" at HEAD (i.e. some other env changed in
 *     the same file). Opt-out status didn't change, no new inventory
 *     row is required.
 *   - PR removes the env var AND removes the inventory row in the
 *     same change. The inventory file IS touched, so this gate
 *     trivially passes — the runbook documents this as the canonical
 *     "graduating off opt-out" workflow.
 *
 * Usage (CI; ad-hoc verify):
 *
 *   BASE_REF=origin/main \
 *   HEAD_REF=HEAD \
 *     pnpm --filter @workspace/scripts run check-rate-limit-opt-out-pr-inventory
 *
 * Required env vars:
 *   BASE_REF  Git ref to compare against (e.g. `origin/main` or the
 *             PR base SHA). REQUIRED — without it the script can't
 *             tell which deploy configs were touched in the PR.
 *
 * Optional env vars:
 *   HEAD_REF             Git ref of the PR head. Defaults to `HEAD`.
 *   INVENTORY_PATH       Path to the inventory markdown, relative to
 *                        the repo root. Defaults to
 *                        `docs/runbooks/rate-limit-store-opt-outs.md`.
 *   DEPLOY_CONFIG_PATHS  Newline-separated list of deploy config file
 *                        paths to scan. When empty, the default is
 *                        every `artifacts/*\/.replit-artifact/artifact.toml`
 *                        in the changed-files list. Useful for tests
 *                        and for a future move of the deploy config
 *                        layout.
 *
 * Exit codes (mirrors the sibling rate-limit probes):
 *   0  ok — either no deploy config was touched, or every touched
 *      deploy is in a state that doesn't require an inventory edit
 *      (already opted in at BASE, or no longer opted in at HEAD).
 *   1  probe error — git command failed, a touched file couldn't be
 *      read, etc. The probe itself failed and a human should look.
 *   2  fail — at least one touched deploy config newly sets the
 *      opt-out env var to "1" AND the inventory file was NOT edited
 *      in the same PR.
 *
 * The script writes a single JSON line to stdout describing what it
 * observed so the surrounding CI step can include it in the run
 * summary verbatim. Errors go to stderr.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Repo-relative default for the inventory file. Resolved off this
 *  module's location so the script works regardless of the CWD it is
 *  invoked from. */
export const DEFAULT_INVENTORY_PATH = path.posix.join(
  "docs",
  "runbooks",
  "rate-limit-store-opt-outs.md",
);

/** The env var that toggles the opt-out. The runbook is strict: only
 *  the literal `"1"` opts out (matches the in-process check in
 *  `apiRateLimit.ts`). Any other value (`"0"`, `"true"`, `""`, etc.)
 *  is ignored by the boot path and therefore by this gate too. */
export const OPT_OUT_ENV_VAR = "RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION";

/** Deploy-config files matched by default. Replit's per-app
 *  deploy config lives at this path; the `[services.production.*.env]`
 *  tables inside it are what gets exported into the runtime env on a
 *  production deploy.
 *
 *  After the v4.2 repository restructure, deploy configs live under
 *  `apps/*`, `services/*`, and `tools/*`. The two-segment glob
 *  `<root>/<name>/.replit-artifact/artifact.toml` matches all of
 *  them. */
export const DEFAULT_DEPLOY_CONFIG_GLOB =
  "*/*/.replit-artifact/artifact.toml";

export type CheckOutcome = "ok" | "missing_inventory_edit" | "probe_error";

export interface DeployState {
  /** Repo-relative path to the deploy config that was touched. */
  path: string;
  /** True iff the file at HEAD has the opt-out env var set to "1"
   *  inside a `[services.production.*.env]` table. */
  isOptedOutAtHead: boolean;
  /** True iff the file at BASE_REF had the opt-out env var set to
   *  "1". False when the file didn't exist at BASE or didn't contain
   *  the env var. */
  isOptedOutAtBase: boolean;
}

export interface CheckResult {
  check: "rate_limit_opt_out_pr_inventory";
  outcome: CheckOutcome;
  reason: string;
  baseRef: string;
  headRef: string;
  inventoryPath: string;
  inventoryEdited: boolean;
  deploys: DeployState[];
  /** Subset of `deploys` that are flagged as needing an inventory
   *  edit — i.e. opted-out at HEAD but not at BASE. Empty when the
   *  outcome is `ok`. */
  newlyOptedOut: DeployState[];
}

/**
 * Pure scanner: report whether the given TOML deploy-config text has
 * `RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION = "1"` set inside any
 * `[services.production.*.env]` table.
 *
 * Implementation: line-by-line walk. We do not pull in a full TOML
 * parser because:
 *   - The repo doesn't currently depend on one and the surface we
 *     need is very narrow (one env var, one literal value, one
 *     table-shape).
 *   - The Replit artifact.toml format mixes `[[services]]` (an array
 *     of tables) with later `[services.production.run.env]` tables,
 *     which is unusual TOML and a real parser may interpret
 *     differently from how Replit's runtime actually reads it. A
 *     line-based scanner that just tracks the current `[...]` table
 *     heading mirrors how an operator reads the file and is unaffected
 *     by this quirk.
 *
 * Edge cases:
 *   - Comments (`# foo = "1"`) are ignored: the line is stripped of
 *     anything from a top-level `#` to end-of-line before matching.
 *   - The value may be quoted with `"` or `'`. Anything other than
 *     the literal `"1"` / `'1'` is ignored, mirroring the runtime
 *     check's strict matching of literal `"1"`.
 *   - `[[…]]` array-of-tables headers are skipped: they introduce
 *     a different table scope than `[…]` single-bracket headers and
 *     the production env tables in this repo's deploy configs are
 *     always single-bracket.
 *   - Extra whitespace / trailing whitespace on the assignment line
 *     is tolerated.
 */
export function scanDeployConfigForOptOut(text: string): {
  isOptedOut: boolean;
  matchedTable: string | null;
  matchedLine: string | null;
} {
  let currentTable = "";
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = stripTomlComment(rawLine);
    const trimmed = line.trim();
    if (trimmed === "") continue;

    // Single-bracket table header: `[some.table]`. Ignore double-
    // bracket array-of-tables headers (`[[…]]`) — those introduce
    // a different scope and the deploy env tables in this repo are
    // always single-bracket.
    if (
      trimmed.startsWith("[") &&
      !trimmed.startsWith("[[") &&
      trimmed.endsWith("]")
    ) {
      currentTable = trimmed.slice(1, -1).trim();
      continue;
    }
    // A `[[…]]` array-of-tables header resets the scope so we don't
    // accidentally evaluate later assignments under the previous
    // single-bracket header.
    if (trimmed.startsWith("[[") && trimmed.endsWith("]]")) {
      currentTable = trimmed.slice(2, -2).trim();
      continue;
    }

    if (!isProductionEnvTable(currentTable)) continue;

    const assignment = parseOptOutAssignment(trimmed);
    if (assignment === null) continue;
    if (assignment === "1") {
      return {
        isOptedOut: true,
        matchedTable: currentTable,
        matchedLine: trimmed,
      };
    }
  }
  return { isOptedOut: false, matchedTable: null, matchedLine: null };
}

/**
 * True iff `table` is a `[services.production.*.env]`-shaped TOML
 * table. We accept both the canonical `services.production.run.env`
 * and the slightly-broader `services.production.<segment>.env` (e.g.
 * a hypothetical `services.production.env` directly, or
 * `services.production.foo.env`) so a future deploy-config layout
 * tweak that introduces a new sub-table doesn't silently bypass the
 * gate. The repo variable kill switch in the surrounding workflow is
 * the documented escape hatch if the layout changes incompatibly.
 */
export function isProductionEnvTable(table: string): boolean {
  if (table === "") return false;
  const parts = table.split(".").map((p) => p.trim());
  if (parts.length < 3) return false;
  if (parts[0] !== "services") return false;
  if (parts[1] !== "production") return false;
  if (parts[parts.length - 1] !== "env") return false;
  return true;
}

/**
 * Parse a single TOML assignment line. Returns:
 *   - The string value if the line is `RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION = "<value>"`
 *     (or `'<value>'`, single-quoted).
 *   - null if the line is anything else (including the env var
 *     assigned to a non-string value like `1` without quotes — that
 *     would be a TOML number, which the runtime's strict-string check
 *     wouldn't recognise as the opt-out anyway).
 */
function parseOptOutAssignment(line: string): string | null {
  // Match `KEY = "value"` (double-quoted) or `KEY = 'value'`
  // (single-quoted, TOML literal string). Tolerate any amount of
  // whitespace around `=`.
  const re = new RegExp(
    `^${OPT_OUT_ENV_VAR}\\s*=\\s*(?:"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"|'([^']*)')\\s*$`,
  );
  const m = re.exec(line);
  if (!m) return null;
  // m[1] for double-quoted (allowing escapes), m[2] for single-quoted
  // (literal strings — no escape processing per TOML spec).
  return m[1] ?? m[2] ?? null;
}

/** Strip everything from the first un-quoted `#` to end-of-line. */
function stripTomlComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && inDouble && i + 1 < line.length) {
      i++;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === "#" && !inSingle && !inDouble) {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * Pure decision: turn the per-deploy state plus the inventory-edit
 * boolean into the overall check outcome. Centralised so the test
 * suite can pin the inputs without going through the IO layer.
 */
export function decideOutcome(input: {
  baseRef: string;
  headRef: string;
  inventoryPath: string;
  inventoryEdited: boolean;
  deploys: DeployState[];
}): CheckResult {
  const { baseRef, headRef, inventoryPath, inventoryEdited, deploys } = input;
  const newlyOptedOut = deploys.filter(
    (d) => d.isOptedOutAtHead && !d.isOptedOutAtBase,
  );
  if (newlyOptedOut.length === 0) {
    return {
      check: "rate_limit_opt_out_pr_inventory",
      outcome: "ok",
      reason:
        deploys.length === 0
          ? "no deploy config files were changed in this PR — nothing to compare against the inventory"
          : `no deploy in this PR newly sets ${OPT_OUT_ENV_VAR}="1" (touched ${deploys.length} deploy config(s); inventory edited=${inventoryEdited})`,
      baseRef,
      headRef,
      inventoryPath,
      inventoryEdited,
      deploys,
      newlyOptedOut: [],
    };
  }
  if (inventoryEdited) {
    return {
      check: "rate_limit_opt_out_pr_inventory",
      outcome: "ok",
      reason: `${newlyOptedOut.length} deploy(s) newly set ${OPT_OUT_ENV_VAR}="1" and the inventory was edited in the same PR — paired change confirmed (deploys: ${newlyOptedOut.map((d) => d.path).join(", ")})`,
      baseRef,
      headRef,
      inventoryPath,
      inventoryEdited,
      deploys,
      newlyOptedOut,
    };
  }
  const list = newlyOptedOut.map((d) => d.path).join(", ");
  return {
    check: "rate_limit_opt_out_pr_inventory",
    outcome: "missing_inventory_edit",
    reason: `${newlyOptedOut.length} deploy(s) in this PR newly set ${OPT_OUT_ENV_VAR}="1" without an accompanying edit to ${inventoryPath}: ${list}. Add a row to the inventory in the same PR (deploy name, hostname regex, owner, reason, opted-out since, expected sunset). See ${inventoryPath} "PR-time inventory check" for the silence path if this PR genuinely shouldn't touch the inventory.`,
    baseRef,
    headRef,
    inventoryPath,
    inventoryEdited,
    deploys,
    newlyOptedOut,
  };
}

export function exitCodeFor(outcome: CheckOutcome): 0 | 1 | 2 {
  if (outcome === "missing_inventory_edit") return 2;
  if (outcome === "probe_error") return 1;
  return 0;
}

/** Match a path against `artifacts/*\/.replit-artifact/artifact.toml`-
 *  style globs. We only support the trivial single-`*` segment case
 *  the default uses; that's all the script needs and avoids pulling
 *  in a glob library. Override via `DEPLOY_CONFIG_PATHS` if the
 *  layout changes. */
export function matchesGlob(filePath: string, glob: string): boolean {
  // Normalise to POSIX separators so a Windows-style path doesn't
  // miss the match.
  const norm = filePath.replace(/\\/g, "/");
  // Convert the glob to a regex by escaping everything special and
  // expanding `*` to `[^/]*` (matches any single path segment).
  const re = new RegExp(
    "^" +
      glob
        .replace(/\\/g, "/")
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*") +
      "$",
  );
  return re.test(norm);
}

/** Type of the git-runner injected into `main`. Tests pass a fake to
 *  avoid spawning a child process; the default uses execFileSync. */
export type GitRunner = (args: string[]) => string;

/** Default git runner: shells out to git via execFileSync. */
function defaultGitRunner(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" });
}

/**
 * CLI entrypoint. Exported so tests can drive it with mocked
 * dependencies, but the bottom of the file actually invokes it when
 * the module is run directly.
 */
export async function main(
  deps: {
    env?: NodeJS.ProcessEnv;
    git?: GitRunner;
    readHeadFile?: (file: string) => string;
    headFileExists?: (file: string) => boolean;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
  } = {},
): Promise<0 | 1 | 2> {
  const env = deps.env ?? process.env;
  const git = deps.git ?? defaultGitRunner;
  const readHeadFile =
    deps.readHeadFile ?? ((file: string) => readFileSync(file, "utf8"));
  const headFileExists = deps.headFileExists ?? ((file: string) => existsSync(file));
  const stdout =
    deps.stdout ?? ((line: string) => process.stdout.write(line + "\n"));
  const stderr =
    deps.stderr ?? ((line: string) => process.stderr.write(line + "\n"));

  const baseRef = env.BASE_REF;
  const headRef = env.HEAD_REF || "HEAD";
  const inventoryPath = env.INVENTORY_PATH || DEFAULT_INVENTORY_PATH;

  if (!baseRef || baseRef.trim() === "") {
    stderr(
      JSON.stringify({
        check: "rate_limit_opt_out_pr_inventory",
        outcome: "probe_error",
        error:
          "BASE_REF is required (set to the PR base SHA / `origin/main`). Without it the gate can't compare HEAD to the merge base.",
      }),
    );
    return 1;
  }

  // 1. Resolve the changed-files set in the PR. `git diff --name-only
  //    --diff-filter=ACMRT base...head` lists files that were Added,
  //    Copied, Modified, Renamed or had their Type changed between
  //    the merge base of `base` and `head` and the head — i.e. the
  //    files the PR proposes to change. We exclude `D` (deleted)
  //    because a removed deploy config can't be flagged as
  //    "newly opted-in".
  let changedFiles: string[];
  try {
    const out = git([
      "diff",
      "--name-only",
      "--diff-filter=ACMRT",
      `${baseRef}...${headRef}`,
    ]);
    changedFiles = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s !== "");
  } catch (err) {
    stderr(
      JSON.stringify({
        check: "rate_limit_opt_out_pr_inventory",
        outcome: "probe_error",
        baseRef,
        headRef,
        error: `failed to run \`git diff\` between BASE_REF and HEAD_REF: ${(err as Error).message}`,
      }),
    );
    return 1;
  }

  // 2. Pick out the deploy config files. Either the operator pinned
  //    a specific set via `DEPLOY_CONFIG_PATHS`, or we filter the
  //    changed-files list against the default
  //    `artifacts/*/.replit-artifact/artifact.toml` glob.
  let deployConfigPaths: string[];
  if (env.DEPLOY_CONFIG_PATHS && env.DEPLOY_CONFIG_PATHS.trim() !== "") {
    const pinned = env.DEPLOY_CONFIG_PATHS.split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s !== "");
    deployConfigPaths = changedFiles.filter((f) => pinned.includes(f));
  } else {
    deployConfigPaths = changedFiles.filter((f) =>
      matchesGlob(f, DEFAULT_DEPLOY_CONFIG_GLOB),
    );
  }

  const inventoryEdited = changedFiles.includes(inventoryPath);

  // 3. For each touched deploy config, read both BASE and HEAD
  //    contents and run the scanner on each. A missing file at BASE
  //    (newly added in the PR) is treated as "not opted out at BASE",
  //    which is the right baseline for the "newly opted-in" check.
  const deploys: DeployState[] = [];
  for (const filePath of deployConfigPaths) {
    let headText: string;
    try {
      headText = headFileExists(filePath) ? readHeadFile(filePath) : "";
    } catch (err) {
      stderr(
        JSON.stringify({
          check: "rate_limit_opt_out_pr_inventory",
          outcome: "probe_error",
          baseRef,
          headRef,
          path: filePath,
          error: `failed to read deploy config at HEAD: ${(err as Error).message}`,
        }),
      );
      return 1;
    }

    let baseText: string;
    try {
      baseText = git(["show", `${baseRef}:${filePath}`]);
    } catch {
      // `git show base:path` fails when the file didn't exist at
      // BASE. That's the "newly added" case — treat as empty so the
      // BASE scanner reports `isOptedOutAtBase=false`.
      baseText = "";
    }

    const headScan = scanDeployConfigForOptOut(headText);
    const baseScan = scanDeployConfigForOptOut(baseText);
    deploys.push({
      path: filePath,
      isOptedOutAtHead: headScan.isOptedOut,
      isOptedOutAtBase: baseScan.isOptedOut,
    });
  }

  const result = decideOutcome({
    baseRef,
    headRef,
    inventoryPath,
    inventoryEdited,
    deploys,
  });

  stdout(JSON.stringify(result));
  return exitCodeFor(result.outcome);
}

const isDirectInvocation =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /checkRateLimitOptOutPrInventory(\.[mc]?[jt]s)?$/.test(process.argv[1]);

if (isDirectInvocation) {
  void main().then(
    (code) => {
      process.exit(code);
    },
    (err: unknown) => {
      // Defensive: any unexpected throw exits 1 (probe error) rather
      // than 0, so the surrounding CI step still sees a failure.
      process.stderr.write(
        `checkRateLimitOptOutPrInventory crashed: ${(err as Error).message}\n`,
      );
      process.exit(1);
    },
  );
}
