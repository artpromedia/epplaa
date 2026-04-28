import { lt, and, isNotNull } from "drizzle-orm";
import { db, schema } from "./db";
import { logger } from "./logger";
import { applyErase } from "./ndpr";

/**
 * Retention schedule (Epplaa privacy policy v4.1 §11.1.4):
 * - Notifications outbox: 90 days, then archive (delete here = archive in dev).
 * - Recently viewed: 90 days.
 * - Recent searches: 90 days.
 * - Cart items: 180 days idle.
 * - Audit events: 7 years (NEVER deleted by this sweep).
 * - Payments / payouts / orders: 7 years (NEVER deleted by this sweep).
 * - User PII: purged once an erase request becomes effective AND the
 *   user has been flagged `dataDeletedAt` for 30 days (final purge).
 */
const NOTIFICATION_RETENTION_MS = 90 * 24 * 3600 * 1000;
const VIEW_HISTORY_RETENTION_MS = 90 * 24 * 3600 * 1000;
const SEARCH_HISTORY_RETENTION_MS = 90 * 24 * 3600 * 1000;
const FINAL_PURGE_AFTER_ERASE_MS = 30 * 24 * 3600 * 1000;

export async function runRetentionSweep(): Promise<{
  notificationsTrimmed: number;
  viewHistoryTrimmed: number;
  searchHistoryTrimmed: number;
  erasesFinalised: number;
}> {
  const now = Date.now();
  let notificationsTrimmed = 0;
  let viewHistoryTrimmed = 0;
  let searchHistoryTrimmed = 0;
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

  // 4. Final-purge users whose erase has been effective > 30 days. Some
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

  if (notificationsTrimmed + viewHistoryTrimmed + searchHistoryTrimmed + erasesFinalised > 0) {
    logger.info(
      { notificationsTrimmed, viewHistoryTrimmed, searchHistoryTrimmed, erasesFinalised },
      "retention_sweep_completed",
    );
  }
  return { notificationsTrimmed, viewHistoryTrimmed, searchHistoryTrimmed, erasesFinalised };
}
