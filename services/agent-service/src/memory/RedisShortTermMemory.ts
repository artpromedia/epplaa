/**
 * Redis-backed implementation of `IShortTermMemory`.
 *
 * Storage layout: a single Redis LIST per session (`agent:stm:<sessionId>`)
 * holding JSON-encoded ConversationMessage entries. Reads return the full
 * list (typically <30 entries for a session within the 30-minute TTL),
 * writes RPUSH and EXPIRE in a pipeline.
 *
 * TTL semantics: every append resets the key TTL, so the session stays
 * warm during active conversation but ages out 30 minutes after the
 * last turn.
 */

import type Redis from "ioredis";
import type {
  ConversationMessage,
  IShortTermMemory,
} from "./ShortTermMemory.js";

const DEFAULT_TTL_SECONDS = 30 * 60;
const KEY_PREFIX = "agent:stm:";

export class RedisShortTermMemory implements IShortTermMemory {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number = parseInt(
      process.env.SHORT_TERM_MEMORY_TTL_SECONDS ?? `${DEFAULT_TTL_SECONDS}`,
      10,
    ),
  ) {}

  async get(sessionId: string): Promise<ConversationMessage[]> {
    const key = KEY_PREFIX + sessionId;
    const entries = await this.redis.lrange(key, 0, -1);
    return entries.map((s) => JSON.parse(s) as ConversationMessage);
  }

  async append(sessionId: string, messages: ConversationMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const key = KEY_PREFIX + sessionId;
    const pipeline = this.redis.multi();
    for (const m of messages) {
      pipeline.rpush(key, JSON.stringify(m));
    }
    pipeline.expire(key, this.ttlSeconds);
    await pipeline.exec();
  }

  async clear(sessionId: string): Promise<void> {
    await this.redis.del(KEY_PREFIX + sessionId);
  }
}
