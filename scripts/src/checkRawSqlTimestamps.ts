/**
 * CI lint check for the raw-SQL timestamp pitfall (task #147).
 *
 * When using db.execute(sql`...`), the pg driver returns TIMESTAMPTZ
 * columns as strings, not Date objects — even when the TypeScript
 * generic says Date. Callers must pipe values through toDateOrNull()
 * before calling Date methods on them.
 *
 * This check finds files that use db.execute(sql`) but don't import
 * toDateOrNull, which is a signal they may be treating raw strings as
 * Dates. New files that genuinely use db.execute without timestamp
 * columns should add a comment: // raw-sql-timestamp-lint-ok
 *
 * Exit 0 when no violations, non-zero with offenders on stderr.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

const SCAN_DIRS = [
  "services/api-monolith/src",
  "scripts/src",
];

const RAW_SQL_RE = /db\.execute\s*\(\s*sql`/;
const TODATE_IMPORT_RE = /toDateOrNull/;
const LINT_OK_RE = /\/\/\s*raw-sql-timestamp-lint-ok/;

function scanDir(dir: string): string[] {
  const abs = path.join(REPO_ROOT, dir);
  const offenders: string[] = [];
  function walk(d: string) {
    for (const entry of readdirSync(d)) {
      const full = path.join(d, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        if (entry !== "node_modules" && entry !== "dist" && entry !== ".git") {
          walk(full);
        }
      } else if (full.endsWith(".ts") && !full.endsWith(".test.ts") && !full.endsWith(".spec.ts")) {
        const src = readFileSync(full, "utf8");
        if (RAW_SQL_RE.test(src) && !TODATE_IMPORT_RE.test(src) && !LINT_OK_RE.test(src)) {
          offenders.push(path.relative(REPO_ROOT, full));
        }
      }
    }
  }
  try { walk(abs); } catch { /* dir missing = no files to scan */ }
  return offenders;
}

const offenders = SCAN_DIRS.flatMap(scanDir);

if (offenders.length === 0) {
  process.stdout.write("[checkRawSqlTimestamps] No violations found.\n");
  process.exit(0);
} else {
  process.stderr.write("[checkRawSqlTimestamps] Files using db.execute(sql`) without toDateOrNull import:\n");
  for (const f of offenders) {
    process.stderr.write(`  ${f}\n`);
  }
  process.stderr.write(
    "Fix: import toDateOrNull from './dbTimestamps' and pipe every TIMESTAMPTZ column value through it.\n" +
    "Or add // raw-sql-timestamp-lint-ok to the file if raw SQL genuinely has no timestamp columns.\n"
  );
  process.exit(1);
}
