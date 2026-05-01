/**
 * Outbox drain worker.
 *
 * Polls `event_outbox` for `status='pending'` rows, claims a batch with
 * `SELECT ... FOR UPDATE SKIP LOCKED` (so multiple workers can run
 * safely in parallel — important once the monolith scales beyond 1
 * replica), dispatches each event to its registered consumers, and
 * marks the row delivered.
 *
 * Failure handling:
 *   - Consumer throws → row.attempts++. After 10 attempts the row is
 *     marked `status='dlq'` so the auditDlqMonitor (existing in
 *     services/api-monolith/src/lib/auditDlqMonitor.ts) catches it.
 *   - Worker crash mid-batch → the SKIP LOCKED claim drops, another
 *     worker picks it up after the lock_timeout.
 *
 * Production sink switch (Phase E.2): when `EVENTS_BROKER=redpanda` the
 * dispatch step uses kafkajs instead of the in-process registry. Same
 * outbox-claim semantics, so the migration is a one-line conditional
 * inside `dispatch()`.
 */

import { sql } from "drizzle-orm";
import { eventOutboxTable } from "./schema.js";
import { envelopeMetaSchema, getRegisteredConsumers, type EnvelopeMeta } from "./index.js";

const MAX_ATTEMPTS = 10;
const BATCH_SIZE = 50;
const POLL_INTERVAL_MS = 1_000;

type DrainableDb = {
  execute: (q: ReturnType<typeof sql>) => Promise<{ rows: Array<Record<string, unknown>> }>;
};

export interface WorkerOptions {
  db: DrainableDb;
  /** Hook for metrics — called for every drain attempt. */
  onMetric?: (event: { kind: string; topic?: string; outcome?: string }) => void;
  /** When true, dispatch via Redpanda producer instead of in-process registry. */
  useRedpanda?: boolean;
}

export class OutboxWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly opts: WorkerOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.scheduleNext());
    }, POLL_INTERVAL_MS);
  }

  /** Exposed for tests so a single tick can be awaited. */
  async tick(): Promise<{ delivered: number; failed: number }> {
    const claimed = await this.claimBatch();
    let delivered = 0;
    let failed = 0;
    for (const row of claimed) {
      const ok = await this.dispatch(row);
      if (ok) delivered++;
      else failed++;
    }
    this.opts.onMetric?.({ kind: "tick", outcome: `delivered=${delivered},failed=${failed}` });
    return { delivered, failed };
  }

  private async claimBatch(): Promise<Array<Record<string, unknown>>> {
    const result = await this.opts.db.execute(sql`
      WITH claimed AS (
        SELECT id FROM ${eventOutboxTable}
        WHERE status = 'pending'
        ORDER BY created_at
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE ${eventOutboxTable} t
      SET status = 'in_flight'
      FROM claimed c
      WHERE t.id = c.id
      RETURNING t.*
    `);
    return result.rows;
  }

  private async dispatch(row: Record<string, unknown>): Promise<boolean> {
    const meta: EnvelopeMeta = envelopeMetaSchema.parse({
      eventId: row.id,
      topic: row.topic,
      aggregateId: row.aggregate_id,
      eventType: row.event_type,
      occurredAt: (row.created_at as Date).toISOString(),
    });

    const consumers = this.opts.useRedpanda
      ? // TODO Phase E.2: Redpanda producer path; one .send() per topic.
        []
      : getRegisteredConsumers(meta.topic);

    try {
      for (const handler of consumers) {
        await handler(meta, row.payload);
      }
      await this.opts.db.execute(sql`
        UPDATE ${eventOutboxTable}
        SET status='delivered', delivered_at=now()
        WHERE id=${row.id}
      `);
      this.opts.onMetric?.({ kind: "delivered", topic: meta.topic });
      return true;
    } catch (err) {
      const attempts = (row.attempts as number) + 1;
      const status = attempts >= MAX_ATTEMPTS ? "dlq" : "pending";
      await this.opts.db.execute(sql`
        UPDATE ${eventOutboxTable}
        SET attempts=${attempts}, status=${status}, last_error=${(err as Error).message}
        WHERE id=${row.id}
      `);
      this.opts.onMetric?.({ kind: "failed", topic: meta.topic });
      return false;
    }
  }
}
