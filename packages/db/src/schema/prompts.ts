import {
  pgTable,
  text,
  varchar,
  timestamp,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Prompts table.
 *
 * Each row is one immutable version of a prompt. The "active" pointer is
 * a boolean flag on the version — at most one row per `ref` family may be
 * active at a time. Rollback = flip `isActive` from one version to its
 * predecessor; old rows are retained for audit.
 *
 * `ref` examples:
 *   - "prompts/vendor-onboarding/v1"
 *   - "prompts/vendor-onboarding/v1.1"
 * The base name ("vendor-onboarding") is used for grouping in the admin UI.
 *
 * @see §14.6 Prompt Registry
 */
export const promptsTable = pgTable(
  "prompts",
  {
    id: text("id").primaryKey(),
    ref: text("ref").notNull(),
    family: varchar("family", { length: 128 }).notNull(),
    version: varchar("version", { length: 32 }).notNull(),
    systemPrompt: text("system_prompt").notNull(),
    isActive: boolean("is_active").notNull().default(false),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: text("created_by"),
  },
  (table) => ({
    refUnique: uniqueIndex("prompts_ref_idx").on(table.ref),
  }),
);

export type PromptRow = typeof promptsTable.$inferSelect;
export type PromptInsert = typeof promptsTable.$inferInsert;
