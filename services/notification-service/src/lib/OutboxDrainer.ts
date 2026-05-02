/**
 * OutboxDrainer — Wave 4 strangler-fig step 2.
 *
 * Atomically claims a batch of pending outbox rows, dispatches each via
 * the provided ChannelDispatcher, then acks (marks delivered) or nacks
 * (retries with exponential back-off or permanently fails) each row.
 *
 * Claiming is done with a single UPDATE … WHERE id = ANY(SELECT … FOR
 * UPDATE SKIP LOCKED) so concurrent pods don't double-send.  Each row
 * carries an `attempts` counter; after MAX_ATTEMPTS consecutive errors
 * the row is permanently failed rather than retried forever.
 *
 * Backoff schedule (jitter ±25%):
 *   attempt 1 → 1m, 2 → 2m, 3 → 4m, 4 → 8m, 5+ → 16m (cap 30m)
 */

import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@workspace/db/schema";
import type { OutboxRow } from "@workspace/db/schema";
import {
  logger,
  outboxDeliveredTotal,
  outboxFailedTotal,
  outboxRetriedTotal,
} from "./observability.js";
import type { ChannelDispatcher } from "./ChannelDispatcher.js";

const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 60_000; // 1 minute

function nextAttemptDelay(attempts: number): number {
  const exp = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempts - 1), 30 * 60_000);
  // ±25% jitter to spread thundering herd
  const jitter = (Math.random() - 0.5) * 0.5 * exp;
  return Math.max(1000, Math.round(exp + jitter));
}

export interface DrainResult {
  claimed: number;
  delivered: number;
  retried: number;
  failed: number;
}

export class OutboxDrainer {
  constructor(
    private readonly db: NodePgDatabase<typeof schema>,
    private readonly dispatcher: ChannelDispatcher,
    private readonly batchSize: number = 10,
  ) {}

  /**
   * Claim a batch of pending rows, dispatch each, and record the outcome.
   * Never throws; all errors are caught and reflected in the returned
   * DrainResult so the caller can log / alert.
   */
  async drainBatch(): Promise<DrainResult> {
    let claimed = 0;
    let delivered = 0;
    let retried = 0;
    let failed = 0;

    let rows: OutboxRow[];
    try {
      const result = await this.db.execute(sql`
        UPDATE notifications_outbox
        SET    status          = 'processing',
               attempts        = attempts + 1
        WHERE  id = ANY (
          SELECT id
          FROM   notifications_outbox
          WHERE  status         = 'pending'
            AND  next_attempt_at <= NOW()
          ORDER  BY next_attempt_at
          LIMIT  ${this.batchSize}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      `);
      const raw = Array.isArray(result)
        ? result
        : ((result as unknown as { rows?: unknown[] }).rows ?? []);
      // Drizzle raw execute returns plain objects; cast to OutboxRow shape.
      rows = raw as OutboxRow[];
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "outbox_drain_claim_failed");
      return { claimed, delivered, retried, failed };
    }

    claimed = rows.length;

    for (const row of rows) {
      try {
        await this.dispatcher.dispatch(row);
        // Ack: mark delivered.
        await this.db.execute(sql`
          UPDATE notifications_outbox
          SET    status       = 'delivered',
                 delivered_at = NOW(),
                 last_error   = NULL
          WHERE  id = ${row.id}
        `);
        outboxDeliveredTotal.inc({ channel: row.channel });
        logger.info(
          { id: row.id, channel: row.channel, attempts: row.attempts },
          "outbox_row_delivered",
        );
        delivered++;
      } catch (dispatchErr) {
        const errMsg = (dispatchErr as Error).message;
        const attempts = typeof row.attempts === "number" ? row.attempts : Number(row.attempts);
        if (attempts >= MAX_ATTEMPTS) {
          // Permanently fail.
          await this.db.execute(sql`
            UPDATE notifications_outbox
            SET    status     = 'failed',
                   failed_at  = NOW(),
                   last_error = ${errMsg}
            WHERE  id = ${row.id}
          `).catch((e: Error) =>
            logger.warn({ id: row.id, err: e.message }, "outbox_drain_fail_update_error"),
          );
          outboxFailedTotal.inc({ channel: row.channel });
          logger.warn(
            { id: row.id, channel: row.channel, attempts, err: errMsg },
            "outbox_row_permanently_failed",
          );
          failed++;
        } else {
          // Transient failure — reschedule with backoff.
          const delayMs = nextAttemptDelay(attempts);
          await this.db.execute(sql`
            UPDATE notifications_outbox
            SET    status          = 'pending',
                   next_attempt_at = NOW() + ${`${delayMs} milliseconds`}::interval,
                   last_error      = ${errMsg}
            WHERE  id = ${row.id}
          `).catch((e: Error) =>
            logger.warn({ id: row.id, err: e.message }, "outbox_drain_retry_update_error"),
          );
          outboxRetriedTotal.inc({ channel: row.channel });
          logger.warn(
            { id: row.id, channel: row.channel, attempts, delayMs, err: errMsg },
            "outbox_row_retried",
          );
          retried++;
        }
      }
    }

    return { claimed, delivered, retried, failed };
  }
}
