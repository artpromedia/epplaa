import { and, eq } from "drizzle-orm";
import { db, schema } from "./db";
import { logger } from "./logger";
import { PROMO_CODES, SEED_FULFILLMENT_LOCATIONS } from "./static";
import { SEED_PRODUCTS, SEED_STREAMS, SEED_REPLAYS } from "./seedCatalog";
import { SEED_VAT_RATES } from "./vat";

const HOUR = 3600 * 1000;

export async function seedDatabaseIfEmpty(): Promise<void> {
  try {
    const existingProducts = await db.select({ id: schema.productsTable.id }).from(schema.productsTable).limit(1);
    if (existingProducts.length === 0) {
      await db.insert(schema.productsTable).values(SEED_PRODUCTS).onConflictDoNothing();
      logger.info({ count: SEED_PRODUCTS.length }, "Seeded products");
    } else {
      // Backfill the freeShipping flag on known seed products so existing
      // databases (seeded before the column was populated) still surface the
      // "Free shipping" badge and filter. Idempotent: the WHERE clause filters
      // on the current value, so once the row is true subsequent boots are
      // no-ops.
      const seedFreeShipping = SEED_PRODUCTS.filter((p) => p.freeShipping === true);
      let updated = 0;
      for (const p of seedFreeShipping) {
        const res = await db
          .update(schema.productsTable)
          .set({ freeShipping: true })
          .where(
            and(
              eq(schema.productsTable.id, p.id),
              eq(schema.productsTable.freeShipping, false),
            ),
          )
          .returning({ id: schema.productsTable.id });
        updated += res.length;
      }
      if (updated > 0) {
        logger.info({ count: updated }, "Backfilled free shipping on seeded products");
      }
    }

    const existingStreams = await db.select({ id: schema.streamsTable.id }).from(schema.streamsTable).limit(1);
    if (existingStreams.length === 0) {
      await db.insert(schema.streamsTable).values(SEED_STREAMS).onConflictDoNothing();
      logger.info({ count: SEED_STREAMS.length }, "Seeded streams");
    }

    const existingReplays = await db.select({ id: schema.replaysTable.id }).from(schema.replaysTable).limit(1);
    if (existingReplays.length === 0) {
      const now = Date.now();
      await db
        .insert(schema.replaysTable)
        .values(
          SEED_REPLAYS.map((r) => ({
            id: r.id,
            hostName: r.hostName,
            hostAvatar: r.hostAvatar,
            posterImage: r.posterImage,
            title: r.title,
            durationLabel: r.durationLabel,
            durationSeconds: r.durationSeconds,
            viewCount: r.viewCount,
            productIds: r.productIds,
            liveStreamId: r.liveStreamId ?? null,
            recordedAt: new Date(now - r.recordedHoursAgo * HOUR),
          })),
        )
        .onConflictDoNothing();
      logger.info({ count: SEED_REPLAYS.length }, "Seeded replays");
    }

    const existingLocs = await db.select({ id: schema.fulfillmentLocationsTable.id }).from(schema.fulfillmentLocationsTable).limit(1);
    if (existingLocs.length === 0) {
      await db.insert(schema.fulfillmentLocationsTable).values(SEED_FULFILLMENT_LOCATIONS).onConflictDoNothing();
      logger.info({ count: SEED_FULFILLMENT_LOCATIONS.length }, "Seeded fulfillment locations");
    }

    const existingPromos = await db.select({ code: schema.promoCodesTable.code }).from(schema.promoCodesTable).limit(1);
    if (existingPromos.length === 0) {
      await db.insert(schema.promoCodesTable).values(Object.values(PROMO_CODES)).onConflictDoNothing();
      logger.info({ count: Object.keys(PROMO_CODES).length }, "Seeded promo codes");
    }

    // Seed VAT rates per country (idempotent — onConflictDoNothing on countryCode PK).
    await db.insert(schema.vatRatesTable).values(SEED_VAT_RATES).onConflictDoNothing();

    // Seed gateway_health rows so the router has somewhere to record events from
    // the very first webhook (otherwise the rolling window logic short-circuits).
    await db
      .insert(schema.gatewayHealthTable)
      .values([
        { gateway: "paystack", successCount: 0, failureCount: 0 },
        { gateway: "flutterwave", successCount: 0, failureCount: 0 },
        { gateway: "devmock", successCount: 0, failureCount: 0 },
      ])
      .onConflictDoNothing();
  } catch (err) {
    logger.error({ err }, "Seed failed");
  }
}
