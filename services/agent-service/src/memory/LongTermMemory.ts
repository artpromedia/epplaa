/**
 * LongTermMemory — pgvector-backed semantic retrieval store.
 *
 * @see §14.8 (Memory Architecture — long-term tier)
 *
 * AI Sprint 0: interface and stub only. Real pgvector client (Postgres)
 * wired in AI Sprint 3 (when long-term memory is first needed by the
 * Fraud & Counterfeit agent).
 *
 * Retention: per NDPC data retention policy (no automatic TTL).
 */

export interface MemoryEntry {
  id: string;
  agentId: string;
  sessionId: string;
  /** The text content that was embedded. */
  text: string;
  /** The embedding vector (dimension depends on the embedding model). */
  embedding: number[];
  metadata: Record<string, unknown>;
  /** ISO-8601 timestamp. */
  createdAt: string;
}

export interface SimilaritySearchOptions {
  agentId: string;
  queryEmbedding: number[];
  /** Maximum number of results to return. */
  topK: number;
  /** Minimum cosine similarity threshold (0–1). */
  minSimilarity?: number | undefined;
}

export interface ILongTermMemory {
  /**
   * Store a new memory entry with its embedding.
   */
  store(entry: Omit<MemoryEntry, "id" | "createdAt">): Promise<string>;

  /**
   * Find the most similar entries to a query embedding.
   * Uses cosine similarity search via pgvector.
   */
  search(options: SimilaritySearchOptions): Promise<MemoryEntry[]>;

  /**
   * Delete all memory entries for a given session (e.g., user data deletion
   * request per NDPC).
   */
  deleteSession(sessionId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Stub implementation (AI Sprint 0)
// ---------------------------------------------------------------------------

export class StubLongTermMemory implements ILongTermMemory {
  async store(_entry: Omit<MemoryEntry, "id" | "createdAt">): Promise<string> {
    // TODO (AI Sprint 3): insert into pgvector table.
    throw new Error("StubLongTermMemory.store() not yet implemented — AI Sprint 3");
  }

  async search(_options: SimilaritySearchOptions): Promise<MemoryEntry[]> {
    // TODO (AI Sprint 3): SELECT ... ORDER BY embedding <=> $1 LIMIT $2
    return [];
  }

  async deleteSession(_sessionId: string): Promise<void> {
    // TODO (AI Sprint 3): DELETE FROM memory_entries WHERE session_id = $1
  }
}
