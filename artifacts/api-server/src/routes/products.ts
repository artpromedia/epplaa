import { Router, type IRouter } from "express";
import { eq, and, ilike, SQL } from "drizzle-orm";
import { db, schema } from "../lib/db";

const router: IRouter = Router();

function rowToProduct(row: typeof schema.productsTable.$inferSelect) {
  return {
    id: row.id,
    title: row.title,
    priceMinor: row.priceMinor,
    originalPriceMinor: row.originalPriceMinor ?? null,
    originCountry: row.originCountry,
    originLabel: row.originLabel,
    sellerName: row.sellerName,
    sellerAvatar: row.sellerAvatar,
    rating: row.rating,
    soldCount: row.soldCount,
    isLiveNow: row.isLiveNow,
    images: row.images,
    variants: row.variants,
    category: row.category,
    countryCode: row.countryCode,
    // Cross-border attribution + wholesale linkage. Buyer product page uses
    // `wholesaleListingId` to fetch a server-computed landed-cost preview
    // from `/api/wholesale/quote`; `manufacturerUserId` is exposed for
    // attribution UI ("Imported by: <factory>").
    manufacturerUserId: row.manufacturerUserId ?? null,
    manufacturerShareBp: row.manufacturerShareBp,
    wholesaleListingId: row.wholesaleListingId ?? null,
  };
}

router.get("/products", async (req, res) => {
  const { countryCode, search, category } = req.query as { countryCode?: string; search?: string; category?: string };
  const conditions: SQL[] = [];
  if (countryCode) conditions.push(eq(schema.productsTable.countryCode, countryCode));
  if (category) conditions.push(eq(schema.productsTable.category, category));
  if (search) conditions.push(ilike(schema.productsTable.title, `%${search}%`));
  const rows = await db
    .select()
    .from(schema.productsTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined);
  res.json(rows.map(rowToProduct));
});

router.get("/products/:productId", async (req, res) => {
  const { productId } = req.params;
  const [row] = await db.select().from(schema.productsTable).where(eq(schema.productsTable.id, productId)).limit(1);
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(rowToProduct(row));
});

export default router;
