import { eq, desc, and, lte } from "drizzle-orm";
import { db, schema } from "./db";
import { logger } from "./logger";
import { recordAudit } from "./audit";

export interface ScreenInput {
  userId: string;
  subjectKind?: "seller" | "manufacturer" | "buyer";
  name: string;
  country: string;
}

export interface ScreenResult {
  matchScore: number;
  status: "clear" | "flagged" | "blocked" | "pending";
  listHits: Array<{ listName: string; entryName: string; score: number }>;
  provider: string;
  nextReviewAt: Date;
}

const QUARTER_MS = 90 * 24 * 3600 * 1000;
const FLAG_THRESHOLD = 80;

/**
 * Stub sanctions screen — used when no real provider is configured. Returns
 * a flagged result if the subject name contains the literal token "BLOCKED"
 * (used by tests to drive the flagged path) or if the country is on a
 * sample sanctions list. Real providers (ComplyAdvantage / Trulioo) plug
 * in via `SANCTIONS_PROVIDER`.
 */
function stubScreen(input: ScreenInput): ScreenResult {
  const sample = ["KP", "IR", "SY", "CU"]; // illustrative — real list is much longer
  const nextReviewAt = new Date(Date.now() + QUARTER_MS);
  const upper = input.name.toUpperCase();
  if (upper.includes("BLOCKED")) {
    return {
      provider: "stub",
      matchScore: 100,
      status: "blocked",
      listHits: [{ listName: "OFAC-SDN-STUB", entryName: input.name, score: 100 }],
      nextReviewAt,
    };
  }
  if (sample.includes(input.country.toUpperCase())) {
    return {
      provider: "stub",
      matchScore: 90,
      status: "flagged",
      listHits: [{ listName: "GEO-EMBARGO-STUB", entryName: input.country, score: 90 }],
      nextReviewAt,
    };
  }
  return { provider: "stub", matchScore: 0, status: "clear", listHits: [], nextReviewAt };
}

function selectProvider(): "stub" {
  const provider = process.env.SANCTIONS_PROVIDER;
  if (!provider || provider === "stub") return "stub";
  // Real providers would be initialized here. We log and fall back to stub
  // in non-prod, fail-closed in prod.
  if (process.env.NODE_ENV === "production") {
    throw new Error(`SANCTIONS_PROVIDER=${provider} is not implemented`);
  }
  logger.warn({ provider }, "sanctions_provider_not_implemented_using_stub");
  return "stub";
}

export async function screenSubject(input: ScreenInput): Promise<ScreenResult> {
  const provider = selectProvider();
  const result = provider === "stub" ? stubScreen(input) : stubScreen(input);
  const id = `sx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  await db.insert(schema.sanctionsScreeningsTable).values({
    id,
    userId: input.userId,
    subjectKind: input.subjectKind ?? "seller",
    provider: result.provider,
    subjectName: input.name,
    subjectCountry: input.country,
    matchScore: result.matchScore,
    listHits: result.listHits,
    status: result.status,
    nextReviewAt: result.nextReviewAt,
  });
  // Project status onto seller row.
  if (result.status === "clear") {
    await db
      .insert(schema.sellersTable)
      .values({ userId: input.userId, sanctionsClearedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.sellersTable.userId,
        set: { sanctionsClearedAt: new Date() },
      });
  } else if (result.status === "blocked" || result.status === "flagged") {
    await db
      .insert(schema.sellersTable)
      .values({ userId: input.userId, sanctionsClearedAt: null })
      .onConflictDoUpdate({
        target: schema.sellersTable.userId,
        set: { sanctionsClearedAt: null },
      });
  }
  await recordAudit({
    actorId: null,
    action: "sanctions.screened",
    entity: "user",
    entityId: input.userId,
    payload: { provider: result.provider, matchScore: result.matchScore, status: result.status },
  });
  return result;
}

/**
 * Quarterly re-screen sweep. Picks up sellers whose `nextReviewAt` is in the
 * past (or null) and runs a fresh screen.
 */
export async function quarterlyResweep(): Promise<{ rescreened: number; blocked: number }> {
  const due = await db
    .select({ id: schema.sanctionsScreeningsTable.id, userId: schema.sanctionsScreeningsTable.userId })
    .from(schema.sanctionsScreeningsTable)
    .where(lte(schema.sanctionsScreeningsTable.nextReviewAt, new Date()))
    .limit(100);
  let blocked = 0;
  for (const row of due) {
    // Pull the latest snapshot from the seller application for fresh inputs.
    const [seller] = await db.select().from(schema.sellersTable).where(eq(schema.sellersTable.userId, row.userId)).limit(1);
    if (!seller) continue;
    const application = (seller.application ?? {}) as { businessName?: string; legalName?: string; country?: string };
    const name = application.legalName ?? application.businessName ?? row.userId;
    const country = application.country ?? "NG";
    const result = await screenSubject({ userId: row.userId, name, country });
    if (result.status === "blocked" || result.status === "flagged") blocked++;
  }
  if (due.length > 0) {
    logger.info({ rescreened: due.length, blocked }, "sanctions_resweep_completed");
  }
  return { rescreened: due.length, blocked };
}

/** Check whether a seller is currently sanctions-blocked from receiving payouts. */
export async function sellerSanctionsBlocked(userId: string): Promise<boolean> {
  const [latest] = await db
    .select()
    .from(schema.sanctionsScreeningsTable)
    .where(and(eq(schema.sanctionsScreeningsTable.userId, userId)))
    .orderBy(desc(schema.sanctionsScreeningsTable.createdAt))
    .limit(1);
  // Conservative default: an unscreened seller is treated as blocked from
  // payouts. Sellers are screened on apply and on kyc/start, so the only
  // way to land here is a misconfiguration or a legacy account; we'd rather
  // hold the funds than wire to an un-vetted recipient.
  if (!latest) return true;
  return latest.status === "blocked" || latest.status === "flagged";
}
