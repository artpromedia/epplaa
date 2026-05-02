/**
 * Vault secret-coverage CI guard.
 *
 * Asserts every secret-shaped `process.env.<NAME>` reference in the
 * api-monolith source tree is either:
 *   1. declared in infra/helm/api-monolith/values.yaml under
 *      `vault.secrets[*].keys[*]` (i.e. the value will be sourced from
 *      Vault via ExternalSecrets in production), OR
 *   2. on the explicit allowlist in vaultSecretCoverage.config.ts
 *      (with a documented reason).
 *
 * Failing this check means a new secret-shaped env var was added to
 * the codebase without wiring it through Vault — which would cause
 * a production rollout to read it from a hand-rolled cluster Secret
 * (or worse, a CI env var the deployment platform forgot to plumb
 * through), defeating the rotation / audit story Vault exists to
 * provide.
 *
 * Exit codes:
 *   0  every secret-shaped env var is covered.
 *   1  one or more secrets are missing from Vault wiring AND not
 *      allowlisted. Names + file:line references are printed to
 *      stderr.
 *   2  the values file or source tree could not be read (workflow
 *      misconfig — usually a path rename).
 *
 * The check runs in CI on every PR via
 * .github/workflows/check-vault-secret-coverage.yml.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALLOWLIST,
  SECRET_NAME_PATTERNS,
  SOURCE_TREE,
  VALUES_PATH,
} from "./vaultSecretCoverage.config";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// scripts/src -> repo root: ../../
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

/**
 * Pure helper: extract the set of env-var names declared as
 * Vault-backed in a helm values.yaml. The values file's
 * `vault.secrets[*].keys[*]` block uses a flow-style mapping per
 * line (`- ENV_VAR_NAME: { remoteKey: ..., property: ... }`), so we
 * line-scan rather than full-parse YAML — the file format here is
 * stable and the verifier wants to fail loudly if the shape ever
 * changes.
 *
 * Exported for tests so we don't have to round-trip through disk.
 */
export function extractVaultBackedEnvVars(yaml: string): Set<string> {
  const out = new Set<string>();
  // Match lines like:
  //   - DATABASE_URL: { remoteKey: epplaa/api-monolith, property: database_url }
  // Indentation may vary (8 spaces under `keys:` is the project's
  // current convention). The regex is anchored to the leading dash so
  // we don't pick up the values file's section comments.
  const lineRe = /^\s*-\s*([A-Z][A-Z0-9_]*)\s*:\s*\{/gm;
  for (const m of yaml.matchAll(lineRe)) {
    out.add(m[1]!);
  }
  return out;
}

/**
 * Pure helper: extract every `process.env.<NAME>` reference from a
 * source string. Returns the set of distinct names — duplicates
 * don't add coverage signal, and the caller wants the unique set to
 * compare against Vault wiring + allowlist.
 *
 * Exported for tests. Conservative by design: only matches the
 * literal `process.env.<IDENTIFIER>` form, not destructuring
 * (`const {X} = process.env`) — those exist in some files but are
 * rare enough that adding them in this regex creates more false
 * positives (variable shadowing, type-only imports) than coverage
 * gained.
 */
export function extractEnvRefs(source: string): Set<string> {
  const out = new Set<string>();
  const re = /process\.env\.([A-Z][A-Z0-9_]*)/g;
  for (const m of source.matchAll(re)) {
    out.add(m[1]!);
  }
  return out;
}

/**
 * Pure helper: filter env-var names down to the secret-shaped ones
 * (per SECRET_NAME_PATTERNS). Exported for tests.
 */
export function filterSecretShaped(
  names: ReadonlySet<string>,
  patterns: readonly RegExp[],
): Set<string> {
  const out = new Set<string>();
  for (const n of names) {
    if (patterns.some((p) => p.test(n))) out.add(n);
  }
  return out;
}

/**
 * Walk a directory tree and return absolute paths of every `.ts` /
 * `.tsx` / `.js` file. Skips `node_modules`, `dist`, `.next`, and
 * any `*.test.ts` / `*.spec.ts` (tests' env-var references don't
 * count as production usage).
 */
function walkSourceFiles(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch (err) {
      throw new Error(
        `cannot read source tree at ${cur}: ${(err as Error).message}`,
      );
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === "dist" || entry === ".next") {
        continue;
      }
      const full = path.join(cur, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!st.isFile()) continue;
      if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(entry)) continue;
      if (!/\.(ts|tsx|js|jsx)$/.test(entry)) continue;
      out.push(full);
    }
  }
  return out.sort();
}

/**
 * Pure helper: compute coverage gaps. Returns the names of secrets
 * referenced in code that are neither Vault-backed nor allowlisted.
 * Exported for tests.
 */
export interface CoverageReport {
  missing: string[];
  allowlisted: string[];
  covered: string[];
}
export function evaluateCoverage(
  secretsInCode: ReadonlySet<string>,
  vaultBacked: ReadonlySet<string>,
  allowlist: readonly { name: string; reason: string }[],
): CoverageReport {
  const allowSet = new Set(allowlist.map((e) => e.name));
  const missing: string[] = [];
  const allowlisted: string[] = [];
  const covered: string[] = [];
  for (const name of [...secretsInCode].sort()) {
    if (vaultBacked.has(name)) {
      covered.push(name);
    } else if (allowSet.has(name)) {
      allowlisted.push(name);
    } else {
      missing.push(name);
    }
  }
  return { missing, allowlisted, covered };
}

interface RefLocation {
  name: string;
  file: string;
  line: number;
}

/**
 * Walk the source tree and return per-name occurrence locations for
 * the missing names. Used only when the coverage check fails, so the
 * stderr output points to the exact file:line that introduced the
 * uncovered secret — actionable without grepping by hand.
 */
function locateRefs(
  files: readonly string[],
  missing: ReadonlySet<string>,
): RefLocation[] {
  if (missing.size === 0) return [];
  const out: RefLocation[] = [];
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i]!.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g);
      for (const found of m) {
        if (missing.has(found[1]!)) {
          out.push({ name: found[1]!, file, line: i + 1 });
        }
      }
    }
  }
  return out;
}

function fail(msg: string, code: number): never {
  console.error(`[checkVaultSecretCoverage] FAIL exit=${code}: ${msg}`);
  process.exit(code);
}

function main(): void {
  const valuesPathAbs = path.join(REPO_ROOT, VALUES_PATH);
  const sourceTreeAbs = path.join(REPO_ROOT, SOURCE_TREE);

  let yaml: string;
  try {
    yaml = readFileSync(valuesPathAbs, "utf8");
  } catch (err) {
    fail(
      `cannot read values file at ${valuesPathAbs}: ${(err as Error).message}. ` +
        `Path is set in scripts/src/vaultSecretCoverage.config.ts (VALUES_PATH).`,
      2,
    );
  }
  const vaultBacked = extractVaultBackedEnvVars(yaml);
  if (vaultBacked.size === 0) {
    fail(
      `parsed zero Vault-backed env vars from ${valuesPathAbs}. The values file's ` +
        `vault.secrets[*].keys[*] format may have changed; update extractVaultBackedEnvVars ` +
        `in checkVaultSecretCoverage.ts to match.`,
      2,
    );
  }

  let files: string[];
  try {
    files = walkSourceFiles(sourceTreeAbs);
  } catch (err) {
    fail((err as Error).message, 2);
  }
  if (files.length === 0) {
    fail(
      `walked zero source files under ${sourceTreeAbs}. Path is set in ` +
        `scripts/src/vaultSecretCoverage.config.ts (SOURCE_TREE).`,
      2,
    );
  }

  const allRefs = new Set<string>();
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const name of extractEnvRefs(content)) allRefs.add(name);
  }
  const secretsInCode = filterSecretShaped(allRefs, SECRET_NAME_PATTERNS);

  const report = evaluateCoverage(secretsInCode, vaultBacked, ALLOWLIST);

  console.log(
    `[checkVaultSecretCoverage] scanned ${files.length} file(s), found ${allRefs.size} ` +
      `env reference(s); ${secretsInCode.size} secret-shaped name(s).`,
  );
  console.log(
    `[checkVaultSecretCoverage] covered=${report.covered.length}, ` +
      `allowlisted=${report.allowlisted.length}, missing=${report.missing.length}`,
  );
  if (report.allowlisted.length > 0) {
    const allowMap = new Map(ALLOWLIST.map((e) => [e.name, e.reason]));
    for (const name of report.allowlisted) {
      console.log(`  allowlisted ${name}: ${allowMap.get(name) ?? "(no reason recorded)"}`);
    }
  }

  if (report.missing.length > 0) {
    const refs = locateRefs(files, new Set(report.missing));
    const byName = new Map<string, RefLocation[]>();
    for (const r of refs) {
      const arr = byName.get(r.name) ?? [];
      arr.push(r);
      byName.set(r.name, arr);
    }
    console.error("");
    console.error(
      `[checkVaultSecretCoverage] ${report.missing.length} secret-shaped env var(s) ` +
        `referenced in code but NOT wired through Vault:`,
    );
    for (const name of report.missing) {
      console.error(`  - ${name}`);
      const locs = byName.get(name) ?? [];
      for (const l of locs.slice(0, 5)) {
        // Print as `<repo-relative-path>:<line>` so editors can jump.
        console.error(`      ${path.relative(REPO_ROOT, l.file)}:${l.line}`);
      }
      if (locs.length > 5) {
        console.error(`      … and ${locs.length - 5} more reference(s)`);
      }
    }
    console.error("");
    console.error(
      `[checkVaultSecretCoverage] To fix, choose ONE per name:`,
    );
    console.error(
      `  1. Add the env var to ${VALUES_PATH} under vault.secrets[*].keys[*] ` +
        `(preferred — Vault rotation + audit), AND seed it via scripts/seed-vault-secrets.sh.`,
    );
    console.error(
      `  2. Add the env var to ALLOWLIST in scripts/src/vaultSecretCoverage.config.ts ` +
        `with a documented reason (only when the value is genuinely not a credential, e.g. ` +
        `a tuning knob whose name accidentally matches the secret-pattern regexes).`,
    );
    fail(
      `${report.missing.length} secret(s) without Vault wiring (see list above).`,
      1,
    );
  }

  console.log(`[checkVaultSecretCoverage] OK — every secret-shaped env var is Vault-backed or allowlisted.`);
}

const isDirectInvocation =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /checkVaultSecretCoverage(\.[mc]?[jt]s)?$/.test(process.argv[1]);

if (isDirectInvocation) {
  main();
}
