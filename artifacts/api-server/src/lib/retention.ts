import { lt, and, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "./db";
import { logger } from "./logger";
import { applyErase } from "./ndpr";

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

  // 1. Notifications outbox older than 90 days.
  try {
    const cutoff = new Date(now - NOTIFICATION_RETENTION_MS);
    const result = await db
      .delete(schema.notificationsOutboxTable)
      .where(lt(schema.notificationsOutboxTable.createdAt, cutoff))
      .returning({ id: schema.notificationsOutboxTable.id });
    notificationsTrimmed = result.length;
  } catch (err) {
    logger.error({ err: (err as Error).message }, "retention_notifications_failed");
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
    logger.error({ err: (err as Error).message }, "retention_view_history_failed");
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
    logger.error({ err: (err as Error).message }, "retention_search_history_failed");
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
    logger.error(
      { err: (err as Error).message },
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
    logger.error({ err: (err as Error).message }, "retention_final_purge_failed");
  }

  if (
    notificationsTrimmed +
      viewHistoryTrimmed +
      searchHistoryTrimmed +
      rateLimitEventsTrimmed +
      erasesFinalised >
    0
  ) {
    logger.info(
      {
        notificationsTrimmed,
        viewHistoryTrimmed,
        searchHistoryTrimmed,
        rateLimitEventsTrimmed,
        erasesFinalised,
      },
      "retention_sweep_completed",
    );
  }
  return {
    notificationsTrimmed,
    viewHistoryTrimmed,
    searchHistoryTrimmed,
    rateLimitEventsTrimmed,
    erasesFinalised,
  };
}
