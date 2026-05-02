/**
 * Tests for OutboxDrainer claim-dispatch-ack loop.
 *
 * Uses a duck-typed fake db that tracks SQL calls so we can assert the
 * correct UPDATE statements are issued without a real Postgres instance.
 */

import { describe, it, expect, vi } from "vitest";
import { OutboxDrainer } from "../lib/OutboxDrainer.js";
import type { ChannelDispatcher } from "../lib/ChannelDispatcher.js";
import type { OutboxRow } from "@workspace/db/schema";

/** Helper to build a minimal OutboxRow with sensible defaults. */
function makeRow(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: "row-1",
    userId: "user-1",
    eventType: "order_paid",
    channel: "email",
    payload: { orderId: "ord-1" },
    status: "processing",
    attempts: 1,
    lastError: null,
    nextAttemptAt: new Date(),
    deliveredAt: null,
    failedAt: null,
    createdAt: new Date(),
    ...overrides,
  } as OutboxRow;
}

type SqlCall = { text: string; values?: unknown[] };

/**
 * Build a fake drizzle db handle that records every sql`` call.
 *
 * - First execute call returns `claimResult` (simulates the UPDATE ... RETURNING claim).
 * - Subsequent calls return empty (ack/nack updates).
 */
function fakeDb(claimResult: OutboxRow[]) {
  const calls: SqlCall[] = [];
  let callCount = 0;
  const db = {
    execute: vi.fn(async (query: { queryChunks?: unknown; sql?: string }) => {
      const text = (query as { queryChunks?: Array<{value: string}>; sql?: string })
        ?.queryChunks?.map((c) => (c as {value: string}).value).join("") ?? String(query);
      calls.push({ text });
      const result = callCount === 0 ? claimResult : [];
      callCount++;
      return { rows: result };
    }),
    _calls: calls,
  };
  return db;
}

describe("OutboxDrainer", () => {
  it("claims, dispatches, and acks a row successfully", async () => {
    const row = makeRow();
    const db = fakeDb([row]);
    const dispatcher: ChannelDispatcher = { dispatch: vi.fn(async () => undefined) };
    const drainer = new OutboxDrainer(db as never, dispatcher, 5);

    const result = await drainer.drainBatch();

    expect(result.claimed).toBe(1);
    expect(result.delivered).toBe(1);
    expect(result.retried).toBe(0);
    expect(result.failed).toBe(0);
    expect(dispatcher.dispatch).toHaveBeenCalledWith(row);
    // Ack update should have been executed
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it("retries a transient dispatch error with backoff (attempts < MAX)", async () => {
    const row = makeRow({ attempts: 2 });
    const db = fakeDb([row]);
    const dispatcher: ChannelDispatcher = {
      dispatch: vi.fn(async () => {
        throw new Error("smtp timeout");
      }),
    };
    const drainer = new OutboxDrainer(db as never, dispatcher, 5);

    const result = await drainer.drainBatch();

    expect(result.retried).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.delivered).toBe(0);
  });

  it("permanently fails a row after MAX_ATTEMPTS", async () => {
    const row = makeRow({ attempts: 5 });
    const db = fakeDb([row]);
    const dispatcher: ChannelDispatcher = {
      dispatch: vi.fn(async () => {
        throw new Error("provider down");
      }),
    };
    const drainer = new OutboxDrainer(db as never, dispatcher, 5);

    const result = await drainer.drainBatch();

    expect(result.failed).toBe(1);
    expect(result.retried).toBe(0);
    expect(result.delivered).toBe(0);
  });

  it("returns zero counts when no rows are pending", async () => {
    const db = fakeDb([]);
    const dispatcher: ChannelDispatcher = { dispatch: vi.fn(async () => undefined) };
    const drainer = new OutboxDrainer(db as never, dispatcher, 5);

    const result = await drainer.drainBatch();

    expect(result.claimed).toBe(0);
    expect(result.delivered).toBe(0);
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("handles db claim failure gracefully without throwing", async () => {
    const db = {
      execute: vi.fn(async () => {
        throw new Error("db unreachable");
      }),
    };
    const dispatcher: ChannelDispatcher = { dispatch: vi.fn(async () => undefined) };
    const drainer = new OutboxDrainer(db as never, dispatcher, 5);

    const result = await drainer.drainBatch();

    expect(result.claimed).toBe(0);
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });
});
