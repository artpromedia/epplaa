import { Router, type IRouter } from "express";
import { eq, and, SQL } from "drizzle-orm";
import { db, schema } from "../lib/db";

const router: IRouter = Router();

router.get("/fulfillment-locations", async (req, res) => {
  const { countryCode, optionId } = req.query as { countryCode?: string; optionId?: string };
  if (!countryCode) {
    res.status(400).json({ error: "bad_request", detail: "countryCode required" });
    return;
  }
  const conditions: SQL[] = [eq(schema.fulfillmentLocationsTable.countryCode, countryCode)];
  if (optionId) conditions.push(eq(schema.fulfillmentLocationsTable.optionId, optionId));
  const rows = await db
    .select()
    .from(schema.fulfillmentLocationsTable)
    .where(and(...conditions));
  res.json(rows);
});

export default router;
