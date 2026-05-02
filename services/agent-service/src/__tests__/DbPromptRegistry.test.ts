import { describe, it, expect, vi } from "vitest";
import { DbPromptRegistry } from "../registry/DbPromptRegistry.js";

/**
 * Build a duck-typed drizzle-like handle. We only exercise the two query
 * shapes the registry actually uses: `select(...).from(...).where(...).limit(1)`
 * for `load`, `select(...).from(...).where(...)` for `list`, and
 * `execute(sql\`...\`)` for `bootstrap`.
 */
function buildFakeDb(opts: {
  rows?: Array<{ ref: string; systemPrompt: string; activatedAt: Date | null }>;
  executeRowCount?: number;
}) {
  const rows = opts.rows ?? [];
  const executeRowCount = opts.executeRowCount ?? 0;
  const builder = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(async () => rows),
    then: undefined as unknown,
  };
  // Make builder thenable for `await db.select(...).from(...).where(...)`
  Object.defineProperty(builder, "then", {
    value: (resolve: (v: unknown) => void) => resolve(rows),
    enumerable: false,
  });
  const db = {
    select: vi.fn(() => builder),
    execute: vi.fn(async () => ({ rowCount: executeRowCount })),
  };
  return { db, builder };
}

describe("DbPromptRegistry", () => {
  it("load() returns a row from the DB and caches it", async () => {
    const activatedAt = new Date("2026-05-01T00:00:00Z");
    const { db } = buildFakeDb({
      rows: [
        {
          ref: "prompts/buyer-concierge/v1",
          systemPrompt: "# Identity\nBuyer concierge",
          activatedAt,
        },
      ],
    });
    const registry = new DbPromptRegistry({
      databaseUrl: "postgres://unused",
      // @ts-expect-error — duck-typed test db
      db,
    });

    const first = await registry.load("prompts/buyer-concierge/v1");
    expect(first.ref).toBe("prompts/buyer-concierge/v1");
    expect(first.activatedAt).toBe(activatedAt.toISOString());
    expect(first.systemPrompt).toContain("Buyer concierge");

    // Second load should hit the cache, not the DB.
    await registry.load("prompts/buyer-concierge/v1");
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("load() throws on unknown ref", async () => {
    const { db } = buildFakeDb({ rows: [] });
    const registry = new DbPromptRegistry({
      databaseUrl: "postgres://unused",
      // @ts-expect-error
      db,
    });
    await expect(registry.load("prompts/nope/v1")).rejects.toThrow(/unknown ref/);
  });

  it("invalidate() forces a re-fetch", async () => {
    const { db } = buildFakeDb({
      rows: [
        {
          ref: "prompts/buyer-concierge/v1",
          systemPrompt: "x",
          activatedAt: new Date(),
        },
      ],
    });
    const registry = new DbPromptRegistry({
      databaseUrl: "postgres://unused",
      // @ts-expect-error
      db,
    });
    await registry.load("prompts/buyer-concierge/v1");
    registry.invalidate("prompts/buyer-concierge/v1");
    await registry.load("prompts/buyer-concierge/v1");
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it("bootstrap() executes one INSERT per seed prompt and sums rowCount", async () => {
    const { db } = buildFakeDb({ rows: [], executeRowCount: 1 });
    const registry = new DbPromptRegistry({
      databaseUrl: "postgres://unused",
      // @ts-expect-error
      db,
    });
    const inserted = await registry.bootstrap();
    // 5 production prompts seed, all return rowCount: 1 in this fake.
    expect(inserted).toBe(5);
    expect(db.execute).toHaveBeenCalledTimes(5);
  });

  it("bootstrap() returns 0 when every row already exists (rowCount=0)", async () => {
    const { db } = buildFakeDb({ rows: [], executeRowCount: 0 });
    const registry = new DbPromptRegistry({
      databaseUrl: "postgres://unused",
      // @ts-expect-error
      db,
    });
    expect(await registry.bootstrap()).toBe(0);
  });
});
