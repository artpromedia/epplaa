import { lt, and, isNotNull, sql } from "drizzle-orm";
import { metrics } from "@opentelemetry/api";
import { db, schema } from "./db";
import { logger } from "./logger";
import { applyErase } from "./ndpr";
import {
  type SubsystemSnapshot,
} from "./subsystemHealth";

/**
 * Retention schedule (Epplaa privacy policy v4.1 §11.1.4):
 * - Notifications outbox: 90 days, then archive (delete here = archive in dev).
 * - Recently viewed: 90 days.
 * - Recent searches: 90 days.
 * - Cart items: 180 days idle.
 * - Rate-limit events: 90 days (forensic trail for 429 bursts; useful for
 *   post-incident investigation but not for long-term audit, so the table
 *   is bounded so it doesn't grow forever).
 * - Audit events: 7 years (NEVER deleted by this sweep).
 * - Payments / payouts / orders: 7 years (NEVER deleted by this sweep).
 * - User PII: purged once an erase request becomes effective AND the
 *   user has been flagged `dataDeletedAt` for 30 days (final purge).
 */
const NOTIFICATION_RETENTION_MS = 90 * 24 * 3600 * 1000;
const VIEW_HISTORY_RETENTION_MS = 90 * 24 * 3600 * 1000;
const SEARCH_HISTORY_RETENTION_MS = 90 * 24 * 3600 * 1000;
const FINAL_PURGE_AFTER_ERASE_MS = 30 * 24 * 3600 * 1000;

/**
 * Default window for the `rate_limit_events` forensic table. 90 days is
 * long enough to investigate a credential-stuffing burst noticed weeks
 * after the fact, short enough to keep the table small and its
 * (identity, ts) / (route, ts) indexes hot.
 *
 * Overridable via `RATE_LIMIT_EVENTS_RETENTION_DAYS` (positive integer).
 * Invalid values fall back to the default with a warning so a typo in
 * the env doesn't silently disable trimming.
 */
export const DEFAULT_RATE_LIMIT_EVENTS_RETENTION_DAYS = 90;

function configuredRateLimitEventsRetentionMs(): number {
  const raw = process.env.RATE_LIMIT_EVENTS_RETENTION_DAYS;
  if (!raw) return DEFAULT_RATE_LIMIT_EVENTS_RETENTION_DAYS * 24 * 3600 * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    logger.warn(
      { value: raw },
      "rate_limit_events_retention_days_invalid_using_default",
    );
    return DEFAULT_RATE_LIMIT_EVENTS_RETENTION_DAYS * 24 * 3600 * 1000;
  }
  return Math.floor(n) * 24 * 3600 * 1000;
}

/**
 * Operational alerting window for the daily retention sweep.
 *
 * The retention engine ticks once every 24h (see `startScheduledJobs`
 * in `app.ts`). 36h gives us one full missed cycle plus a small grace
 * window — enough that a single late tick (e.g. a long redeploy or
 * an unhandled rejection in a sibling tick that delays the next
 * `setInterval` callback) doesn't page on-call, but a permanently
 * stopped scheduler is caught well before the trimmed tables grow
 * out of control or NDPR final-erase SLAs are missed.
 *
 * Surfaced as `subsystems.retention` on `/healthz`: if the most
 * recent successful sweep is older than this window, the snapshot
 * flips to `state: "degraded"` with `firstFailureAt` set to the
 * moment the heartbeat aged out, so the existing duration-based
 * `checkHealthzDegraded` probe pages on it the same way it pages
 * on a stuck DB / rate-limit / audit-chain streak — no new alert
 * surface to wire up.
 */
export const RETENTION_HEARTBEAT_STALE_MS = 36 * 3600 * 1000;

/**
 * Per-arm heartbeat. `arm: "sweep"` is the synthetic overall arm —
 * recorded at the end of every `runRetentionSweep` invocation,
 * regardless of whether individual arms threw, so its `lastRunAt`
 * answers the question "is the daily timer still firing at all?".
 * Per-arm heartbeats (`notifications`, `view_history`, ...) are only
 * recorded on a successful run of that arm so a permanently-broken
 * arm stays visibly stale even if the rest of the sweep is healthy.
 */
export interface RetentionHeartbeat {
  arm: string;
  lastRunAt: Date;
  lastCount: number;
  lastError: string | null;
}

/**
 * In-memory cache of the most recent heartbeat per arm. Primed from
 * the `retention_heartbeats` table on boot via `initRetentionSchema`
 * so a fresh process restart doesn't immediately false-alert "no
 * sweep in 36h" on a deploy that happened to land between scheduled
 * ticks. Updated synchronously after each arm completes; the OTel
 * observable gauges read from this map at observation time.
 */
const heartbeats: Map<string, RetentionHeartbeat> = new Map();

/**
 * Process-start timestamp used as the floor for the "no sweep yet"
 * grace window — see `getRetentionSubsystemSnapshot`. Captured at
 * module load so there's a single, stable reference even when the
 * sweep timer first runs ~150s after boot. Reset by
 * `__resetRetentionStateForTests` so unit tests can drive the
 * grace-window logic deterministically.
 */
let processStartedAtMs = Date.now();

const ARM_NAMES = [
  "notifications",
  "view_history",
  "search_history",
  "rate_limit_events",
  "erases",
] as const;
const SWEEP_ARM = "sweep";

/**
 * Boot-time bootstrap for the retention heartbeat table. Mirrors the
 * `initAuditChain` / `initSecuritySchema` / `initManufacturerSchema`
 * pattern: idempotent additive SQL (`CREATE TABLE IF NOT EXISTS`)
 * executed at boot, NOT via a destructive `drizzle-kit push --force`.
 *
 * Also primes the in-memory heartbeat cache from whatever the previous
 * process left in the table so a redeploy doesn't reset the freshness
 * window — the operational alert needs to track wall-clock time since
 * the last sweep, not "time since this replica booted".
 */
export async function initRetentionSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS retention_heartbeats (
      arm text PRIMARY KEY,
      last_run_at timestamptz NOT NULL,
      last_count integer NOT NULL DEFAULT 0,
      last_error text
    );
  `);
  try {
    const result = await db.execute(
      sql`SELECT arm, last_run_at, last_count, last_error FROM retention_heartbeats;`,
    );
    const rows =
      (result as unknown as {
        rows?: Array<{
          arm: string;
          last_run_at: string | Date;
          last_count: number | string;
          last_error: string | null;
        }>;
      }).rows ?? [];
    for (const row of rows) {
      const lastRunAt =
        row.last_run_at instanceof Date
          ? row.last_run_at
          : new Date(row.last_run_at);
      heartbeats.set(row.arm, {
        arm: row.arm,
        lastRunAt,
        lastCount: Number(row.last_count) || 0,
        lastError: row.last_error,
      });
    }
  } catch (err) {
    // Non-fatal: the freshness check will simply use the empty cache
    // and rely on the post-boot grace window until the first sweep
    // populates a heartbeat. We don't want a transient read failure
    // here to crash-loop the api-server.
    logger.warn(
      { err: (err as Error).message },
      "retention_heartbeats_load_failed",
    );
  }
}

/**
 * Persist + cache a heartbeat for a single arm. Failure to write to
 * the DB is logged but never thrown — the in-memory cache still gets
 * updated so /healthz and the OTel gauges reflect the latest tick
 * even if the heartbeat table is temporarily unwritable.
 */
async function recordHeartbeat(
  arm: string,
  count: number,
  error: string | null,
  now: Date,
): Promise<void> {
  heartbeats.set(arm, { arm, lastRunAt: now, lastCount: count, lastError: error });
  try {
    await db.execute(sql`
      INSERT INTO retention_heartbeats (arm, last_run_at, last_count, last_error)
      VALUES (${arm}, ${now}, ${count}, ${error})
      ON CONFLICT (arm) DO UPDATE SET
        last_run_at = EXCLUDED.last_run_at,
        last_count = EXCLUDED.last_count,
        last_error = EXCLUDED.last_error;
    `);
  } catch (err) {
    logger.warn(
      { arm, err: (err as Error).message },
      "retention_heartbeat_write_failed",
    );
  }
}

/**
 * Read-only snapshot for /healthz. Returns the canonical
 * `SubsystemSnapshot` shape so the duration-based stuck-degraded
 * probe (`scripts/checkHealthzDegraded.ts`) treats it identically
 * to the rate-limit / DB / audit-chain snapshots.
 *
 * Semantics:
 *  - No `sweep` heartbeat at all: report healthy for the first
 *    `RETENTION_HEARTBEAT_STALE_MS` after process start (grace window
 *    so a fresh deploy doesn't immediately page), then degraded with
 *    `firstFailureAt = processStartedAt + STALE_MS`.
 *  - `sweep` heartbeat older than `RETENTION_HEARTBEAT_STALE_MS`:
 *    report degraded with `firstFailureAt = lastRunAt + STALE_MS`
 *    so the duration probe's threshold acts as a small grace tail
 *    on top of the 36h window.
 *  - Otherwise: report healthy with `lastRecoveredAt = lastRunAt`
 *    so dashboards can timeline the most recent successful tick.
 */
export function getRetentionSubsystemSnapshot(
  now: number = Date.now(),
): SubsystemSnapshot {
  const sweep = heartbeats.get(SWEEP_ARM);
  if (!sweep) {
    const stalenessThresholdAt = processStartedAtMs + RETENTION_HEARTBEAT_STALE_MS;
    if (now > stalenessThresholdAt) {
      return {
        state: "degraded",
        failureCount: 1,
        firstFailureAt: stalenessThresholdAt,
        lastRecoveredAt: null,
      };
    }
    return {
      state: "healthy",
      failureCount: 0,
      firstFailureAt: null,
      lastRecoveredAt: null,
    };
  }
  const lastRunAtMs = sweep.lastRunAt.getTime();
  const stalenessThresholdAt = lastRunAtMs + RETENTION_HEARTBEAT_STALE_MS;
  if (now > stalenessThresholdAt) {
    return {
      state: "degraded",
      failureCount: 1,
      firstFailureAt: stalenessThresholdAt,
      lastRecoveredAt: lastRunAtMs,
    };
  }
  return {
    state: "healthy",
    failureCount: 0,
    firstFailureAt: null,
    lastRecoveredAt: lastRunAtMs,
  };
}

/**
 * Snapshot of every recorded arm. Primarily for tests + debug
 * tooling; the production /healthz surface only consumes the overall
 * `sweep` snapshot via `getRetentionSubsystemSnapshot`.
 */
export function getRetentionHeartbeats(): RetentionHeartbeat[] {
  return Array.from(heartbeats.values()).map((hb) => ({ ...hb }));
}

/**
 * OpenTelemetry observable gauges. Registered once at module load.
 * When no MeterProvider is wired (the dev-time default — see
 * `lib/otel.ts`), `metrics.getMeter` returns a NoopMeter and
 * createObservableGauge / addCallback are no-ops, so this is safe
 * to register unconditionally.
 *
 * Gauge semantics:
 *  - `epplaa_retention_seconds_since_last_run{arm}` — wall-clock
 *    seconds since the arm last completed. The "no sweep in >36h"
 *    alert can be expressed as
 *    `epplaa_retention_seconds_since_last_run{arm="sweep"} > 129600`.
 *  - `epplaa_retention_last_count{arm}` — number of rows the arm
 *    trimmed (or erases finalised) on its last run. Spikes here are
 *    the visible signal of the kind of "rateLimitEventsTrimmed
 *    suddenly 100x baseline" outlier called out in the task.
 *  - `epplaa_retention_last_error{arm}` — 0 on the most recent
 *    success, 1 if the arm errored on its last attempt. A monotonic
 *    `1` value across many ticks pages on "this arm is stuck" while
 *    the other arms continue to publish a fresh heartbeat.
 */
const meter = metrics.getMeter("epplaa-retention");
const secondsSinceLastRunGauge = meter.createObservableGauge(
  "epplaa_retention_seconds_since_last_run",
  {
    description:
      "Wall-clock seconds since the retention sweep arm last completed.",
    unit: "s",
  },
);
secondsSinceLastRunGauge.addCallback((observer) => {
  const now = Date.now();
  for (const hb of heartbeats.values()) {
    observer.observe((now - hb.lastRunAt.getTime()) / 1000, { arm: hb.arm });
  }
});
const lastCountGauge = meter.createObservableGauge(
  "epplaa_retention_last_count",
  {
    description:
      "Rows the retention sweep arm trimmed (or erases finalised) on its last run.",
  },
);
lastCountGauge.addCallback((observer) => {
  for (const hb of heartbeats.values()) {
    observer.observe(hb.lastCount, { arm: hb.arm });
  }
});
const lastErrorGauge = meter.createObservableGauge(
  "epplaa_retention_last_error",
  {
    description:
      "1 if the retention sweep arm errored on its last attempt, 0 on success.",
  },
);
lastErrorGauge.addCallback((observer) => {
  for (const hb of heartbeats.values()) {
    observer.observe(hb.lastError === null ? 0 : 1, { arm: hb.arm });
  }
});

export async function runRetentionSweep(): Promise<{
  notificationsTrimmed: number;
  viewHistoryTrimmed: number;
  searchHistoryTrimmed: number;
  rateLimitEventsTrimmed: number;
  erasesFinalised: number;
}> {
  const now = Date.now();
  let notificationsTrimmed = 0;
  let viewHistoryTrimmed = 0;
  let searchHistoryTrimmed = 0;
  let rateLimitEventsTrimmed = 0;
  let erasesFinalised = 0;

  // Track per-arm errors so we can stamp `last_error` on the heartbeat
  // for the arm that failed AND keep recording successful heartbeats
  // for arms that completed in the same tick. A single failing arm
  // must NOT silently mask the others' freshness — that's the entire
  // reason per-arm heartbeats exist.
  let notificationsErr: string | null = null;
  let viewHistoryErr: string | null = null;
  let searchHistoryErr: string | null = null;
  let rateLimitEventsErr: string | null = null;
  let erasesErr: string | null = null;

  // 1. Notifications outbox older than 90 days.
  try {
    const cutoff = new Date(now - NOTIFICATION_RETENTION_MS);
    const result = await db
      .delete(schema.notificationsOutboxTable)
      .where(lt(schema.notificationsOutboxTable.createdAt, cutoff))
      .returning({ id: schema.notificationsOutboxTable.id });
    notificationsTrimmed = result.length;
  } catch (err) {
    notificationsErr = (err as Error).message;
    logger.error({ err: notificationsErr }, "retention_notifications_failed");
  }

  // 2. Recently viewed older than 90 days.
  try {
    const cutoff = new Date(now - VIEW_HISTORY_RETENTION_MS);
    const result = await db
      .delete(schema.recentlyViewedTable)
      .where(lt(schema.recentlyViewedTable.viewedAt, cutoff))
      .returning({ userId: schema.recentlyViewedTable.userId });
    viewHistoryTrimmed = result.length;
  } catch (err) {
    viewHistoryErr = (err as Error).message;
    logger.error({ err: viewHistoryErr }, "retention_view_history_failed");
  }

  // 3. Recent searches older than 90 days.
  try {
    const cutoff = new Date(now - SEARCH_HISTORY_RETENTION_MS);
    const result = await db
      .delete(schema.recentSearchesTable)
      .where(lt(schema.recentSearchesTable.searchedAt, cutoff))
      .returning({ userId: schema.recentSearchesTable.userId });
    searchHistoryTrimmed = result.length;
  } catch (err) {
    searchHistoryErr = (err as Error).message;
    logger.error({ err: searchHistoryErr }, "retention_search_history_failed");
  }

  // 4. Rate-limit forensic events older than the configured window.
  // Raw SQL because `rate_limit_events` is bootstrapped via
  // `initSecuritySchema` (additive CREATE TABLE IF NOT EXISTS) rather
  // than a Drizzle table definition, so there's no schema object to
  // target with the query builder. The (identity, ts DESC) and
  // (route, ts DESC) indexes mean the cutoff scan is fast even on a
  // table that's allowed to accrue 90 days of bursts.
  try {
    const cutoff = new Date(now - configuredRateLimitEventsRetentionMs());
    // No RETURNING clause: this table was previously unbounded, so the
    // first sweep after deploy can match a very large backlog and we
    // don't want to materialise every deleted id just to count them.
    // node-postgres reliably exposes the affected-row count on the
    // DELETE result, which is all we need for the log line.
    const result = await db.execute(
      sql`DELETE FROM rate_limit_events WHERE ts < ${cutoff};`,
    );
    const rowCount = (result as { rowCount?: number | null }).rowCount;
    rateLimitEventsTrimmed = rowCount ?? 0;
  } catch (err) {
    rateLimitEventsErr = (err as Error).message;
    logger.error(
      { err: rateLimitEventsErr },
      "retention_rate_limit_events_failed",
    );
  }

  // 5. Final-purge users whose erase has been effective > 30 days. Some
  // identifying fields (email/phone) are left as the erase placeholder so
  // FK references in orders remain valid for FIRS retention; we further
  // null out display name + addresses.
  try {
    const cutoff = new Date(now - FINAL_PURGE_AFTER_ERASE_MS);
    const due = await db
      .select({ clerkId: schema.usersTable.clerkId })
      .from(schema.usersTable)
      .where(
        and(
          isNotNull(schema.usersTable.dataDeletedAt),
          lt(schema.usersTable.dataDeletedAt, cutoff),
        ),
      );
    for (const row of due) {
      await applyErase(row.clerkId);
      erasesFinalised++;
    }
  } catch (err) {
    erasesErr = (err as Error).message;
    logger.error({ err: erasesErr }, "retention_final_purge_failed");
  }

  // Heartbeat writes happen after every arm finishes so a partially-
  // failed sweep still updates the arms that succeeded. Per-arm
  // heartbeats with `last_error = NULL` prove that arm completed; the
  // overall `sweep` heartbeat further down proves the scheduler
  // itself is still firing even on a tick where every arm errored.
  //
  // We deliberately do NOT skip the heartbeat for an arm that errored
  // — instead we record `last_error` on it so dashboards can show
  // "last attempted at X, last error Y". Skipping would conflate
  // "arm hasn't been attempted recently" with "arm is broken", and
  // the staleness alert (sweep-arm only) handles the former.
  const heartbeatNow = new Date();
  await recordHeartbeat(
    "notifications",
    notificationsTrimmed,
    notificationsErr,
    heartbeatNow,
  );
  await recordHeartbeat(
    "view_history",
    viewHistoryTrimmed,
    viewHistoryErr,
    heartbeatNow,
  );
  await recordHeartbeat(
    "search_history",
    searchHistoryTrimmed,
    searchHistoryErr,
    heartbeatNow,
  );
  await recordHeartbeat(
    "rate_limit_events",
    rateLimitEventsTrimmed,
    rateLimitEventsErr,
    heartbeatNow,
  );
  await recordHeartbeat("erases", erasesFinalised, erasesErr, heartbeatNow);
  // Overall sweep heartbeat: stamp unconditionally so
  // `subsystems.retention.lastRecoveredAt` reflects "the daily timer
  // is still firing" even if every arm threw on this tick. The arms'
  // own error states are visible via their per-arm heartbeats and
  // the `epplaa_retention_last_error{arm}` gauge.
  const totalTrimmed =
    notificationsTrimmed +
    viewHistoryTrimmed +
    searchHistoryTrimmed +
    rateLimitEventsTrimmed +
    erasesFinalised;
  await recordHeartbeat(SWEEP_ARM, totalTrimmed, null, heartbeatNow);

  // Always log a concrete summary so log-based metrics + dashboards
  // can pick up the per-arm counts even on quiet ticks where nothing
  // was trimmed. The previous implementation skipped the log line on
  // a zero-count sweep, which made it impossible to distinguish "the
  // sweep ran and there was nothing to do" from "the sweep didn't
  // run at all" — exactly the gap this task closes.
  logger.info(
    {
      notificationsTrimmed,
      viewHistoryTrimmed,
      searchHistoryTrimmed,
      rateLimitEventsTrimmed,
      erasesFinalised,
      notificationsErr,
      viewHistoryErr,
      searchHistoryErr,
      rateLimitEventsErr,
      erasesErr,
    },
    "retention_sweep_completed",
  );
  return {
    notificationsTrimmed,
    viewHistoryTrimmed,
    searchHistoryTrimmed,
    rateLimitEventsTrimmed,
    erasesFinalised,
  };
}

/**
 * Test-only: clear the heartbeat cache and reset the process-start
 * floor so unit tests can drive `getRetentionSubsystemSnapshot`'s
 * grace-window logic deterministically without spinning a fresh
 * Node process for every case.
 */
export function __resetRetentionStateForTests(now: number = Date.now()): void {
  heartbeats.clear();
  processStartedAtMs = now;
}

/**
 * Test-only: seed a heartbeat directly into the in-memory cache,
 * bypassing the DB write path. Used by the route-level /healthz
 * tests to assert the subsystem snapshot under both fresh and stale
 * conditions without standing up Postgres.
 */
export function __seedHeartbeatForTests(
  arm: string,
  lastRunAt: Date,
  lastCount = 0,
  lastError: string | null = null,
): void {
  heartbeats.set(arm, { arm, lastRunAt, lastCount, lastError });
}

/** Test-only: list the arm names the sweep records heartbeats for. */
export const __ARM_NAMES_FOR_TESTS: readonly string[] = [...ARM_NAMES, SWEEP_ARM];
