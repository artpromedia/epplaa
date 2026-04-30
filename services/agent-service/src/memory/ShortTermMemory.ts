/**
 * ShortTermMemory — Redis-backed conversation context store.
 *
 * @see §14.8 (Memory Architecture — short-term tier)
 *
 * AI Sprint 0: interface and stub only. Real Redis client (ioredis) wired
 * in AI Sprint 1.
 *
 * TTL: 30 minutes per session (configurable via SHORT_TERM_MEMORY_TTL_SECONDS).
 */

export interface ConversationMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string | undefined;
  /** ISO-8601 timestamp. */
  timestamp: string;
}

export interface IShortTermMemory {
  /**
   * Retrieve the conversation history for a session.
   * Returns an empty array if the session is new or has expired.
   */
  get(sessionId: string): Promise<ConversationMessage[]>;

  /**
   * Append messages to a session's history and reset the TTL.
   */
  append(sessionId: string, messages: ConversationMessage[]): Promise<void>;

  /**
   * Clear a session's history (e.g., on explicit reset or handoff).
   */
  clear(sessionId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory stub (AI Sprint 0)
// ---------------------------------------------------------------------------

export class InMemoryShortTermMemory implements IShortTermMemory {
  private readonly store = new Map<string, ConversationMessage[]>();

  async get(sessionId: string): Promise<ConversationMessage[]> {
    return this.store.get(sessionId) ?? [];
  }

  async append(sessionId: string, messages: ConversationMessage[]): Promise<void> {
    const existing = this.store.get(sessionId) ?? [];
    this.store.set(sessionId, [...existing, ...messages]);
  }

  async clear(sessionId: string): Promise<void> {
    this.store.delete(sessionId);
  }
}
