/**
 * Channel dispatcher interface.
 *
 * Each pluggable adapter implements dispatch(row) for a specific
 * delivery channel (email, sms, push, whatsapp, …).  A
 * LogChannelDispatcher is provided as the default for channels that
 * are not yet wired to a real provider; it marks rows delivered and
 * emits a structured warning so the queue never stalls.
 */

import type { OutboxRow } from "@workspace/db/schema";
import { logger } from "./observability.js";

export interface ChannelDispatcher {
  /**
   * Send the notification described by `row`.
   *
   * Throw to signal a transient failure (will be retried).
   * Return normally to acknowledge delivery.
   */
  dispatch(row: OutboxRow): Promise<void>;
}

/**
 * Default dispatcher — logs a warning and considers the row delivered.
 *
 * Use this as a placeholder until real channel adapters are wired.
 * It means rows won't pile up and the drain machinery is exercisable in
 * staging before every provider integration is ready.
 */
export class LogChannelDispatcher implements ChannelDispatcher {
  async dispatch(row: OutboxRow): Promise<void> {
    logger.warn(
      {
        id: row.id,
        userId: row.userId,
        eventType: row.eventType,
        channel: row.channel,
      },
      "outbox_channel_unimplemented — marking delivered without sending",
    );
  }
}

/**
 * Registry-based dispatcher: routes each row to the appropriate
 * channel-specific adapter via a Map keyed on `row.channel`.
 * Falls back to LogChannelDispatcher for unregistered channels.
 */
export class RoutingChannelDispatcher implements ChannelDispatcher {
  private readonly routes: Map<string, ChannelDispatcher>;
  private readonly fallback: ChannelDispatcher;

  constructor(routes: Map<string, ChannelDispatcher>) {
    this.routes = routes;
    this.fallback = new LogChannelDispatcher();
  }

  async dispatch(row: OutboxRow): Promise<void> {
    const adapter = this.routes.get(row.channel) ?? this.fallback;
    await adapter.dispatch(row);
  }
}
