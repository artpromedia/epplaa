import { pgTable, text, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";

/**
 * Sanctions / PEP screening results. Onboarding fires a screen, and a
 * quarterly cron re-screens every approved seller / manufacturer.
 * If `matchScore` >= 80 the subject is flagged and downstream payouts
 * are blocked until cleared by a compliance reviewer.
 */
export const sanctionsScreeningsTable = pgTable(
  "sanctions_screenings",
  {
    id: text("id").primaryKey(),
    /** Subject Clerk user id. */
    userId: text("user_id").notNull(),
    /** "seller" | "manufacturer" | "buyer". */
    subjectKind: text("subject_kind").notNull().default("seller"),
    /** Provider used ("complyadvantage" | "trulioo" | "stub"). */
    provider: text("provider").notNull().default("stub"),
    /** Snapshot of the subject sent to the provider. */
    subjectName: text("subject_name").notNull().default(""),
    subjectCountry: text("subject_country").notNull().default(""),
    /** 0 = clean, 100 = exact list match. */
    matchScore: integer("match_score").notNull().default(0),
    /** Raw list hits — { listName, entryName, score, ... }[]. */
    listHits: jsonb("list_hits").$type<Record<string, unknown>[]>().notNull().default([]),
    /** "clear" | "flagged" | "blocked" | "pending". */
    status: text("status").notNull().default("pending"),
    /** Reviewer / system note. */
    note: text("note").notNull().default(""),
    /** Required quarterly re-screen target — earliest the system may re-run. */
    nextReviewAt: timestamp("next_review_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("sanctions_user_idx").on(t.userId, t.createdAt),
  ],
);

export type SanctionsScreening = typeof sanctionsScreeningsTable.$inferSelect;
