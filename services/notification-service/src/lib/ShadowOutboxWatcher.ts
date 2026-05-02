/**
 * Shadow outbox watcher.
 *
 * Phase 4 strangler-fig step 1: this service runs ALONGSIDE the monolith
 * drainer and only OBSERVES the queue. It does not claim, send, or update
 * any rows. Its job is to:
 *
 *   1. Prove the new pod can reach the database with its own credentials.
 *   2. Surface the same queue-health signal the monolith publishes
 *      (`pendingCount`, `processingCount`, `failedCount`, oldest ages),
 *      so dashboards can compare both services side-by-side and confirm
 *      drift is zero before the cutover gate in step 2.
 *   3. Increment Prometheus counters so SLO baselines are established.
 *
 * The watcher polls every NOTIFICATION_POLL_INTERVAL_MS (default 30s).
 * It NEVER mutates rows while NOTIFICATION_DRAIN_ENABLED is "false";
 * subsequent slices wire actual draining behind that flag.
 */

import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@workspace/db/schema";
import pg from "pg";
import {
  logger,
  outboxOldestPendingAgeSeconds,
  outboxQueueDepth,
  outboxPollErrorsTotal,
} from "./observability.js";
import { OutboxDrainer } from "./OutboxDrainer.js";
import { LogChannelDispatcher, type ChannelDispatcher } from "./ChannelDispatcher.js";

const { Pool } = pg;

export interface ShadowWatcherOptions {
  databaseUrl: string;
  pollIntervalMs?: number;
  drainEnabled?: boolean;
  /** Batch size for drain; default 10. */
  drainBatchSize?: number;
  /** Override default LogChannelDispatcher with a real adapter. */
  dispatcher?: ChannelDispatcher;
  /** Test seam: caller can inject a pre-built db handle. */
  db?: NodePgDatabase<typeof schema>;
  /** Test seam: lets tests call `tick()` directly without a real interval. */
  autoStart?: boolean;
}

interface DepthRow {
  pending_count: string | number;
  processing_count: string | number;
  failed_count: string | number;
  oldest_pending_at: Date | string | null;
}

function toInt(v: string | number): number {
  return typeof v === "number" ? v : Number.parseInt(v, 10) || 0;
}

export class ShadowOutboxWatcher {
  private readonly db: NodePgDatabase<typeof schema>;
  private readonly pool: pg.Pool | null;
  private readonly pollIntervalMs: number;
  private readonly drainEnabled: boolean;
  private readonly drainer: OutboxDrainer | null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(opts: ShadowWatcherOptions) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 30_000;
    this.drainEnabled = opts.drainEnabled ?? false;
    if (opts.db) {
      this.db = opts.db;
      this.pool = null;
    } else {
      this.pool = new Pool({ connectionString: opts.databaseUrl });
      this.db = drizzle(this.pool, { schema });
    }
    this.drainer = this.drainEnabled
      ? new OutboxDrainer(
          this.db,
          opts.dispatcher ?? new LogChannelDispatcher(),
          opts.drainBatchSize ?? 10,
        )
      : null;
  }

  start(): void {
    if (this.timer) return;
    this.running = true;
    // First tick after a small delay so the HTTP server can bind and
    // become ready before we start emitting metrics.
    this.timer = setTimeout(() => {
      void this.runLoop();
    }, 5_000);
    if (typeof this.timer.unref === "function") this.timer.unref();
    logger.info(
      {
        pollIntervalMs: this.pollIntervalMs,
        drainEnabled: this.drainEnabled,
        mode: this.drainEnabled ? "drain" : "shadow",
      },
      "outbox_watcher_started",
    );
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pool) await this.pool.end();
  }

  /**
   * Single observation cycle. Exposed so tests can call it directly
   * without driving the timer loop. Always resolves; errors are logged
   * and counted but do not throw — a transient DB blip should not crash
   * the service.
   */
  async tick(): Promise<{
    pendingCount: number;
    processingCount: number;
    failedCount: number;
    oldestPendingAgeSeconds: number;
  }> {
    try {
      const result = await this.db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE status = 'pending')    AS pending_count,
          COUNT(*) FILTER (WHERE status = 'processing') AS processing_count,
          COUNT(*) FILTER (WHERE status = 'failed')     AS failed_count,
          MIN(next_attempt_at) FILTER (
            WHERE status = 'pending' AND next_attempt_at <= NOW()
          ) AS oldest_pending_at
        FROM notifications_outbox
      `);
      const rows: DepthRow[] = Array.isArray(result)
        ? (result as unknown as DepthRow[])
        : ((result as unknown as { rows?: DepthRow[] }).rows ?? []);
      const row = rows[0] ?? {
        pending_count: 0,
        processing_count: 0,
        failed_count: 0,
        oldest_pending_at: null,
      };
      const pending = toInt(row.pending_count);
      const processing = toInt(row.processing_count);
      const failed = toInt(row.failed_count);
      const oldestPendingAt =
        row.oldest_pending_at instanceof Date
          ? row.oldest_pending_at
          : row.oldest_pending_at
            ? new Date(row.oldest_pending_at)
            : null;
      const ageSeconds = oldestPendingAt
        ? Math.max(0, Math.floor((Date.now() - oldestPendingAt.getTime()) / 1000))
        : 0;

      outboxQueueDepth.set({ status: "pending" }, pending);
      outboxQueueDepth.set({ status: "processing" }, processing);
      outboxQueueDepth.set({ status: "failed" }, failed);
      outboxOldestPendingAgeSeconds.set(ageSeconds);

      return {
        pendingCount: pending,
        processingCount: processing,
        failedCount: failed,
        oldestPendingAgeSeconds: ageSeconds,
      };
    } catch (err) {
      outboxPollErrorsTotal.inc();
      logger.warn(
        { err: (err as Error).message },
        "outbox_watcher_poll_failed",
      );
      return {
        pendingCount: -1,
        processingCount: -1,
        failedCount: -1,
        oldestPendingAgeSeconds: -1,
      };
    }
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      await this.tick();
      if (this.drainer) {
        try {
          const result = await this.drainer.drainBatch();
          if (result.claimed > 0) {
            logger.info(result, "outbox_drain_batch_complete");
          }
        } catch (err) {
          logger.warn({ err: (err as Error).message }, "outbox_drain_batch_error");
        }
      }
      await new Promise<void>((resolve) => {
        this.timer = setTimeout(resolve, this.pollIntervalMs);
        if (typeof this.timer.unref === "function") this.timer.unref();
      });
    }
  }
}
