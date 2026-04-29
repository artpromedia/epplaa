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
 *  2. Asserts the newest dump is recent (mtime within $MAX_DUMP_AGE_HOURS,
 *     default 36h). Catches the "last week's dump was restored because the
 *     new one never landed" failure mode that pure mtime ordering hides.
 *  3. Restores into $RESTORE_DATABASE_URL — a throwaway DB. Fails loudly
 *     if the env var is unset; we never restore over the live DB.
 *  4. Smoke row-count check on `audit_events`, `payment_intents`, `orders`
 *     so a structurally-valid but empty dump still pages.
 *  5. Asserts every name in $REQUIRED_EXTENSIONS (comma-separated) is
 *     installed in the restored sandbox. pg_restore happily "succeeds"
 *     against a stripped-down sandbox, leaving the data unusable for the
 *     real app boot — this catches that gap.
 *  6. Anti-join FK integrity check across the core relational graph
 *     (orders → users, payment_intents → users, payment_intents → orders).
 *     Drizzle does not declare DB-level FKs on these columns, so a corrupt
 *     dump can satisfy `pg_restore` and still violate the invariants the
 *     application code relies on.
 *  7. Recomputes the audit_events hash chain end-to-end — the very thing
 *     the audit log exists to prove. Mirrors the recompute logic in
 *     artifacts/api-server/src/lib/audit.ts (`verifyAuditChain` /
 *     `canonicalJson`); keep the two in lockstep — if the canonical
 *     content shape changes there it must change here too, or the
 *     verifier will start false-positive paging.
 *
 * Distinct exit codes are surfaced so an orchestrator (GitHub Actions
 * schedule, k8s CronJob, or a host cron+Sentry-cron) can route the right
 * page to the right team — see docs/runbooks/backup-verify.md for the
 * full table and on-call ownership mapping.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

const BACKUP_DIR = process.env.BACKUP_DIR ?? "/backups";
const RESTORE_DATABASE_URL = process.env.RESTORE_DATABASE_URL;
const MAX_DUMP_AGE_HOURS = Number(process.env.MAX_DUMP_AGE_HOURS ?? 36);
const REQUIRED_EXTENSIONS = (process.env.REQUIRED_EXTENSIONS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Exit codes. Stable contract — the runbook (and any external monitor /
 * Sentry alert routing) keys on these values to decide who to page.
 *
 * 1xx-shaped grouping by ownership:
 *   transport / freshness / sandbox config -> platform team (2, 3, 6, 9)
 *   dump-internal corruption                -> platform team + DB owner (4, 5, 7)
 *   audit-chain integrity                   -> audit / compliance owner (8)
 */
const EXIT = {
  GENERIC: 1,
  BACKUP_MISSING: 2,
  RESTORE_URL_MISSING: 3,
  RESTORE_FAILED: 4,
  SMOKE_FAILED: 5,
  STALE_DUMP: 6,
  FK_INTEGRITY: 7,
  CHAIN_BROKEN: 8,
  EXTENSION_MISSING: 9,
} as const;

function fail(msg: string, code: number = EXIT.GENERIC): never {
  console.error(`[verifyBackup] FAIL exit=${code}: ${msg}`);
  process.exit(code);
}

interface DumpInfo {
  path: string;
  mtimeMs: number;
  ageHours: number;
}

function latestDump(dir: string): DumpInfo {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    fail(`cannot read backup dir ${dir}: ${(err as Error).message}`, EXIT.BACKUP_MISSING);
  }
  const dumps = entries
    .filter((f) => f.endsWith(".dump"))
    .map((f) => path.join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (dumps.length === 0) fail(`no .dump files in ${dir}`, EXIT.BACKUP_MISSING);
  const top = dumps[0]!;
  const mtimeMs = statSync(top).mtimeMs;
  const ageHours = (Date.now() - mtimeMs) / (1000 * 60 * 60);
  return { path: top, mtimeMs, ageHours };
}

/**
 * Reject a dump that is older than MAX_DUMP_AGE_HOURS. The nightly producer
 * is meant to drop a fresh file every ~24h; if the verify job picks up a
 * dump older than ~36h, the producer almost certainly stalled and we'd be
 * happily restoring last week's data without anyone noticing.
 */
function checkFreshness(dump: DumpInfo): void {
  if (dump.ageHours > MAX_DUMP_AGE_HOURS) {
    fail(
      `latest dump ${path.basename(dump.path)} is ${dump.ageHours.toFixed(1)}h old ` +
        `(max ${MAX_DUMP_AGE_HOURS}h). The nightly producer likely stalled — ` +
        `do NOT trust this restore as proof recent dumps are healthy.`,
      EXIT.STALE_DUMP,
    );
  }
  console.log(
    `[verifyBackup] freshness OK: dump age ${dump.ageHours.toFixed(1)}h <= ${MAX_DUMP_AGE_HOURS}h`,
  );
}

/**
 * Run a single psql query in `-At` (unaligned, tuples-only) mode and return
 * stdout. JSON / row_to_json output is safe to split on '\n' because PG's
 * JSON serializer escapes embedded newlines inside string values.
 */
function psql(sql: string, code: number): string {
  const r = spawnSync(
    "psql",
    [RESTORE_DATABASE_URL!, "-X", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql],
    {
      stdio: ["ignore", "pipe", "inherit"],
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 1024,
    },
  );
  if (r.status !== 0) {
    fail(`psql exited ${r.status} for query: ${sql.slice(0, 120).replace(/\s+/g, " ")}`, code);
  }
  return r.stdout;
}

/**
 * Mirrors artifacts/api-server/src/lib/audit.ts -> canonicalJson. Stable
 * key ordering so the recomputed rowHash is deterministic regardless of how
 * Postgres serialized the JSONB column on the way out. Keep in lockstep
 * with the production helper.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * Assert every name in REQUIRED_EXTENSIONS is installed in the restored
 * sandbox DB. pg_restore can "succeed" against a sandbox that's missing
 * the extensions the production schema depends on (e.g. pgcrypto for
 * gen_random_*, pg_trgm for trigram indexes). The data is then technically
 * present but the app won't boot against it — which is exactly the failure
 * the restore drill is supposed to catch ahead of an actual recovery.
 */
function checkExtensions(): void {
  if (REQUIRED_EXTENSIONS.length === 0) {
    console.log(
      "[verifyBackup] REQUIRED_EXTENSIONS unset — skipping extension presence check " +
        "(set e.g. REQUIRED_EXTENSIONS=pgcrypto,pg_trgm to opt in)",
    );
    return;
  }
  const literals = REQUIRED_EXTENSIONS.map((n) => `('${n.replace(/'/g, "''")}')`).join(",");
  const out = psql(
    `SELECT COALESCE(string_agg(req.name, ','), '') FROM (VALUES ${literals}) AS req(name)
     LEFT JOIN pg_extension e ON e.extname = req.name
     WHERE e.extname IS NULL`,
    EXIT.EXTENSION_MISSING,
  ).trim();
  if (out.length > 0) {
    fail(
      `required Postgres extensions missing on restored sandbox: ${out}. ` +
        `Either install them (CREATE EXTENSION) on the sandbox, or fix the dump's ` +
        `extension preamble — without these the production app will not boot ` +
        `against this restore.`,
      EXIT.EXTENSION_MISSING,
    );
  }
  console.log(`[verifyBackup] extensions present: ${REQUIRED_EXTENSIONS.join(",")}`);
}

/**
 * Anti-join FK integrity for the core relational graph. The Drizzle schema
 * does not declare DB-level FK constraints on these columns (they are
 * application-enforced), so a corrupt dump can pass `pg_restore` cleanly
 * and still violate the invariants the app code assumes.
 *
 * Checks (paired with the entity-relationship the runbook references):
 *   payment_intents.order_id  -> orders.id        (orphan intents)
 *   orders.user_id            -> users.clerk_id   (orders for deleted users)
 *   payment_intents.user_id   -> users.clerk_id   (intents for deleted users)
 */
function checkFkIntegrity(): void {
  const orphanIntents = Number(
    psql(
      `SELECT count(*) FROM payment_intents pi
       WHERE pi.order_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = pi.order_id)`,
      EXIT.FK_INTEGRITY,
    ).trim(),
  );
  const danglingOrders = Number(
    psql(
      `SELECT count(*) FROM orders o
       WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.clerk_id = o.user_id)`,
      EXIT.FK_INTEGRITY,
    ).trim(),
  );
  const danglingIntents = Number(
    psql(
      `SELECT count(*) FROM payment_intents pi
       WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.clerk_id = pi.user_id)`,
      EXIT.FK_INTEGRITY,
    ).trim(),
  );
  const violations: string[] = [];
  if (orphanIntents > 0) {
    violations.push(`${orphanIntents} payment_intents.order_id row(s) with no matching orders.id`);
  }
  if (danglingOrders > 0) {
    violations.push(`${danglingOrders} orders.user_id row(s) with no matching users.clerk_id`);
  }
  if (danglingIntents > 0) {
    violations.push(
      `${danglingIntents} payment_intents.user_id row(s) with no matching users.clerk_id`,
    );
  }
  if (violations.length > 0) {
    fail(
      `FK integrity violations on restored data: ${violations.join("; ")}. ` +
        `The dump is internally inconsistent — money-flow joins (orders ↔ payments ↔ users) ` +
        `would silently drop rows on restore.`,
      EXIT.FK_INTEGRITY,
    );
  }
  console.log("[verifyBackup] FK integrity OK (orders ↔ payment_intents ↔ users)");
}

interface AuditRow {
  seq: number;
  actor_id: string | null;
  action: string;
  entity: string;
  entity_id: string;
  pii_read: boolean;
  payload: unknown;
  prev_hash: string;
  row_hash: string;
}

/**
 * Replay the audit-event hash chain end-to-end against the restored data.
 * The audit chain is the only structure that proves historic records have
 * not been tampered with, so verifying it against the dump is the highest-
 * value integrity check we can run — a chain that doesn't validate means
 * either the dump was corrupted in transit OR a row was rewritten in place
 * before the dump was taken (which, by the audit-immutability invariant,
 * should be impossible). Both cases page the audit owners.
 *
 * Recomputation mirrors recordAudit/verifyAuditChain in
 * artifacts/api-server/src/lib/audit.ts; the canonical content shape MUST
 * stay in lockstep with that file or this verifier will false-positive.
 */
function checkAuditChain(): void {
  // Stream rows in seq order as JSON-per-line. row_to_json escapes any
  // embedded newlines inside string values to "\n", so split on '\n' is
  // safe and the per-line parse is well-defined.
  const out = psql(
    `SELECT row_to_json(t) FROM (
       SELECT seq, actor_id, action, entity, entity_id, pii_read, payload, prev_hash, row_hash
       FROM audit_events ORDER BY seq
     ) t`,
    EXIT.CHAIN_BROKEN,
  );
  const lines = out.split("\n").filter((l) => l.length > 0);
  let prev = "";
  let count = 0;
  for (const line of lines) {
    let row: AuditRow;
    try {
      row = JSON.parse(line) as AuditRow;
    } catch (err) {
      fail(
        `audit_events row failed to parse as JSON: ${(err as Error).message}`,
        EXIT.CHAIN_BROKEN,
      );
    }
    if (row.prev_hash !== prev) {
      fail(
        `audit chain broken at seq=${row.seq}: prev_hash mismatch ` +
          `(expected '${prev}', got '${row.prev_hash}'). A row was inserted, deleted, ` +
          `or reordered between writes — page the audit owners.`,
        EXIT.CHAIN_BROKEN,
      );
    }
    const content = canonicalJson({
      actor: row.actor_id ?? null,
      action: row.action,
      entity: row.entity,
      entityId: row.entity_id ?? "",
      piiRead: Boolean(row.pii_read),
      payload: row.payload ?? {},
    });
    const expected = createHash("sha256").update(prev).update("\n").update(content).digest("hex");
    if (expected !== row.row_hash) {
      fail(
        `audit chain broken at seq=${row.seq}: row_hash mismatch ` +
          `(computed ${expected}, stored ${row.row_hash}). The row's payload/action/entity ` +
          `was rewritten in place after the chain link was sealed — page the audit owners.`,
        EXIT.CHAIN_BROKEN,
      );
    }
    prev = row.row_hash;
    count++;
  }
  console.log(`[verifyBackup] audit chain OK (${count} row(s) replayed)`);
}

function main(): void {
  if (!RESTORE_DATABASE_URL) {
    fail(
      "RESTORE_DATABASE_URL is required (and must NOT point at the live DB)",
      EXIT.RESTORE_URL_MISSING,
    );
  }
  if (!Number.isFinite(MAX_DUMP_AGE_HOURS) || MAX_DUMP_AGE_HOURS <= 0) {
    fail(
      `MAX_DUMP_AGE_HOURS must be a positive number (got ${process.env.MAX_DUMP_AGE_HOURS})`,
      EXIT.GENERIC,
    );
  }

  const dump = latestDump(BACKUP_DIR);
  // Freshness check first — if the dump is stale, restoring it is wasted
  // work and the resulting smoke/FK/chain results would mis-attribute
  // "last week's data" as "this week's healthy state".
  checkFreshness(dump);

  console.log(
    `[verifyBackup] restoring ${dump.path} -> ${RESTORE_DATABASE_URL.replace(/:[^@]+@/, ":***@")}`,
  );
  const restore = spawnSync(
    "pg_restore",
    ["--clean", "--if-exists", "--no-owner", "--dbname", RESTORE_DATABASE_URL, dump.path],
    { stdio: "inherit" },
  );
  if (restore.status !== 0) fail(`pg_restore exited ${restore.status}`, EXIT.RESTORE_FAILED);

  // Row-count smoke. Two prior issues fixed here:
  //   1. Previous versions of this script queried `audit_log`, which is
  //      not the real table name (the schema defines `audit_events`).
  //      The smoke would have silently passed an empty-restore as long
  //      as `audit_log` *also* didn't exist (psql would error, falling
  //      through to exit 5) — confirming the bug, but masking it as
  //      "smoke failed" rather than "audit data missing".
  //   2. The previous SELECT … count(*) form succeeded for ANY count,
  //      including zero — so a "structurally valid but empty" dump
  //      would have logged "0, 0, 0" and silently exited 0. The DO
  //      block below RAISES on an empty count, so an empty dump now
  //      fails with exit 5 the way the runbook claims it does.
  const smoke = spawnSync(
    "psql",
    [
      RESTORE_DATABASE_URL,
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `DO $$
       DECLARE
         c_audit bigint; c_pi bigint; c_orders bigint;
       BEGIN
         SELECT count(*) INTO c_audit  FROM audit_events;
         SELECT count(*) INTO c_pi     FROM payment_intents;
         SELECT count(*) INTO c_orders FROM orders;
         RAISE NOTICE 'row counts: audit_events=%, payment_intents=%, orders=%',
           c_audit, c_pi, c_orders;
         IF c_audit  = 0 THEN RAISE EXCEPTION 'audit_events table is empty after restore'; END IF;
         IF c_pi     = 0 THEN RAISE EXCEPTION 'payment_intents table is empty after restore'; END IF;
         IF c_orders = 0 THEN RAISE EXCEPTION 'orders table is empty after restore'; END IF;
       END $$;`,
    ],
    { stdio: "inherit" },
  );
  if (smoke.status !== 0) fail(`smoke psql exited ${smoke.status}`, EXIT.SMOKE_FAILED);

  // Order matters: cheap structural checks first, expensive chain replay
  // last. A failure earlier in the chain short-circuits before we spend
  // minutes streaming the audit log.
  checkExtensions();
  checkFkIntegrity();
  checkAuditChain();

  console.log("[verifyBackup] OK");
}

main();
