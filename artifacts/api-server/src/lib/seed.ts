import { db, schema } from "./db";
import { logger } from "./logger";
import { PROMO_CODES, SEED_FULFILLMENT_LOCATIONS } from "./static";
import { SEED_PRODUCTS, SEED_STREAMS, SEED_REPLAYS } from "./seedCatalog";

const HOUR = 3600 * 1000;

export async function seedDatabaseIfEmpty(): Promise<void> {
  try {
    const existingProducts = await db.select({ id: schema.productsTable.id }).from(schema.productsTable).limit(1);
    if (existingProducts.length === 0) {
      await db.insert(schema.productsTable).values(SEED_PRODUCTS).onConflictDoNothing();
      logger.info({ count: SEED_PRODUCTS.length }, "Seeded products");
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
  } catch (err) {
    logger.error({ err }, "Seed failed");
  }
}
