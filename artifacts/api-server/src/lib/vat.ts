import { eq } from "drizzle-orm";
import { db, schema } from "./db";

/**
 * Static VAT rates seeded into the database on boot. Basis points (750 = 7.5%).
 * Nigeria is the only country charging marketplace VAT today; other countries
 * default to 0 until their tax registration completes.
 */
export const SEED_VAT_RATES: Array<{ countryCode: string; rateBp: number; appliesToB2c: boolean }> = [
  { countryCode: "NG", rateBp: 750, appliesToB2c: true },
  { countryCode: "GH", rateBp: 0, appliesToB2c: true },
  { countryCode: "KE", rateBp: 0, appliesToB2c: true },
  { countryCode: "ZA", rateBp: 0, appliesToB2c: true },
  { countryCode: "CI", rateBp: 0, appliesToB2c: true },
];

const cache = new Map<string, { rateBp: number; appliesToB2c: boolean; loadedAt: number }>();
const CACHE_TTL_MS = 60_000;

export async function getVatRateBp(countryCode: string): Promise<number> {
  const cached = cache.get(countryCode);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached.rateBp;
  const [row] = await db
    .select()
    .from(schema.vatRatesTable)
    .where(eq(schema.vatRatesTable.countryCode, countryCode))
    .limit(1);
  const rateBp = row?.rateBp ?? 0;
  const appliesToB2c = row?.appliesToB2c ?? true;
  cache.set(countryCode, { rateBp, appliesToB2c, loadedAt: Date.now() });
  return rateBp;
}

/** Compute VAT in minor units. Returns the VAT amount (rounded). */
export function computeVatMinor(taxableMinor: number, rateBp: number): number {
  return Math.round((taxableMinor * rateBp) / 10000);
}
