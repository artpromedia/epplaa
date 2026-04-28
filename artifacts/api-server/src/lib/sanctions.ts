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
  // Real providers (ComplyAdvantage, Trulioo, Refinitiv) would be wired in
  // here keyed off SANCTIONS_PROVIDER. Until that integration lands the
  // unknown-provider branch fails-closed in production.
  if (process.env.NODE_ENV === "production") {
    throw new Error(`SANCTIONS_PROVIDER=${provider} is not implemented`);
  }
  logger.warn({ provider }, "sanctions_provider_not_implemented_using_stub");
  return "stub";
}

/**
 * Screen a subject against the configured sanctions provider. In production
 * the stub provider is treated as a hard fail-closed: every screen returns
 * `status='blocked'` so payouts halt rather than letting an un-vetted
 * recipient through. This satisfies the "no real money moves until OFAC/UN/
 * EU/Nigeria coverage is in place" guarantee even though the provider
 * integration itself is owned by a separate task. Operators must set
 * SANCTIONS_PROVIDER to a real provider AND extend the dispatch below
 * before the production payout gate will open.
 */
export async function screenSubject(input: ScreenInput): Promise<ScreenResult> {
  const provider = selectProvider();
  const isProd = process.env.NODE_ENV === "production";
  const failClosed = provider === "stub" && isProd;
  const result: ScreenResult = failClosed
    ? {
        provider: "stub",
        matchScore: 100,
        listHits: [
          {
            listName: "internal",
            entryName: "no_real_sanctions_provider_configured",
            score: 100,
          },
        ],
        status: "blocked",
        nextReviewAt: new Date(Date.now() + 24 * 3600 * 1000), // re-check daily
      }
    : provider === "stub"
      ? stubScreen(input)
      : stubScreen(input);
  if (failClosed) {
    logger.error(
      { userId: input.userId },
      "sanctions_failclosed_no_real_provider_in_production",
    );
  }
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
  // Pull only the LATEST screening row per user, then filter to those whose
  // most recent nextReviewAt is in the past. Selecting all overdue rows
  // would re-process every historical screening every sweep, which both
  // wastes provider calls and hides genuine fresh dueness behind ancient
  // backlog rows. The latest row is the system-of-record for each user.
  const latestPerUser = await db
    .select({
      id: schema.sanctionsScreeningsTable.id,
      userId: schema.sanctionsScreeningsTable.userId,
      nextReviewAt: schema.sanctionsScreeningsTable.nextReviewAt,
      createdAt: schema.sanctionsScreeningsTable.createdAt,
    })
    .from(schema.sanctionsScreeningsTable)
    .orderBy(desc(schema.sanctionsScreeningsTable.createdAt));
  const seen = new Set<string>();
  const due: Array<{ id: string; userId: string }> = [];
  const now = new Date();
  for (const row of latestPerUser) {
    if (seen.has(row.userId)) continue;
    seen.add(row.userId);
    if (row.nextReviewAt && row.nextReviewAt <= now) {
      due.push({ id: row.id, userId: row.userId });
      if (due.length >= 100) break;
    }
  }
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

/**
 * Manufacturer-side payout gate. Manufacturers don't go through the seller
 * onboarding flow (their KYC + bank details live in a separate cross-border
 * system), so they may not have a `sanctions_screenings` row yet at first
 * payout. We bootstrap one on demand using the user record (displayName +
 * countryCode), then enforce the same fail-closed rule as for sellers:
 * blocked / flagged → no payout.
 *
 * This satisfies "every onboarded seller AND manufacturer is screened at
 * onboarding and quarterly" — once bootstrapped, the manufacturer's row
 * lives in the same table the quarterly resweep walks.
 */
export async function manufacturerSanctionsBlocked(userId: string): Promise<boolean> {
  const [latest] = await db
    .select()
    .from(schema.sanctionsScreeningsTable)
    .where(eq(schema.sanctionsScreeningsTable.userId, userId))
    .orderBy(desc(schema.sanctionsScreeningsTable.createdAt))
    .limit(1);
  if (!latest) {
    const [user] = await db
      .select({ id: schema.usersTable.clerkId, displayName: schema.usersTable.displayName, countryCode: schema.usersTable.countryCode })
      .from(schema.usersTable)
      .where(eq(schema.usersTable.clerkId, userId))
      .limit(1);
    if (!user) return true; // unknown user → fail closed
    const result = await screenSubject({
      userId,
      name: user.displayName?.trim() || `Manufacturer ${userId.slice(-6)}`,
      country: user.countryCode || "NG",
    });
    return result.status === "blocked" || result.status === "flagged";
  }
  return latest.status === "blocked" || latest.status === "flagged";
}

/**
 * Boot-time backfill: ensure every distinct manufacturer referenced by any
 * product has at least one `sanctions_screenings` row. Manufacturers don't
 * have a dedicated onboarding route in this codebase — they're attributed
 * to products at seed/import time — so without this pass the quarterly
 * resweep would silently skip any manufacturer whose first payout has not
 * yet been scheduled. Calling this from app boot guarantees the resweep
 * walks the full population and that the very first payout for any
 * manufacturer never wires before a screen has happened.
 *
 * Idempotent: skips manufacturers that already have a row. We screen with
 * the same authoritative inputs (users.displayName + countryCode) used by
 * `manufacturerSanctionsBlocked`, so re-running is cheap.
 */
export async function bootstrapAllManufacturerScreenings(): Promise<{ screened: number; blocked: number }> {
  const rows = await db
    .selectDistinct({ manufacturerUserId: schema.productsTable.manufacturerUserId })
    .from(schema.productsTable);
  let screened = 0;
  let blocked = 0;
  for (const r of rows) {
    const userId = r.manufacturerUserId;
    if (!userId) continue;
    const [existing] = await db
      .select({ id: schema.sanctionsScreeningsTable.id })
      .from(schema.sanctionsScreeningsTable)
      .where(eq(schema.sanctionsScreeningsTable.userId, userId))
      .limit(1);
    if (existing) continue;
    const [user] = await db
      .select({ displayName: schema.usersTable.displayName, countryCode: schema.usersTable.countryCode })
      .from(schema.usersTable)
      .where(eq(schema.usersTable.clerkId, userId))
      .limit(1);
    const result = await screenSubject({
      userId,
      name: user?.displayName?.trim() || `Manufacturer ${userId.slice(-6)}`,
      country: user?.countryCode || "NG",
    });
    screened++;
    if (result.status === "blocked" || result.status === "flagged") blocked++;
  }
  if (screened > 0) {
    logger.info({ screened, blocked }, "manufacturer_sanctions_bootstrap_completed");
  }
  return { screened, blocked };
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
