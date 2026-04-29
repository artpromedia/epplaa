/**
 * Postgres backup restore verification.
 *
 * Operating model (documented for the runbook — actual cron is owned by the
 * deployment platform / GitHub Actions schedule, not this script):
 *
 *   00 02 * * *    pg_dump $DATABASE_URL --format=custom --file=/backups/$(date +%F).dump
 *   00 03 * * 1-6  verifyBackup.ts --mode=smoke   (nightly, fast)
 *   00 03 * * 0    verifyBackup.ts --mode=full    (weekly, fuller)
 *
 * Two modes, layered: `full` is a strict superset of `smoke`. Every smoke
 * check also runs in full; full adds the deeper integrity checks that are
 * too expensive to run nightly.
 *
 *   smoke (nightly, ~30s on a fresh sandbox):
 *     1. Pick the most recent dump under $BACKUP_DIR (default /backups).
 *     2. Assert the newest dump is recent (mtime within
 *        $MAX_DUMP_AGE_HOURS, default 36h). Catches the "last week's dump
 *        was restored because the new one never landed" failure mode that
 *        pure mtime ordering hides.
 *     2a. Verify the dump matches the SHA-256 checksum recorded in the
 *        sidecar manifest the platform's pg_dump cron writes alongside
 *        each dump (file `<dump>.sha256`, in `sha256sum` format). Done
 *        before pg_restore so a truncated / silently-corrupt transfer
 *        fails in seconds with a dedicated exit code (16) instead of
 *        manifesting as a confusing pg_restore error several minutes
 *        in. The sidecar's path can be overridden via
 *        $BACKUP_CHECKSUM_MANIFEST. Missing-manifest behaviour is
 *        opt-in: by default the step logs a notice and continues (so
 *        existing operators that haven't wired sidecars in yet don't
 *        suddenly start failing); set $BACKUP_CHECKSUM_REQUIRED=1 to
 *        flip it to a hard error once the platform pipeline is
 *        producing sidecars reliably.
 *     3. Restore into $RESTORE_DATABASE_URL — a throwaway DB. Fails loudly
 *        if the env var is unset; we never restore over the live DB.
 *     4. Smoke row-count check on `audit_events`, `payment_intents`,
 *        `orders` — a structurally-valid but empty dump still pages.
 *     5. Live-vs-restored row-count comparison (opt-in). When
 *        $LIVE_COUNTS_URL (read-only conn string) or $LIVE_COUNTS_MANIFEST
 *        (path to a small JSON snapshot the platform's pg_dump cron
 *        writes alongside the dump) is set, fetch expected row counts
 *        for $LIVE_COUNTS_TABLES (default audit_events,payment_intents,
 *        orders) and assert each restored count is within
 *        $LIVE_COUNTS_MIN_RATIO of the expected count (default 0.99 ->
 *        99%). Catches the specific failure modes that the smoke
 *        row-count check above cannot see, because it only reads from
 *        the restored sandbox: a dump that's 30 days old (restorable +
 *        non-empty + would still pass smoke), or a dump where pg_dump
 *        silently skipped a critical table (a restored audit_events
 *        with 1% of live rows is "valid" to smoke, but is a
 *        compliance-grade data-loss event waiting to happen). Skipped
 *        with a notice when neither env var is set, so existing
 *        operators that haven't wired a live source up don't break.
 *     6. Assert every name in $REQUIRED_EXTENSIONS (comma-separated) is
 *        installed in the restored sandbox. pg_restore happily "succeeds"
 *        against a stripped-down sandbox, leaving the data unusable for
 *        the real app boot — this catches that gap.
 *
 *   full (weekly, several minutes — does everything smoke does, plus):
 *     7. Anti-join FK integrity across the core relational graph
 *        (orders → users, payment_intents → users, payment_intents →
 *        orders). Drizzle does not declare DB-level FKs on these columns,
 *        so a corrupt dump can pass `pg_restore` and still violate the
 *        invariants the app code assumes.
 *     8. VACUUM (ANALYZE) the restored DB. This forces a full heap scan
 *        of every table, which is the cheapest way to detect block-level
 *        corruption that pg_restore itself didn't catch (pg_restore
 *        replays COPY, but a corrupt page won't surface until something
 *        actually reads it).
 *     9. Inventory every user table (schema + name + row count) so a
 *        silent table drop or an unexpectedly empty table is visible in
 *        the run output, not just the three smoke tables.
 *    10. Best-effort `amcheck` btree index validation. Requires the
 *        `amcheck` contrib extension; if it isn't installable in the
 *        sandbox (e.g. managed Postgres without superuser) we log a
 *        warning and continue rather than fail — the smoke + vacuum +
 *        inventory layers above already cover the high-value failure
 *        modes for this script's purpose.
 *    11. Recompute the audit_events hash chain end-to-end — the very
 *        thing the audit log exists to prove. Mirrors the recompute
 *        logic in artifacts/api-server/src/lib/audit.ts
 *        (`verifyAuditChain` / `canonicalJson`); keep the two in
 *        lockstep — if the canonical content shape changes there it must
 *        change here too, or the verifier will start false-positive
 *        paging.
 *
 * Distinct exit codes are surfaced so an orchestrator (GitHub Actions
 * schedule, k8s CronJob, or a host cron + Sentry-cron) can route the
 * right page to the right team. They are also documented in
 * docs/runbooks/backup-verify.md — keep the two in lockstep when adding
 * a new exit code.
 *
 *    1  generic verify error (the script's `fail()` default)
 *    2  no .dump files in BACKUP_DIR / cannot read BACKUP_DIR
 *    3  RESTORE_DATABASE_URL unset (refused to restore for safety)
 *    4  pg_restore exited non-zero
 *    5  smoke psql exited non-zero (missing tables OR empty rows)
 *    6  stale dump (newest .dump older than MAX_DUMP_AGE_HOURS)
 *    7  FK integrity violation (full mode only)
 *    8  audit chain broken (full mode only)
 *    9  required Postgres extensions missing on restored sandbox
 *   10  VACUUM (ANALYZE) exited non-zero (full mode only)
 *   11  full-mode table inventory exited non-zero (full mode only)
 *   12  amcheck btree validation reported a corrupt index (full mode
 *       only; extension-missing is downgraded to a warning, not exit 12)
 *   13  unknown --mode value
 *   14  restored row counts are stale or incomplete vs the live source /
 *       manifest (dump is restorable but its data is behind production —
 *       distinct from exit 4-8 "dump corrupt" and from exit 6 "dump file
 *       mtime stale": this catches the case where the file is fresh and
 *       restorable but its *contents* lag the live DB, which the
 *       file-mtime check cannot see).
 *   15  restored row counts have dropped sharply vs the most recent
 *       prior verify run (the per-run history file under BACKUP_DIR /
 *       WEEK_OVER_WEEK_HISTORY). Catches the case where smoke +
 *       live-counts both agree this week's dump is "fine" because the
 *       producer regenerated the manifest off the same partial dump,
 *       but the data has shrunk sharply vs last week's healthy baseline
 *       (e.g. orders went from 1.2M -> 5 because a partial pg_dump was
 *       published over the good one). Distinct from exit 14 because
 *       exit 14 compares restored vs *current* live; exit 15 compares
 *       restored vs *the prior verify's* restored.
 *   16  dump SHA-256 does not match the sidecar manifest, OR the
 *       manifest itself is malformed / unreadable, OR the sidecar is
 *       missing while $BACKUP_CHECKSUM_REQUIRED=1. Distinct from exit 4
 *       (`pg_restore` failed): exit 16 fires *before* pg_restore runs,
 *       so on-call knows the file we downloaded does not match what
 *       the producer wrote — almost always a transport corruption /
 *       silent S3 partial-read rather than a dump-internal problem.
 *
 * Ownership grouping (matches the runbook's page-routing contract):
 *   transport / freshness / sandbox config -> platform team (2, 3, 6, 9, 16)
 *   dump-internal corruption                -> platform team + DB owner
 *                                              (4, 5, 7, 10, 11, 12, 14,
 *                                              15)
 *   audit-chain integrity                   -> audit / compliance owner
 *                                              (8)
 *   operator / workflow misconfig           -> repo owner (13)
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  createReadStream,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

type Mode = "smoke" | "full";

const BACKUP_DIR = process.env.BACKUP_DIR ?? "/backups";
const RESTORE_DATABASE_URL = process.env.RESTORE_DATABASE_URL;
const MAX_DUMP_AGE_HOURS = Number(process.env.MAX_DUMP_AGE_HOURS ?? 36);
const REQUIRED_EXTENSIONS = (process.env.REQUIRED_EXTENSIONS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Checksum-verification knobs for step 2a (see header). The default
 * sidecar location is `<dump>.sha256` next to the dump (mirrors the
 * convention `sha256sum dump > dump.sha256` produces). Override only
 * when the platform pipeline writes a single per-day signed manifest
 * to a different path.
 *
 * `BACKUP_CHECKSUM_REQUIRED` is the rollout knob: when "1" the verify
 * step fails with exit 15 if the sidecar is missing; otherwise it
 * logs a one-line notice and continues. Default is "0" (opt-in) so
 * existing operators that haven't wired the producer-side sidecar in
 * yet do not start failing on the first run after this rolls out —
 * flip it to "1" once the platform team confirms every fresh dump
 * lands with its `<dump>.sha256` companion. A *malformed* manifest is
 * always exit 15 regardless of this flag (we'd rather page than
 * silently treat a broken manifest as "no manifest").
 */
const BACKUP_CHECKSUM_MANIFEST = process.env.BACKUP_CHECKSUM_MANIFEST;
const BACKUP_CHECKSUM_REQUIRED = process.env.BACKUP_CHECKSUM_REQUIRED === "1";

/**
 * Live-counts comparison knobs. The check itself is opt-in: when both
 * LIVE_COUNTS_URL and LIVE_COUNTS_MANIFEST are unset the step is
 * skipped with a notice (so existing operators that haven't wired a
 * live source up don't suddenly start failing). When either is set:
 *   - LIVE_COUNTS_URL: a *read-only* Postgres connection string the
 *     verifier psql-queries directly. Use the cheapest read-only role
 *     you have on production — three count(*) queries against the
 *     smoke tables are not free at scale, but they are bounded.
 *   - LIVE_COUNTS_MANIFEST: a path to a small JSON file mapping table
 *     name -> live row count, e.g. `{"audit_events": 1234567, ...}`.
 *     Useful when the GH Actions runner cannot reach the production DB
 *     directly: the platform's pg_dump cron writes the manifest
 *     alongside the dump, and the workflow downloads both.
 * Setting both is rejected (ambiguous source-of-truth).
 *
 * LIVE_COUNTS_TABLES is only consulted in the LIVE_COUNTS_URL branch
 * (the manifest branch trusts whatever tables the manifest lists).
 * LIVE_COUNTS_MIN_RATIO is the minimum fraction of the live count we
 * tolerate seeing in the restored sandbox; anything below pages on
 * exit 14. 0.99 (the default) lets us absorb the small write-traffic
 * gap between when pg_dump took its consistent snapshot and when the
 * verifier reads the live count, without silently accepting a dump
 * that's missing a meaningful chunk of rows.
 */
const LIVE_COUNTS_URL = process.env.LIVE_COUNTS_URL;
const LIVE_COUNTS_MANIFEST = process.env.LIVE_COUNTS_MANIFEST;
const LIVE_COUNTS_TABLES = (
  process.env.LIVE_COUNTS_TABLES ?? "audit_events,payment_intents,orders"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const LIVE_COUNTS_MIN_RATIO = Number(process.env.LIVE_COUNTS_MIN_RATIO ?? 0.99);

/**
 * Week-over-week row-count drift comparison knobs. Catches the
 * specific failure mode that smoke + live-counts do not cover: a dump
 * that landed on time, has rows in the smoke tables, and matches the
 * platform's manifest, but whose row counts have dropped sharply vs
 * the LAST successful verify run (e.g. `orders` went from 1.2M -> 5
 * because a partial pg_dump was published over the good one AND the
 * accompanying manifest was regenerated against the same partial
 * dump, so the live-counts comparison happily passes against the
 * regressed manifest).
 *
 * On every run the verifier appends `{timestamp, counts}` to a small
 * JSON history file (default `${BACKUP_DIR}/verify-row-counts-history.json`,
 * override via WEEK_OVER_WEEK_HISTORY) and compares the current
 * restored counts against the most recent prior entry. A drop greater
 * than WEEK_OVER_WEEK_MAX_DROP_RATIO (default 0.20 -> 20%) on any
 * tracked table exits 15.
 *
 * Behavior worth being explicit about:
 *  - First run on a brand-new backup share (no history file): record
 *    a baseline entry, log a `[verifyBackup]` notice, do NOT compare.
 *    There's nothing to compare against yet, and we don't want a
 *    fresh sandbox to false-page on its first tick.
 *  - On exit 15 the history file is intentionally NOT updated. If we
 *    rolled the new (regressed) counts into history, the NEXT run
 *    would compare regressed-vs-regressed and silently re-pass.
 *    Keeping the prior baseline in place means the page keeps firing
 *    every run until either the data is restored OR the operator
 *    explicitly clears the history file to accept the new baseline.
 *  - History is capped at WEEK_OVER_WEEK_MAX_HISTORY entries (default
 *    12, ~3 months of weekly entries) so the file stays small. Only
 *    the most recent entry drives the comparison; the older entries
 *    exist for human triage.
 *  - WEEK_OVER_WEEK_TABLES defaults to the same three smoke tables
 *    (`audit_events,payment_intents,orders`) — the money-flow + audit
 *    chain that the rest of the verifier already treats as critical.
 *    Set WEEK_OVER_WEEK_MAX_DROP_RATIO=1 to disable the check
 *    entirely without removing the env var (a 100% drop is permitted
 *    so nothing trips).
 *  - The comparison iterates every table present in the *prior history
 *    entry*, not just the currently configured WEEK_OVER_WEEK_TABLES.
 *    That means *adding* a table is safe (it gets recorded on the next
 *    run and participates in comparisons one run later), but *removing*
 *    a table from the config does NOT stop comparing it until the
 *    prior history entry rolls off — clear the history file (or wait
 *    for the FIFO cap) if shrinking the list and you don't want to
 *    keep paging on the dropped table.
 */
const WEEK_OVER_WEEK_HISTORY =
  process.env.WEEK_OVER_WEEK_HISTORY ??
  path.join(BACKUP_DIR, "verify-row-counts-history.json");
const WEEK_OVER_WEEK_TABLES = (
  process.env.WEEK_OVER_WEEK_TABLES ?? "audit_events,payment_intents,orders"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const WEEK_OVER_WEEK_MAX_DROP_RATIO = Number(
  process.env.WEEK_OVER_WEEK_MAX_DROP_RATIO ?? 0.2,
);
const WEEK_OVER_WEEK_MAX_HISTORY = Number(
  process.env.WEEK_OVER_WEEK_MAX_HISTORY ?? 12,
);

/**
 * Exit codes. Stable contract — the runbook (and any external monitor /
 * Sentry alert routing) keys on these values to decide who to page.
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
  VACUUM_FAILED: 10,
  INVENTORY_FAILED: 11,
  AMCHECK_FAILED: 12,
  UNKNOWN_MODE: 13,
  STALE_DATA: 14,
  WEEK_OVER_WEEK_DROP: 15,
  CHECKSUM_MISMATCH: 16,
} as const;

function fail(msg: string, code: number = EXIT.GENERIC): never {
  console.error(`[verifyBackup] FAIL exit=${code}: ${msg}`);
  process.exit(code);
}

function parseMode(argv: readonly string[]): Mode {
  // Accept --mode=smoke / --mode=full / --mode smoke / --mode full.
  // Default to smoke so a bare invocation matches the original behavior.
  // Also accept VERIFY_MODE env var so the GH Actions workflow can wire
  // it through `env:` without rebuilding the args array.
  let raw: string | undefined = process.env.VERIFY_MODE;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--mode=")) {
      raw = a.slice("--mode=".length);
    } else if (a === "--mode" && i + 1 < argv.length) {
      raw = argv[i + 1];
      i++;
    }
  }
  if (raw == null || raw === "") return "smoke";
  if (raw === "smoke" || raw === "full") return raw;
  fail(`unknown --mode value '${raw}' (expected 'smoke' or 'full')`, EXIT.UNKNOWN_MODE);
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
 * Pure helper: parse a SHA-256 manifest file's contents and return
 * the expected hex digest for `dumpBasename`. Exported for tests.
 *
 * Two on-disk formats are tolerated, in order:
 *  1. `sha256sum` output — one or more lines of `<64-hex>  <name>` (the
 *     two-space separator GNU sha256sum writes; binary mode uses `*`
 *     between digest and name, also accepted). Whitespace at the
 *     start/end of the line is trimmed. Lines that don't match are
 *     ignored, so a manifest can carry blank lines or `# comment`
 *     lines without breaking the parse.
 *  2. A bare 64-character hex digest (no filename) — convenient when
 *     the producer writes one sidecar per dump and doesn't bother
 *     with the filename column.
 *
 * Throws (with a message safe to surface to the operator) on:
 *  - empty / whitespace-only manifest content;
 *  - no usable digest found for `dumpBasename` AND no bare-digest
 *    fallback line present;
 *  - a digest that's not 64 lowercased-hex characters (catches
 *    operator typos like accidentally storing the base64 SHA, or a
 *    truncated digest line).
 *
 * The digest is normalized to lowercase before being returned, so
 * the caller can compare directly against
 * `createHash("sha256").digest("hex")` (which always emits
 * lowercase).
 */
export function parseSha256Manifest(content: string, dumpBasename: string): string {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (lines.length === 0) {
    throw new Error("checksum manifest is empty (no digest lines found)");
  }
  // Pass 1: look for a `<hex>  <name>` line whose name matches the dump.
  // GNU sha256sum writes two spaces in text mode and ` *` in binary mode;
  // be liberal about whitespace between the digest and the filename.
  let bareDigest: string | null = null;
  for (const line of lines) {
    const twoCol = /^([0-9a-fA-F]+)\s+\*?(\S.*)$/.exec(line);
    if (twoCol) {
      const [, digest, name] = twoCol;
      // path.basename strips any directory prefix the manifest happens
      // to carry (some producers write `./<name>` or absolute paths).
      if (path.basename(name!) === dumpBasename) {
        return assertHex64(digest!);
      }
      continue;
    }
    if (/^[0-9a-fA-F]+$/.test(line)) {
      // Stash the bare digest as a fallback — only used if no name-
      // matching line was found.
      bareDigest = line;
    }
  }
  if (bareDigest !== null) return assertHex64(bareDigest);
  throw new Error(
    `checksum manifest contains no entry for ${dumpBasename} ` +
      `(and no single bare-digest fallback line)`,
  );
}

function assertHex64(digest: string): string {
  const lower = digest.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(lower)) {
    throw new Error(
      `checksum manifest digest is not a 64-char hex SHA-256 ` +
        `(got ${digest.length}-char value '${digest.slice(0, 16)}…')`,
    );
  }
  return lower;
}

async function sha256OfFile(p: string): Promise<string> {
  // Stream the file rather than `readFileSync` — production dumps run
  // to many GB and we'd rather not double-allocate them in heap just
  // to compute one hash.
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(p);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

/**
 * Verify the dump matches the SHA-256 digest recorded in the sidecar
 * manifest. Runs *before* pg_restore so a truncated / silently-corrupt
 * transfer (the classic S3 partial-read failure) fails in seconds with
 * a dedicated exit code (16) instead of manifesting as a confusing
 * pg_restore error several minutes into the workflow.
 *
 * Sidecar discovery:
 *  - $BACKUP_CHECKSUM_MANIFEST overrides the path entirely (use this
 *    when the producer writes a single per-day manifest covering all
 *    dumps). The manifest is parsed for an entry matching the dump's
 *    basename; failing that, a single bare-digest line is accepted.
 *  - Otherwise the verifier looks for `<dump>.sha256` next to the
 *    dump (the convention `sha256sum dump > dump.sha256` produces).
 *
 * Missing-manifest behaviour:
 *  - When $BACKUP_CHECKSUM_REQUIRED=1 the verifier fails with exit
 *    16. Use this once the platform pipeline reliably emits sidecars.
 *  - Otherwise the verifier logs a one-line `[verifyBackup]` notice
 *    and continues. Default during rollout so existing operators
 *    that haven't wired the producer-side sidecar in yet do not
 *    start failing on day 1.
 *
 * A *malformed* manifest (unreadable, empty, no matching entry, bad
 * digest format) always exits 16 regardless of the required flag —
 * silently treating a broken manifest as "no manifest" would let a
 * corrupt dump through, which is exactly what this step exists to
 * prevent.
 */
async function checkChecksum(dump: DumpInfo): Promise<void> {
  const explicit = BACKUP_CHECKSUM_MANIFEST !== undefined && BACKUP_CHECKSUM_MANIFEST.length > 0;
  const manifestPath = explicit ? BACKUP_CHECKSUM_MANIFEST! : `${dump.path}.sha256`;

  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT" && !BACKUP_CHECKSUM_REQUIRED) {
      console.log(
        `[verifyBackup] checksum manifest not found at ${manifestPath} — ` +
          `skipping pre-restore SHA-256 check (set BACKUP_CHECKSUM_REQUIRED=1 to ` +
          `make this a hard failure once the producer emits sidecars). pg_restore ` +
          `will still surface fully-corrupt dumps, just slower and with a less ` +
          `actionable error.`,
      );
      return;
    }
    fail(
      `cannot read checksum manifest at ${manifestPath}: ${e.message}. ` +
        `Either the producer didn't emit a sidecar (page the platform team — the ` +
        `pg_dump cron should write \`<dump>.sha256\` next to every dump), or the ` +
        `BACKUP_FETCH_CMD snippet didn't pull it down alongside the dump.`,
      EXIT.CHECKSUM_MISMATCH,
    );
  }

  let expected: string;
  try {
    expected = parseSha256Manifest(raw, path.basename(dump.path));
  } catch (err) {
    fail(
      `${(err as Error).message} (manifest path: ${manifestPath}). ` +
        `Refusing to proceed — a malformed manifest cannot prove the dump is intact, ` +
        `and silently skipping would let a corrupt dump through pg_restore.`,
      EXIT.CHECKSUM_MISMATCH,
    );
  }

  let actual: string;
  try {
    actual = await sha256OfFile(dump.path);
  } catch (err) {
    fail(
      `failed to read dump file ${dump.path} while computing SHA-256: ${(err as Error).message}`,
      EXIT.CHECKSUM_MISMATCH,
    );
  }

  if (actual !== expected) {
    fail(
      `dump SHA-256 mismatch for ${path.basename(dump.path)}: ` +
        `expected ${expected} (from ${manifestPath}), got ${actual}. ` +
        `The file we downloaded does not match what the producer wrote — ` +
        `almost always a transport corruption (truncated transfer, silent S3 ` +
        `partial-read, on-disk bit flip on the runner). Re-fetch the dump and ` +
        `re-run; if the mismatch persists, page the platform team — it usually ` +
        `indicates backup-share corruption rather than dump corruption.`,
      EXIT.CHECKSUM_MISMATCH,
    );
  }

  console.log(
    `[verifyBackup] checksum OK: ${path.basename(dump.path)} sha256=${actual.slice(0, 16)}… ` +
      `matches ${manifestPath}`,
  );
}

/**
 * Run a single psql query in `-At` (unaligned, tuples-only) mode and return
 * stdout. JSON / row_to_json output is safe to split on '\n' because PG's
 * JSON serializer escapes embedded newlines inside string values.
 */
function psqlCapture(sql: string, code: number): string {
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
 * Run a psql command and stream its output to the operator's terminal /
 * GitHub Actions log. Use this when the *output* of the query (e.g. the
 * inventory row counts) is itself part of what we want a human to see in
 * the run log, not just whether it exited 0.
 */
function psqlInherit(sql: string, code: number, label: string): void {
  const r = spawnSync(
    "psql",
    [RESTORE_DATABASE_URL!, "-v", "ON_ERROR_STOP=1", "-X", "-A", "-c", sql],
    { stdio: "inherit" },
  );
  if (r.status !== 0) fail(`${label} psql exited ${r.status}`, code);
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
  const out = psqlCapture(
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
    psqlCapture(
      `SELECT count(*) FROM payment_intents pi
       WHERE pi.order_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = pi.order_id)`,
      EXIT.FK_INTEGRITY,
    ).trim(),
  );
  const danglingOrders = Number(
    psqlCapture(
      `SELECT count(*) FROM orders o
       WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.clerk_id = o.user_id)`,
      EXIT.FK_INTEGRITY,
    ).trim(),
  );
  const danglingIntents = Number(
    psqlCapture(
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
  const out = psqlCapture(
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

function redactUrl(u: string): string {
  return u.replace(/:[^@/]+@/, ":***@");
}

/**
 * Pure helper: compare expected (live) row counts against restored row
 * counts and return the tables where the restored count is below
 * `minRatio` of the expected count. Exported for unit testing — the
 * I/O wrapper `checkLiveCounts` below handles env wiring + psql.
 *
 * Special cases worth being explicit about:
 *  - A live count of 0 is never a violation (anything-over-zero is
 *    >= the threshold by convention; zero/zero we treat as 100%).
 *    A genuinely-empty live table is a config decision the operator
 *    makes by listing it in the manifest, not a backup-quality issue.
 *  - A table that's in `expected` but missing from `restored` is
 *    treated as restored=0 — i.e. a violation if the live count is
 *    non-zero. That's the dominant failure mode this check exists to
 *    catch (pg_dump silently dropped a critical table).
 *  - A table in `restored` but not in `expected` is ignored. The
 *    operator's choice of expected tables defines the comparison set.
 */
export interface LiveCountsViolation {
  table: string;
  expected: number;
  restored: number;
  ratio: number;
}
export function evaluateLiveCounts(
  expected: ReadonlyMap<string, number>,
  restored: ReadonlyMap<string, number>,
  minRatio: number,
): LiveCountsViolation[] {
  const violations: LiveCountsViolation[] = [];
  for (const [table, expectedCount] of expected) {
    const restoredCount = restored.get(table) ?? 0;
    const ratio = expectedCount === 0 ? 1 : restoredCount / expectedCount;
    if (ratio < minRatio) {
      violations.push({ table, expected: expectedCount, restored: restoredCount, ratio });
    }
  }
  return violations;
}

/**
 * Pure helper: parse + validate a live-counts manifest. The manifest
 * is intentionally a flat object (table name -> non-negative integer
 * row count). Anything else is a hard error rather than a "best
 * effort" parse, because a malformed manifest should page the
 * operator rather than silently degrade to an empty comparison set
 * (which would let stale dumps through). Exported for tests.
 */
export function parseLiveCountsManifest(json: string): Map<string, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`live-counts manifest is not valid JSON: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `live-counts manifest must be a JSON object mapping table name -> row count`,
    );
  }
  const out = new Map<string, number>();
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v) || v < 0) {
      throw new Error(
        `live-counts manifest entry '${k}' is not a non-negative integer (got ${JSON.stringify(v)})`,
      );
    }
    out.set(k, v);
  }
  return out;
}

/**
 * Pure helper: compare prior restored counts against the current
 * restored counts and return the tables whose count has dropped by
 * more than `maxDropRatio`. Exported for unit testing — the I/O
 * wrapper `checkWeekOverWeekDrop` below handles history-file +
 * psql wiring.
 *
 * Special cases:
 *  - A prior count of 0 is skipped (no meaningful drop ratio for a
 *    table that was empty last run; the first non-zero entry will
 *    establish the baseline for next time).
 *  - A table that's in `prior` but missing from `current` is treated
 *    as current=0, i.e. a 100% drop. That's the dominant failure
 *    mode this check exists to catch (silent table drop in the new
 *    dump).
 *  - A table in `current` but not in `prior` is ignored — there is
 *    no baseline to compare against. It will be recorded into
 *    history and start participating in comparisons next run.
 *  - "Drop" is one-directional: a count that GREW since last week is
 *    fine. Growth is the normal mode of an append-heavy table like
 *    `audit_events`; this check is specifically about regressions.
 */
export interface WeekOverWeekDrop {
  table: string;
  prior: number;
  current: number;
  dropRatio: number;
}
export function evaluateWeekOverWeekDrops(
  prior: ReadonlyMap<string, number>,
  current: ReadonlyMap<string, number>,
  maxDropRatio: number,
): WeekOverWeekDrop[] {
  const drops: WeekOverWeekDrop[] = [];
  for (const [table, priorCount] of prior) {
    if (priorCount <= 0) continue;
    const currentCount = current.get(table) ?? 0;
    const dropRatio = (priorCount - currentCount) / priorCount;
    if (dropRatio > maxDropRatio) {
      drops.push({ table, prior: priorCount, current: currentCount, dropRatio });
    }
  }
  return drops;
}

/**
 * Pure helper: parse + validate a week-over-week history file. Shape
 * is `{version: 1, entries: [{timestamp: string, counts: {table:
 * non-negative-integer, ...}}, ...]}`. Anything else is a hard error
 * rather than a silent reset to an empty history (silent reset would
 * mean the next run has no baseline to compare against, which would
 * mask exactly the failure mode this check exists to catch).
 * Exported for tests.
 */
export interface WeekOverWeekHistoryEntry {
  timestamp: string;
  counts: Record<string, number>;
}
export interface WeekOverWeekHistoryFile {
  version: 1;
  entries: WeekOverWeekHistoryEntry[];
}
export function parseWeekOverWeekHistory(json: string): WeekOverWeekHistoryFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `week-over-week history file is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `week-over-week history file must be a JSON object with {version, entries}`,
    );
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new Error(
      `week-over-week history file has unknown version ${JSON.stringify(obj.version)} ` +
        `(this verifier only handles version 1)`,
    );
  }
  if (!Array.isArray(obj.entries)) {
    throw new Error(`week-over-week history file 'entries' field must be an array`);
  }
  const entries: WeekOverWeekHistoryEntry[] = [];
  for (const e of obj.entries) {
    if (e === null || typeof e !== "object" || Array.isArray(e)) {
      throw new Error(`week-over-week history entry must be an object`);
    }
    const er = e as Record<string, unknown>;
    if (typeof er.timestamp !== "string" || er.timestamp.length === 0) {
      throw new Error(`week-over-week history entry is missing a 'timestamp' string`);
    }
    if (er.counts === null || typeof er.counts !== "object" || Array.isArray(er.counts)) {
      throw new Error(`week-over-week history entry 'counts' must be an object`);
    }
    const counts: Record<string, number> = {};
    for (const [k, v] of Object.entries(er.counts as Record<string, unknown>)) {
      if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v) || v < 0) {
        throw new Error(
          `week-over-week history entry counts['${k}'] is not a non-negative integer ` +
            `(got ${JSON.stringify(v)})`,
        );
      }
      counts[k] = v;
    }
    entries.push({ timestamp: er.timestamp, counts });
  }
  return { version: 1, entries };
}

/**
 * Run a single `count(*)` query against an arbitrary connection
 * string. Used for both the live source (LIVE_COUNTS_URL) and the
 * restored sandbox (RESTORE_DATABASE_URL) — the comparison check
 * needs to read counts from both sides with the same semantics.
 *
 * The table identifier is validated against a strict regex before
 * being interpolated into SQL. We have to interpolate (psql does not
 * parameterize identifiers, only values), so the regex is the only
 * thing standing between an env var and arbitrary SQL execution.
 * Allow only `[A-Za-z_][A-Za-z0-9_]*` per identifier component, and
 * at most one optional `schema.` qualifier.
 */
function queryCountsViaPsql(
  connUrl: string,
  tables: readonly string[],
  exitCode: number,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of tables) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(t)) {
      fail(
        `LIVE_COUNTS_TABLES / manifest entry '${t}' is not a valid table identifier ` +
          `(expected schema.table or table, alphanumerics + underscore only)`,
        EXIT.GENERIC,
      );
    }
    const r = spawnSync(
      "psql",
      [connUrl, "-X", "-At", "-v", "ON_ERROR_STOP=1", "-c", `SELECT count(*) FROM ${t}`],
      {
        stdio: ["ignore", "pipe", "inherit"],
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      },
    );
    if (r.status !== 0) {
      fail(`psql exited ${r.status} querying count(*) FROM ${t}`, exitCode);
    }
    const n = Number(r.stdout.trim());
    if (!Number.isFinite(n)) {
      fail(`count(*) FROM ${t} returned non-numeric '${r.stdout.trim()}'`, exitCode);
    }
    out.set(t, n);
  }
  return out;
}

/**
 * Live-vs-restored row-count comparison. The smoke check above only
 * proves the restored tables are non-empty — it has no view of the
 * live source, so a 30-day-old dump or a dump where pg_dump silently
 * skipped a critical table will pass smoke happily. This step closes
 * that gap by reading expected counts from either a read-only live
 * Postgres conn (LIVE_COUNTS_URL) or a JSON manifest written by the
 * platform's pg_dump cron alongside the dump (LIVE_COUNTS_MANIFEST),
 * and asserting each restored count is within LIVE_COUNTS_MIN_RATIO
 * of the expected count.
 *
 * Failures exit 14 (STALE_DATA) — a separate code from 4-8 ("dump
 * corrupt") and from 6 ("dump file mtime stale") so on-call can
 * route the page distinctly. The fail() body names every offending
 * table and its absolute / percentage delta so on-call doesn't have
 * to dig through workflow logs.
 */
function checkLiveCounts(): void {
  const haveUrl = LIVE_COUNTS_URL !== undefined && LIVE_COUNTS_URL.length > 0;
  const haveManifest = LIVE_COUNTS_MANIFEST !== undefined && LIVE_COUNTS_MANIFEST.length > 0;
  if (!haveUrl && !haveManifest) {
    console.log(
      "[verifyBackup] LIVE_COUNTS_URL / LIVE_COUNTS_MANIFEST unset — skipping live-vs-restored " +
        "count comparison (set one to opt in; without it a stale or partial dump that's still " +
        "restorable will pass undetected)",
    );
    return;
  }
  if (haveUrl && haveManifest) {
    fail(
      "set only one of LIVE_COUNTS_URL or LIVE_COUNTS_MANIFEST (not both — the verifier " +
        "needs an unambiguous source of expected row counts)",
      EXIT.GENERIC,
    );
  }
  if (
    !Number.isFinite(LIVE_COUNTS_MIN_RATIO) ||
    LIVE_COUNTS_MIN_RATIO <= 0 ||
    LIVE_COUNTS_MIN_RATIO > 1
  ) {
    fail(
      `LIVE_COUNTS_MIN_RATIO must be a number in (0, 1] (got ${process.env.LIVE_COUNTS_MIN_RATIO})`,
      EXIT.GENERIC,
    );
  }

  let expected: Map<string, number>;
  let source: string;
  if (haveManifest) {
    let raw: string;
    try {
      raw = readFileSync(LIVE_COUNTS_MANIFEST!, "utf8");
    } catch (err) {
      fail(
        `cannot read LIVE_COUNTS_MANIFEST at ${LIVE_COUNTS_MANIFEST}: ${(err as Error).message}`,
        EXIT.STALE_DATA,
      );
    }
    try {
      expected = parseLiveCountsManifest(raw);
    } catch (err) {
      fail((err as Error).message, EXIT.STALE_DATA);
    }
    if (expected.size === 0) {
      fail(
        `live-counts manifest at ${LIVE_COUNTS_MANIFEST} is empty — refusing to "verify" zero ` +
          `tables (the manifest must list at least one table or the comparison is meaningless)`,
        EXIT.STALE_DATA,
      );
    }
    source = `manifest ${LIVE_COUNTS_MANIFEST}`;
  } else {
    if (LIVE_COUNTS_TABLES.length === 0) {
      fail(`LIVE_COUNTS_TABLES must list at least one table`, EXIT.GENERIC);
    }
    expected = queryCountsViaPsql(LIVE_COUNTS_URL!, LIVE_COUNTS_TABLES, EXIT.STALE_DATA);
    source = `live ${redactUrl(LIVE_COUNTS_URL!)}`;
  }

  const restored = queryCountsViaPsql(
    RESTORE_DATABASE_URL!,
    [...expected.keys()],
    EXIT.STALE_DATA,
  );
  const violations = evaluateLiveCounts(expected, restored, LIVE_COUNTS_MIN_RATIO);
  if (violations.length > 0) {
    const pct = (LIVE_COUNTS_MIN_RATIO * 100).toFixed(2);
    const lines = violations
      .map(
        (v) =>
          `${v.table}: restored=${v.restored} expected>=${Math.ceil(
            v.expected * LIVE_COUNTS_MIN_RATIO,
          )} (live=${v.expected}, ratio=${(v.ratio * 100).toFixed(2)}%, ` +
          `delta=${v.expected - v.restored})`,
      )
      .join("; ");
    fail(
      `restored row counts are stale or incomplete vs ${source} (threshold ${pct}%): ${lines}. ` +
        `The dump is restorable but its data is behind the live source — either the producer's ` +
        `pg_dump silently skipped these tables, or the dump itself was written days ago and ` +
        `never refreshed. Distinct from exit 6 (dump file mtime stale) because the file mtime ` +
        `can be fresh while the contents lag.`,
      EXIT.STALE_DATA,
    );
  }
  const summary = [...expected.entries()]
    .map(([t, n]) => `${t}=${restored.get(t) ?? 0}/${n}`)
    .join(", ");
  console.log(
    `[verifyBackup] live-counts OK vs ${source} (threshold ${(LIVE_COUNTS_MIN_RATIO * 100).toFixed(
      2,
    )}%): ${summary}`,
  );
}

/**
 * Week-over-week row-count drift comparison. The smoke check proves
 * the tables are non-empty and the live-counts check proves they
 * match the producer's manifest, but neither catches the case where
 * the producer's *own* dump regressed in lockstep with its manifest
 * (a partial pg_dump was published over the good one and the
 * manifest was regenerated against the partial dump - so live-counts
 * is satisfied even though the data has shrunk by orders of
 * magnitude vs last week's healthy baseline).
 *
 * This check persists `{timestamp, counts}` to a small JSON history
 * file (default `${BACKUP_DIR}/verify-row-counts-history.json`) on
 * every successful run, and on the next run compares the current
 * restored counts against the most recent prior entry. A drop above
 * WEEK_OVER_WEEK_MAX_DROP_RATIO on any tracked table exits 15.
 *
 * Failures intentionally DO NOT update the history file - rolling the
 * regressed counts forward would silently re-pass on the next run.
 * The page keeps firing until either the data is restored OR the
 * operator clears the history file to accept the new baseline.
 */
function checkWeekOverWeekDrop(): void {
  if (WEEK_OVER_WEEK_TABLES.length === 0) {
    fail(
      `WEEK_OVER_WEEK_TABLES must list at least one table (set ` +
        `WEEK_OVER_WEEK_MAX_DROP_RATIO=1 to disable the check entirely instead)`,
      EXIT.GENERIC,
    );
  }
  if (
    !Number.isFinite(WEEK_OVER_WEEK_MAX_DROP_RATIO) ||
    WEEK_OVER_WEEK_MAX_DROP_RATIO < 0 ||
    WEEK_OVER_WEEK_MAX_DROP_RATIO > 1
  ) {
    fail(
      `WEEK_OVER_WEEK_MAX_DROP_RATIO must be a number in [0, 1] ` +
        `(got ${process.env.WEEK_OVER_WEEK_MAX_DROP_RATIO})`,
      EXIT.GENERIC,
    );
  }
  if (
    !Number.isFinite(WEEK_OVER_WEEK_MAX_HISTORY) ||
    !Number.isInteger(WEEK_OVER_WEEK_MAX_HISTORY) ||
    WEEK_OVER_WEEK_MAX_HISTORY < 1
  ) {
    fail(
      `WEEK_OVER_WEEK_MAX_HISTORY must be a positive integer ` +
        `(got ${process.env.WEEK_OVER_WEEK_MAX_HISTORY})`,
      EXIT.GENERIC,
    );
  }

  const current = queryCountsViaPsql(
    RESTORE_DATABASE_URL!,
    WEEK_OVER_WEEK_TABLES,
    EXIT.WEEK_OVER_WEEK_DROP,
  );

  let history: WeekOverWeekHistoryFile = { version: 1, entries: [] };
  let raw: string | null = null;
  try {
    raw = readFileSync(WEEK_OVER_WEEK_HISTORY, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      fail(
        `cannot read week-over-week history at ${WEEK_OVER_WEEK_HISTORY}: ` +
          `${(err as Error).message}`,
        EXIT.WEEK_OVER_WEEK_DROP,
      );
    }
  }
  if (raw !== null) {
    try {
      history = parseWeekOverWeekHistory(raw);
    } catch (err) {
      fail(
        `${(err as Error).message}. Delete ${WEEK_OVER_WEEK_HISTORY} to reset the ` +
          `baseline if the file is genuinely corrupt (this re-arms the check on the ` +
          `next run with no comparison).`,
        EXIT.WEEK_OVER_WEEK_DROP,
      );
    }
  }

  const prior = history.entries[history.entries.length - 1];
  const currentSummary = WEEK_OVER_WEEK_TABLES.map((t) => `${t}=${current.get(t) ?? 0}`).join(
    ", ",
  );
  const pct = (WEEK_OVER_WEEK_MAX_DROP_RATIO * 100).toFixed(2);
  if (prior === undefined) {
    console.log(
      `[verifyBackup] no prior week-over-week history at ${WEEK_OVER_WEEK_HISTORY} ` +
        `— recording baseline (${currentSummary}); next run will compare against this.`,
    );
  } else {
    const priorMap = new Map(Object.entries(prior.counts));
    const drops = evaluateWeekOverWeekDrops(priorMap, current, WEEK_OVER_WEEK_MAX_DROP_RATIO);
    if (drops.length > 0) {
      const lines = drops
        .map(
          (d) =>
            `${d.table}: current=${d.current}, prior=${d.prior} ` +
            `(drop=${(d.dropRatio * 100).toFixed(2)}%, delta=${d.prior - d.current})`,
        )
        .join("; ");
      fail(
        `restored row counts dropped by more than ${pct}% vs prior verify run ` +
          `(timestamp=${prior.timestamp}): ${lines}. The dump is restorable and the ` +
          `smoke + live-counts checks passed, but the data has shrunk sharply since ` +
          `the last successful verify — strong signal a partial pg_dump was published ` +
          `over a good one. Distinct from exit 14 (live-vs-restored) because the ` +
          `producer's manifest / live source can ALSO regress in lockstep, leaving ` +
          `exit 14 happy. The history file ${WEEK_OVER_WEEK_HISTORY} is intentionally ` +
          `NOT updated on this exit so the page keeps firing until either the data ` +
          `is restored OR the operator clears the file to accept the new baseline.`,
        EXIT.WEEK_OVER_WEEK_DROP,
      );
    }
    const summary = WEEK_OVER_WEEK_TABLES.map(
      (t) => `${t}=${current.get(t) ?? 0} (was ${prior.counts[t] ?? "?"})`,
    ).join(", ");
    console.log(
      `[verifyBackup] week-over-week OK vs ${prior.timestamp} (max drop ${pct}%): ${summary}`,
    );
  }

  // Append + cap history. Atomic via temp + rename so a crash mid-write
  // doesn't leave a half-written file the next run cannot parse.
  const updated: WeekOverWeekHistoryFile = {
    version: 1,
    entries: [
      ...history.entries,
      {
        timestamp: new Date().toISOString(),
        counts: Object.fromEntries(current),
      },
    ].slice(-WEEK_OVER_WEEK_MAX_HISTORY),
  };
  const tmp = `${WEEK_OVER_WEEK_HISTORY}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(updated, null, 2) + "\n", "utf8");
    renameSync(tmp, WEEK_OVER_WEEK_HISTORY);
  } catch (err) {
    fail(
      `cannot write week-over-week history at ${WEEK_OVER_WEEK_HISTORY}: ` +
        `${(err as Error).message}. Without this file the next run cannot compare ` +
        `against the current baseline — either fix the directory permissions or ` +
        `set WEEK_OVER_WEEK_HISTORY to a writable path.`,
      EXIT.WEEK_OVER_WEEK_DROP,
    );
  }
}

function runVacuumAnalyze(): void {
  // VACUUM (ANALYZE) reads every heap page of every table, which is the
  // cheapest way to surface block-level corruption that pg_restore's
  // COPY replay didn't notice. ANALYZE updates stats so any follow-on
  // queries the operator runs locally aren't planned with stale stats.
  // VACUUM cannot run inside a transaction block, so use psql -c (which
  // implicitly autocommits) rather than wrapping in BEGIN/COMMIT.
  psqlInherit("VACUUM (ANALYZE);", EXIT.VACUUM_FAILED, "vacuum");
}

function runTableInventory(): void {
  // Per-table row counts for *every* user table, not just the three
  // smoke tables. The previous failure mode this catches: a partial
  // dump that includes the smoke tables but is missing other tables
  // (silent dump truncation), or a table that exists but is suddenly
  // empty when it shouldn't be.
  //
  // n_live_tup from pg_stat_user_tables is approximate but only requires
  // a single catalog query rather than a count(*) per table — important
  // because a real production DB can have hundreds of tables and a
  // count(*) per table multiplies the verify runtime by a lot. We just
  // ran VACUUM ANALYZE above, so the live-tup estimates are fresh.
  psqlInherit(
    "SELECT schemaname, relname, n_live_tup " +
      "FROM pg_stat_user_tables ORDER BY schemaname, relname;",
    EXIT.INVENTORY_FAILED,
    "inventory",
  );
}

function runAmcheck(): void {
  // Best-effort btree index validation via the `amcheck` contrib
  // extension. Two failure modes are intentionally distinguished:
  //
  //  - Extension cannot be installed (managed Postgres without
  //    superuser, base image without contrib): warn + return. The
  //    smoke + vacuum + inventory layers already cover the high-value
  //    cases for this script's purpose, and this is a sandbox-config
  //    issue, not a backup-quality issue.
  //  - Extension is installed and an index reports corruption:
  //    exit AMCHECK_FAILED. That's a real signal that the dump's index
  //    data is broken.
  //
  // We capture stderr here (not via inherit) so we can detect the
  // extension-missing case from psql's error stream and downgrade it.
  const create = spawnSync(
    "psql",
    [RESTORE_DATABASE_URL!, "-v", "ON_ERROR_STOP=1", "-X", "-c", "CREATE EXTENSION IF NOT EXISTS amcheck;"],
    { encoding: "utf8" },
  );
  if (create.status !== 0) {
    console.warn(
      `[verifyBackup] amcheck extension unavailable in sandbox (psql exit ${create.status}): ` +
        `${(create.stderr ?? "").trim()}. Skipping btree index validation; ` +
        `smoke + vacuum + inventory still ran.`,
    );
    return;
  }
  // bt_index_check vs bt_index_parent_check: we use the cheaper
  // bt_index_check (no AccessExclusiveLock, no parent-key cross-check).
  // Stronger than nothing, weak enough to run against a freshly
  // restored DB without monopolizing it. Iterate every btree index in
  // user schemas; a single corrupt index raises an ERROR, which
  // ON_ERROR_STOP turns into a non-zero psql exit -> exit AMCHECK_FAILED.
  const sql =
    "DO $$ DECLARE r record; BEGIN " +
    "FOR r IN SELECT c.oid::regclass AS idx " +
    "  FROM pg_index i " +
    "  JOIN pg_class c ON c.oid = i.indexrelid " +
    "  JOIN pg_am am ON am.oid = c.relam " +
    "  JOIN pg_namespace n ON n.oid = c.relnamespace " +
    "  WHERE am.amname = 'btree' " +
    "    AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast') " +
    "    AND i.indisvalid AND i.indisready " +
    "LOOP RAISE NOTICE 'bt_index_check %', r.idx; " +
    "PERFORM bt_index_check(r.idx); END LOOP; END $$;";
  psqlInherit(sql, EXIT.AMCHECK_FAILED, "amcheck");
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
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
  // "last week's data" as "this week's healthy state". Runs in both
  // modes: nightly stalls of the producer must page within ~36h, not
  // wait for the weekly fuller pass.
  checkFreshness(dump);

  // Checksum check next, *before* pg_restore. The whole point of this
  // step is to fail in seconds when the file we downloaded does not
  // match what the producer wrote (truncated transfer, silent S3
  // partial-read, on-disk bit flip on the runner) — pg_restore would
  // eventually surface a corrupt-dump error several minutes in, but
  // with a much less actionable message that on-call cannot
  // distinguish from a genuine schema-internal corruption. Skipped
  // with a notice when no sidecar manifest is present and
  // BACKUP_CHECKSUM_REQUIRED is not "1" (rollout default).
  await checkChecksum(dump);

  console.log(
    `[verifyBackup] mode=${mode} restoring ${dump.path} -> ${redactUrl(RESTORE_DATABASE_URL)}`,
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

  // Live-vs-restored row-count comparison. Runs in both modes (a stale
  // dump must page within ~24h, not wait for the weekly fuller pass)
  // and is opt-in — see the LIVE_COUNTS_URL / LIVE_COUNTS_MANIFEST
  // comment block at the top of this file. Sequenced after smoke so
  // the cheap "is the table even there / non-empty" failure mode trips
  // first; before extensions / FK / vacuum because if the *contents*
  // are stale, the deeper integrity checks would mis-attribute "last
  // month's data" as "this week's healthy state".
  checkLiveCounts();

  // Week-over-week row-count drift. Runs in both modes and is on by
  // default — catches the regression that smoke + live-counts both
  // miss when the producer regenerated the manifest off the same
  // partial dump (so live-counts is happy but the data has shrunk vs
  // last week's healthy baseline). Sequenced after live-counts so the
  // "absolute floor" failure mode trips first; before extensions / FK
  // because data shrinkage is a higher-signal page than a config or
  // integrity follow-on.
  checkWeekOverWeekDrop();

  // Extensions check runs in both modes — the "production app boots
  // against this sandbox" property is a smoke-grade invariant, and the
  // check itself is one fast catalog query.
  checkExtensions();

  if (mode === "full") {
    // Full-mode integrity layers, ordered cheap → expensive so a failure
    // earlier in the chain short-circuits before we spend minutes
    // streaming the audit log. FK integrity is a few catalog joins;
    // VACUUM ANALYZE walks every heap page; inventory is a single
    // catalog query but logged for human eyeballing; amcheck walks
    // every btree; audit-chain replay streams the entire audit_events
    // table and recomputes a sha256 per row.
    checkFkIntegrity();
    runVacuumAnalyze();
    runTableInventory();
    runAmcheck();
    checkAuditChain();
  }

  console.log(`[verifyBackup] OK (mode=${mode})`);
}

// Gate the entry point so importing this module from a test (or any
// other consumer) doesn't blow up by trying to read RESTORE_DATABASE_URL
// and shell out to psql. Mirrors the pattern used by the other scripts
// in this directory (e.g. checkRateLimitOptOutSunsets).
const isDirectInvocation =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /verifyBackup(\.[mc]?[jt]s)?$/.test(process.argv[1]);

if (isDirectInvocation) {
  // main() is async because checkChecksum streams the dump file. Catch
  // any unexpected rejection so the process exits non-zero with the
  // generic code rather than silently swallowing the error.
  main().catch((err: unknown) => {
    fail(`unexpected error: ${(err as Error).message ?? String(err)}`, EXIT.GENERIC);
  });
}
