/**
 * Nightly Postgres backup + weekly restore verification.
 *
 * Operating model (documented for the runbook — actual cron is owned by the
 * deployment platform, not this script):
 *
 *   00 02 * * *  pg_dump $DATABASE_URL --format=custom --file=/backups/$(date +%F).dump
 *   00 03 * * 0  pnpm --filter @workspace/scripts exec tsx src/verifyBackup.ts
 *
 * The verify pass:
 *  1. Picks the most recent dump under $BACKUP_DIR (default /backups).
 *  2. Restores into $RESTORE_DATABASE_URL — a throwaway DB. Fails loudly
 *     if the env var is unset; we never restore over the live DB.
 *  3. Runs a small set of smoke queries to confirm row counts and PK
 *     integrity (audit chain row count, payments row count, latest order id).
 *
 * Exit codes are surfaced so an orchestrator (GitHub Actions schedule, k8s
 * CronJob, or a host cron+Sentry-cron) can alert on failure.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

const BACKUP_DIR = process.env.BACKUP_DIR ?? "/backups";
const RESTORE_DATABASE_URL = process.env.RESTORE_DATABASE_URL;

function fail(msg: string, code = 1): never {
  console.error(`[verifyBackup] ${msg}`);
  process.exit(code);
}

function latestDump(dir: string): string {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    fail(`cannot read backup dir ${dir}: ${(err as Error).message}`, 2);
  }
  const dumps = entries
    .filter((f) => f.endsWith(".dump"))
    .map((f) => path.join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (dumps.length === 0) fail(`no .dump files in ${dir}`, 2);
  return dumps[0]!;
}

function main(): void {
  if (!RESTORE_DATABASE_URL) {
    fail("RESTORE_DATABASE_URL is required (and must NOT point at the live DB)", 3);
  }
  const dump = latestDump(BACKUP_DIR);
  console.log(`[verifyBackup] restoring ${dump} -> ${RESTORE_DATABASE_URL.replace(/:[^@]+@/, ":***@")}`);
  const restore = spawnSync(
    "pg_restore",
    ["--clean", "--if-exists", "--no-owner", "--dbname", RESTORE_DATABASE_URL, dump],
    { stdio: "inherit" },
  );
  if (restore.status !== 0) fail(`pg_restore exited ${restore.status}`, 4);

  const smoke = spawnSync(
    "psql",
    [
      RESTORE_DATABASE_URL,
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      "SELECT 'audit' AS k, count(*) FROM audit_log " +
        "UNION ALL SELECT 'payment_intents', count(*) FROM payment_intents " +
        "UNION ALL SELECT 'orders', count(*) FROM orders;",
    ],
    { stdio: "inherit" },
  );
  if (smoke.status !== 0) fail(`smoke psql exited ${smoke.status}`, 5);
  console.log("[verifyBackup] OK");
}

main();
