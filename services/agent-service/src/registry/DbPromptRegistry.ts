/**
 * DbPromptRegistry — production prompt registry backed by Postgres.
 *
 * Storage: `prompts` table in @workspace/db (one row per (ref) version,
 * `is_active` flag indicates the live pointer for each ref family).
 *
 * Behaviour:
 *   - `load(ref)`: returns the row for `ref`. Cached in memory for
 *     `cacheTtlMs` (default 60s) so a hot path doesn't hit Postgres on
 *     every agent turn.
 *   - `list()`: returns one row per ref where is_active=true.
 *   - `bootstrap()`: idempotently seeds the table from the in-memory
 *     defaults if it is empty. Safe to call from a non-leader pod —
 *     each insert is guarded by ON CONFLICT DO NOTHING.
 *
 * The registry uses its own pg.Pool + drizzle handle so the
 * notification-service and agent-service can both consume `@workspace/db`
 * schema without triggering the package root's hard DATABASE_URL throw.
 */

import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { promptsTable } from "@workspace/db/schema";
import * as schema from "@workspace/db/schema";
import pg from "pg";
import { logger } from "../lib/observability.js";
import {
  type IPromptRegistry,
  type IPromptAdminStore,
  type PromptAdminRow,
  type CreatePromptInput,
  type PromptVersion,
  getSeedPrompts,
} from "./PromptRegistry.js";

const { Pool } = pg;

interface CacheEntry {
  value: PromptVersion;
  expiresAt: number;
}

export interface DbPromptRegistryOptions {
  databaseUrl: string;
  cacheTtlMs?: number;
  /** Test seam: caller can inject a pre-built db handle. */
  db?: NodePgDatabase<typeof schema>;
}

export class DbPromptRegistry implements IPromptRegistry, IPromptAdminStore {
  private readonly db: NodePgDatabase<typeof schema>;
  private readonly pool: pg.Pool | null;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts: DbPromptRegistryOptions) {
    this.cacheTtlMs = opts.cacheTtlMs ?? 60_000;
    if (opts.db) {
      this.db = opts.db;
      this.pool = null;
    } else {
      this.pool = new Pool({ connectionString: opts.databaseUrl });
      this.db = drizzle(this.pool, { schema });
    }
  }

  /**
   * Idempotent seed of the table from in-memory defaults. Returns the
   * number of rows inserted. Safe to call on every pod startup; the
   * unique index on `ref` makes this a no-op when the row already
   * exists.
   */
  async bootstrap(): Promise<number> {
    const seeds = getSeedPrompts();
    let inserted = 0;
    for (const seed of seeds) {
      const family = seed.ref.replace(/^prompts\//, "").split("/")[0] ?? seed.ref;
      const version = seed.ref.split("/").pop() ?? "v1";
      const result = await this.db.execute(sql`
        INSERT INTO prompts (id, ref, family, version, system_prompt, is_active, activated_at, created_at)
        VALUES (
          ${`prompt_${family}_${version}`},
          ${seed.ref},
          ${family},
          ${version},
          ${seed.systemPrompt},
          true,
          ${new Date(seed.activatedAt)},
          NOW()
        )
        ON CONFLICT (ref) DO NOTHING
      `);
      const count = (result as unknown as { rowCount?: number }).rowCount ?? 0;
      inserted += count;
    }
    if (inserted > 0) {
      logger.info({ inserted }, "prompt_registry_seeded");
    }
    return inserted;
  }

  async load(ref: string): Promise<PromptVersion> {
    const now = Date.now();
    const cached = this.cache.get(ref);
    if (cached && cached.expiresAt > now) return cached.value;

    const rows = await this.db
      .select({
        ref: promptsTable.ref,
        systemPrompt: promptsTable.systemPrompt,
        activatedAt: promptsTable.activatedAt,
      })
      .from(promptsTable)
      .where(eq(promptsTable.ref, ref))
      .limit(1);

    const row = rows[0];
    if (!row) {
      throw new Error(`PromptRegistry: unknown ref '${ref}'`);
    }
    const value: PromptVersion = {
      ref: row.ref,
      systemPrompt: row.systemPrompt,
      activatedAt:
        row.activatedAt instanceof Date
          ? row.activatedAt.toISOString()
          : (row.activatedAt as unknown as string) ?? new Date(0).toISOString(),
    };
    this.cache.set(ref, { value, expiresAt: now + this.cacheTtlMs });
    return value;
  }

  async list(): Promise<PromptVersion[]> {
    const rows = await this.db
      .select({
        ref: promptsTable.ref,
        systemPrompt: promptsTable.systemPrompt,
        activatedAt: promptsTable.activatedAt,
      })
      .from(promptsTable)
      .where(eq(promptsTable.isActive, true));
    return rows.map((r) => ({
      ref: r.ref,
      systemPrompt: r.systemPrompt,
      activatedAt:
        r.activatedAt instanceof Date
          ? r.activatedAt.toISOString()
          : (r.activatedAt as unknown as string) ?? new Date(0).toISOString(),
    }));
  }

  /** Drop the in-memory cache; used when a new version is activated via admin tools. */
  invalidate(ref?: string): void {
    if (ref) this.cache.delete(ref);
    else this.cache.clear();
  }

  // ---------------------------------------------------------------------
  // IPromptAdminStore — admin write API.
  // ---------------------------------------------------------------------

  async listAll(): Promise<PromptAdminRow[]> {
    const rows = await this.db
      .select()
      .from(promptsTable)
      .orderBy(sql`created_at DESC`);
    return rows.map((r) => this.toAdminRow(r));
  }

  async getOne(ref: string): Promise<PromptAdminRow | null> {
    const rows = await this.db
      .select()
      .from(promptsTable)
      .where(eq(promptsTable.ref, ref))
      .limit(1);
    const row = rows[0];
    return row ? this.toAdminRow(row) : null;
  }

  async create(input: CreatePromptInput): Promise<PromptAdminRow> {
    const id = `prompt_${input.family}_${input.version}_${Date.now().toString(36)}`;
    const inserted = await this.db
      .insert(promptsTable)
      .values({
        id,
        ref: input.ref,
        family: input.family,
        version: input.version,
        systemPrompt: input.systemPrompt,
        isActive: false,
        activatedAt: null,
        createdBy: input.createdBy ?? null,
      })
      .returning();
    const row = inserted[0];
    if (!row) {
      throw new Error("PromptRegistry: insert returned no row");
    }
    logger.info(
      { ref: input.ref, family: input.family, version: input.version },
      "prompt_registry_draft_created",
    );
    return this.toAdminRow(row);
  }

  async activate(ref: string): Promise<PromptAdminRow> {
    const existing = await this.getOne(ref);
    if (!existing) {
      throw new Error(`PromptRegistry: cannot activate unknown ref '${ref}'`);
    }
    // Atomic flip: within `family`, set is_active=(ref=$ref) and bump
    // activated_at for the newly-active row only. Postgres applies SET
    // expressions left-to-right with the OLD row visible, so this is
    // safe in a single statement.
    await this.db.execute(sql`
      UPDATE prompts
      SET
        is_active = (ref = ${ref}),
        activated_at = CASE WHEN ref = ${ref} THEN NOW() ELSE activated_at END
      WHERE family = ${existing.family}
    `);
    // Drop cache for the family — both the newly-active row and any
    // previously-active row could be cached.
    this.cache.clear();
    logger.info(
      { ref, family: existing.family },
      "prompt_registry_activated",
    );
    const next = await this.getOne(ref);
    if (!next) {
      throw new Error("PromptRegistry: activated row vanished");
    }
    return next;
  }

  private toAdminRow(r: typeof promptsTable.$inferSelect): PromptAdminRow {
    return {
      id: r.id,
      ref: r.ref,
      family: r.family,
      version: r.version,
      systemPrompt: r.systemPrompt,
      isActive: r.isActive ?? false,
      activatedAt:
        r.activatedAt instanceof Date ? r.activatedAt.toISOString() : (r.activatedAt as unknown as string | null),
      createdAt:
        r.createdAt instanceof Date ? r.createdAt.toISOString() : (r.createdAt as unknown as string),
      createdBy: r.createdBy ?? null,
    };
  }

  async close(): Promise<void> {
    if (this.pool) await this.pool.end();
  }
}
