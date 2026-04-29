/**
 * In-prod scheduled audit-chain integrity verifier.
 *
 * Why this exists (task #106):
 *
 * `lib/audit.ts` exports `verifyAuditChain(fromSeq=0)` which returns the
 * `seq` of the first tampered/broken row, or `null` when the chain is
 * intact. Until now the only thing that ran it against real data was the
 * weekly backup-verify drill (`scripts/src/verifyBackup.ts` exit code 8,
 * see `docs/runbooks/backup-verify.md`), which replays it against a
 * restored sandbox dump. That weekly cadence means in-place tampering
 * with the live `audit_events` table — the kind the append-only DB
 * triggers in `lib/audit.ts` are designed to make impossible — could
 * theoretically go undetected for up to a week between drills (and the
 * weekly drill only sees the chain *after* the last `pg_dump`, so a
 * tamper-then-redump sequence might not surface in the next run at all).
 *
 * This module closes that gap with a lightweight in-prod loop that
 * runs `verifyAuditChain()` against the **live DB** every few hours
 * and pages on a non-null result. The pager surface intentionally
 * routes to the same audit/compliance owners that exit 8 of
 * verifyBackup.ts pages — see the "Audit / compliance owners" routing
 * tip in `docs/runbooks/backup-verify.md`. We achieve that by:
 *
 *   1. `captureMessage("audit_chain_tamper_detected", { level: "fatal",
 *      tags: { subsystem: "auditChain", check: "verifyAuditChain" },
 *      fingerprint: ["audit_chain_tamper_detected"] })`. The audit /
 *      compliance owners' Sentry alert routing rule is keyed off the
 *      `subsystem=auditChain` tag + the `audit_chain_tamper_detected`
 *      fingerprint so this lands in their on-call queue in the same
 *      shape as the exit-8 missed-check-in page would.
 *   2. Tripping `auditChainVerifyHealthWatcher` so /healthz exposes the
 *      streak under `subsystems.auditChainVerify` and the existing
 *      duration probe (`scripts/checkHealthzDegraded.ts`) keeps paging
 *      until an operator manually intervenes — there is no automatic
 *      recovery from a chain break (a broken chain stays broken until
 *      a forensic reset). A subsequent successful verify only closes
 *      the in-memory streak; the captureMessage event remains in
 *      Sentry as the audit trail.
 *
 * The same code path also backs the admin-only `POST /internal/audit-
 * chain/verify` endpoint, which lets an operator force an immediate
 * verify (e.g. after a suspected DB restore, before/after maintenance,
 * or when investigating a Sentry alert). Sharing the implementation
 * means the on-demand probe has the exact same paging semantics as
 * the scheduled one.
 *
 * Failure semantics on a *probe error* (DB unreachable, query timeout)
 * mirror `auditDlqMonitor.ts`: log at warn, store `lastVerifyError`,
 * but do NOT trip the watcher. Conflating "we couldn't measure the
 * chain" with "the chain is broken" would erode the alert's signal,
 * and the dbHealthWatcher already pages on the underlying DB outage
 * via /readyz on a separate channel.
 */

import { logger } from "./logger";
import { verifyAuditChain } from "./audit";
import { captureMessage } from "./sentry";
import { SubsystemFailureWatcher, type SubsystemSnapshot } from "./subsystemHealth";

const DEFAULT_VERIFY_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const MIN_VERIFY_INTERVAL_MS = 60_000; // 1 minute floor — sub-minute cadence would slam the DB

/**
 * Snapshot returned to /healthz. Extends the standard SubsystemSnapshot
 * shape (so the duration probe can iterate every subsystem uniformly)
 * with the verifier-specific fields a human looking at /healthz will
 * want during an incident — when we last verified, how long it took,
 * the offending seq if any, and the configured cadence.
 */
export interface AuditChainVerifierSnapshot extends SubsystemSnapshot {
  /** ms-epoch of the last successful or attempted verify, or null when
   *  no verify has run yet (boot before the first tick fired). */
  lastVerifiedAt: number | null;
  /** Wall-clock duration of the last attempted verify in ms, or null
   *  when no verify has run yet. Surfaced so an operator can see
   *  whether the chain is so large the next probe risks overlapping
   *  the previous one. */
  lastDurationMs: number | null;
  /** Most recent offending seq from `verifyAuditChain`, or null when
   *  the most recent verify was clean. Sticky across the operator's
   *  in-memory session — when a clean verify follows a tamper detection
   *  this flips back to null AND `lastRecoveredAt` is stamped. */
  lastOffendingSeq: number | null;
  /** Error message from the last verify if it failed; null on success.
   *  Surfaced so an operator can tell apart "chain is fine" from "we
   *  couldn't measure the chain" — distinct triage paths (the latter
   *  is a DB-pool problem, the former is a security incident). */
  lastVerifyError: string | null;
  /** Configured `AUDIT_CHAIN_VERIFY_INTERVAL_MS` — surfaced so a human
   *  looking at /healthz doesn't have to know the env-var convention. */
  intervalMs: number;
}

/**
 * Singleton failure-streak watcher for the audit-chain verifier. Wired
 * into /healthz under `subsystems.auditChainVerify`. Driven exclusively
 * by `runAuditChainVerification()` — never by per-call code. A non-null
 * offending seq trips it; a null result closes the streak; a probe
 * error does NOT touch it (see file header).
 */
export const auditChainVerifyHealthWatcher = new SubsystemFailureWatcher();

let lastVerifiedAt: number | null = null;
let lastDurationMs: number | null = null;
let lastOffendingSeq: number | null = null;
let lastVerifyError: string | null = null;
let pollerHandle: ReturnType<typeof setInterval> | null = null;

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  minValue: number,
): number {
  // Mirrors the env-var sanitisation in auditDlqMonitor.ts /
  // routes/health.ts: missing, non-numeric, zero, or sub-minimum
  // values fall back to a safe default rather than turning the alert
  // into either a flapping page or a permanently-silent one.
  const n = raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(n) || n < minValue) return fallback;
  return Math.floor(n);
}

export function getAuditChainVerifyIntervalMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return parsePositiveInt(
    env.AUDIT_CHAIN_VERIFY_INTERVAL_MS,
    DEFAULT_VERIFY_INTERVAL_MS,
    MIN_VERIFY_INTERVAL_MS,
  );
}

/**
 * Source of a verify run. Threaded into the structured log + the
 * Sentry `extra` so on-call can tell apart a scheduled tick from an
 * operator-triggered admin probe when triaging a tamper alert.
 */
export type AuditChainVerifySource = "scheduled" | "admin-endpoint" | "boot";

/**
 * Result of a single verify run. Returned by both the scheduled tick
 * and the admin endpoint so the HTTP response carries the same shape
 * the snapshot does.
 */
export interface AuditChainVerifyResult {
  ok: boolean;
  /** The first broken seq when the chain is tampered, null when intact,
   *  or null when the verify itself errored (in which case `error` is
   *  non-null). */
  offendingSeq: number | null;
  durationMs: number;
  /** Wall-clock when the verify completed (ms epoch). */
  verifiedAt: number;
  /** Error message when the verify itself errored (DB unreachable,
   *  etc.); null on a successful probe regardless of chain status. */
  error: string | null;
}

/**
 * Run a single verify pass against the live DB. Updates the watcher
 * (open/close the streak) and the cached snapshot fields, and pages
 * audit/compliance owners via `captureMessage` + structured log on a
 * tamper detection.
 *
 * Exported for unit tests AND for the admin endpoint — sharing the
 * implementation guarantees the on-demand probe has the same paging
 * semantics as the scheduled one.
 */
export async function runAuditChainVerification(
  now: number = Date.now(),
  source: AuditChainVerifySource = "scheduled",
): Promise<AuditChainVerifyResult> {
  const startedAt = now;
  let durationMs = 0;
  try {
    const offending = await verifyAuditChain(0);
    durationMs = Date.now() - startedAt;
    lastVerifiedAt = now;
    lastDurationMs = durationMs;
    lastVerifyError = null;
    if (offending !== null) {
      lastOffendingSeq = offending;
      auditChainVerifyHealthWatcher.record(now);
      // Structured log first so the audit trail is in the log
      // aggregator regardless of whether Sentry is reachable.
      logger.error(
        {
          offendingSeq: offending,
          source,
          durationMs,
        },
        "audit_chain_tamper_detected",
      );
      // Page audit/compliance owners. Fatal level fires Sentry's
      // default new-issue alert rule on the first event; the stable
      // fingerprint groups every subsequent detection (scheduled
      // re-detection of the same tamper, admin re-probe, etc.) into
      // the same Sentry issue so the page doesn't re-fire on every
      // tick. The `subsystem=auditChain` + `check=verifyAuditChain`
      // tags are what the audit/compliance routing rule keys off —
      // mirroring exit 8 of verifyBackup.ts in the runbook routing
      // table.
      captureMessage("audit_chain_tamper_detected", {
        level: "fatal",
        tags: {
          subsystem: "auditChain",
          check: "verifyAuditChain",
          source,
        },
        fingerprint: ["audit_chain_tamper_detected"],
        extra: {
          offendingSeq: offending,
          durationMs,
          verifiedAt: now,
        },
      });
      return {
        ok: false,
        offendingSeq: offending,
        durationMs,
        verifiedAt: now,
        error: null,
      };
    }
    lastOffendingSeq = null;
    auditChainVerifyHealthWatcher.recordSuccess(now);
    return {
      ok: true,
      offendingSeq: null,
      durationMs,
      verifiedAt: now,
      error: null,
    };
  } catch (err) {
    durationMs = Date.now() - startedAt;
    const msg = (err as Error).message;
    lastVerifyError = msg;
    lastVerifiedAt = now;
    lastDurationMs = durationMs;
    logger.warn(
      { err: msg, source, durationMs },
      "audit_chain_verify_failed",
    );
    // Intentionally do NOT call watcher.record() on a probe error:
    // see the file header for why.
    return {
      ok: false,
      offendingSeq: null,
      durationMs,
      verifiedAt: now,
      error: msg,
    };
  }
}

/**
 * Read the current /healthz snapshot for the audit-chain verifier
 * subsystem. Pure read — does not trigger a verify.
 */
export function getAuditChainVerifierSnapshot(
  env: NodeJS.ProcessEnv = process.env,
): AuditChainVerifierSnapshot {
  return {
    ...auditChainVerifyHealthWatcher.getSnapshot(),
    lastVerifiedAt,
    lastDurationMs,
    lastOffendingSeq,
    lastVerifyError,
    intervalMs: getAuditChainVerifyIntervalMs(env),
  };
}

/**
 * Boot-time hook: kick off the periodic verify. Idempotent — a second
 * call is a no-op so a future refactor that calls this from multiple
 * boot paths can't double-schedule the interval.
 *
 * The first verify runs after a 5-minute boot stagger so we don't
 * pile a full-table scan on top of every other init/migration that
 * `app.ts` fires at boot. Every `AUDIT_CHAIN_VERIFY_INTERVAL_MS`
 * thereafter (default 4h). The interval handle is `unref()`'d so it
 * doesn't keep the process alive on its own.
 */
export function startAuditChainVerifier(): void {
  if (pollerHandle) return;
  const intervalMs = getAuditChainVerifyIntervalMs();
  const BOOT_STAGGER_MS = 5 * 60 * 1000;
  // Stagger the first verify so the boot path doesn't have a cold-
  // cache full-chain scan racing the rest of the schema/seed init.
  setTimeout(() => {
    void runAuditChainVerification(Date.now(), "boot").catch((err) =>
      logger.error(
        { err: (err as Error).message },
        "audit_chain_verifier_initial_run_failed",
      ),
    );
  }, BOOT_STAGGER_MS);
  pollerHandle = setInterval(() => {
    void runAuditChainVerification(Date.now(), "scheduled").catch((err) =>
      logger.error(
        { err: (err as Error).message },
        "audit_chain_verifier_tick_failed",
      ),
    );
  }, intervalMs);
  pollerHandle.unref?.();
  logger.info(
    { intervalMs, bootStaggerMs: BOOT_STAGGER_MS },
    "audit_chain_verifier_started",
  );
}

/**
 * Test-only: stop the interval (if running) and reset all cached
 * snapshot fields plus the watcher streak. Lets each test case start
 * from a clean state without spinning up a fresh module instance.
 */
export function __resetAuditChainVerifierForTests(): void {
  if (pollerHandle) {
    clearInterval(pollerHandle);
    pollerHandle = null;
  }
  auditChainVerifyHealthWatcher.__reset();
  lastVerifiedAt = null;
  lastDurationMs = null;
  lastOffendingSeq = null;
  lastVerifyError = null;
}
