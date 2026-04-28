import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "./db";
import { logger } from "./logger";
import { newFxRateId } from "./manufacturers";

/**
 * Cross-border FX rates, normalised to 1 unit of base currency = N units of
 * quote currency. Stored daily; `getRate()` returns the most recent row at
 * or before the given `asOfDate`.
 *
 * Sources (in priority order, most recent wins):
 *   - "cbn"          — Central Bank of Nigeria reference rate (NGN-side)
 *   - "openexchange" — open-source mid-market rate (cross-pair fallback)
 *   - "manual"       — finance ops override
 *   - "seed"         — boot-time defaults (only used until the daily job runs)
 */

/**
 * Reference seed rates (April 2026). Only used if `fx_rates` is empty —
 * the daily refresh job overwrites these with live data.
 */
const SEED_RATES_TO_NGN: Record<string, number> = {
  USD: 1650, // 1 USD ≈ ₦1650
  CNY: 228, // 1 CNY  ≈ ₦228
  VND: 0.067, // 1 VND  ≈ ₦0.067
  JPY: 10.6, // 1 JPY  ≈ ₦10.6
  TWD: 51.2, // 1 TWD  ≈ ₦51.2
  EUR: 1780,
  GBP: 2080,
};

/**
 * Idempotently insert seed rates if `fx_rates` has no rows. Called from
 * `initManufacturerSchema()` after the table is created.
 */
export async function seedFxRatesIfEmpty(): Promise<void> {
  const existing = await db.select({ id: schema.fxRatesTable.id }).from(schema.fxRatesTable).limit(1);
  if (existing.length > 0) return;
  const today = new Date().toISOString().slice(0, 10);
  const rows: (typeof schema.fxRatesTable.$inferInsert)[] = [];
  for (const [base, rate] of Object.entries(SEED_RATES_TO_NGN)) {
    rows.push({
      id: newFxRateId(),
      baseCurrency: base,
      quoteCurrency: "NGN",
      rate,
      source: "seed",
      asOfDate: today,
    });
    // Reverse pair (NGN → base) for convenience.
    rows.push({
      id: newFxRateId(),
      baseCurrency: "NGN",
      quoteCurrency: base,
      rate: 1 / rate,
      source: "seed",
      asOfDate: today,
    });
  }
  // Identity rows for same-currency lookups.
  for (const ccy of [...Object.keys(SEED_RATES_TO_NGN), "NGN"]) {
    rows.push({
      id: newFxRateId(),
      baseCurrency: ccy,
      quoteCurrency: ccy,
      rate: 1,
      source: "seed",
      asOfDate: today,
    });
  }
  await db.insert(schema.fxRatesTable).values(rows).onConflictDoNothing();
  logger.info({ count: rows.length }, "fx_rates_seeded");
}

/**
 * Returns the most recent FX rate for `base → quote`. Uses a two-step
 * lookup if no direct pair is recorded: base→NGN * NGN→quote.
 */
export async function getRate(base: string, quote: string): Promise<number> {
  if (base === quote) return 1;
  const direct = await db
    .select()
    .from(schema.fxRatesTable)
    .where(and(eq(schema.fxRatesTable.baseCurrency, base), eq(schema.fxRatesTable.quoteCurrency, quote)))
    .orderBy(desc(schema.fxRatesTable.asOfDate))
    .limit(1);
  if (direct[0]) return direct[0].rate;
  // Cross via NGN.
  const [toNgn] = await db
    .select()
    .from(schema.fxRatesTable)
    .where(and(eq(schema.fxRatesTable.baseCurrency, base), eq(schema.fxRatesTable.quoteCurrency, "NGN")))
    .orderBy(desc(schema.fxRatesTable.asOfDate))
    .limit(1);
  const [fromNgn] = await db
    .select()
    .from(schema.fxRatesTable)
    .where(and(eq(schema.fxRatesTable.baseCurrency, "NGN"), eq(schema.fxRatesTable.quoteCurrency, quote)))
    .orderBy(desc(schema.fxRatesTable.asOfDate))
    .limit(1);
  if (toNgn && fromNgn) return toNgn.rate * fromNgn.rate;
  // Last-ditch fallback: synthesise from seed table.
  const seedBase = SEED_RATES_TO_NGN[base];
  const seedQuote = SEED_RATES_TO_NGN[quote];
  if (seedBase && seedQuote) return seedBase / seedQuote;
  if (seedBase && quote === "NGN") return seedBase;
  if (seedQuote && base === "NGN") return 1 / seedQuote;
  logger.warn({ base, quote }, "fx_rate_missing_returning_one");
  return 1;
}

/**
 * Convert minor units between currencies. Caller should round; we round
 * to nearest integer minor unit here for convenience.
 */
export async function convertMinor(
  amountMinor: number,
  base: string,
  quote: string,
): Promise<{ amountMinor: number; rate: number }> {
  const rate = await getRate(base, quote);
  return { amountMinor: Math.round(amountMinor * rate), rate };
}

/**
 * Daily FX refresh job, wired into the boot scheduler in `app.ts` on a
 * 24-hour interval. Two operating modes:
 *
 *   1. Production: when `FX_RATES_API_URL` (e.g. CBN feed or OpenExchangeRates
 *      proxy) is set, `fetchLiveRatesToNGN()` pulls JSON of the form
 *      `{ "USD": 1612.5, "CNY": 224.1, ... }` and rows are tagged
 *      `source: "live"` so consumers can distinguish them from fallback data.
 *
 *   2. Dev / no-network fallback: when the env var is absent or the upstream
 *      fetch errors, today's rates are inserted from the static `SEED_RATES_TO_NGN`
 *      table tagged `source: "dev-seed"`. This keeps the lookup path working
 *      offline without lying about the data lineage in the audit/source column.
 *
 * Out of scope for this task (per project objective): live FX hedging and
 * intraday volatility handling — both are tracked as follow-ups.
 */
async function fetchLiveRatesToNGN(): Promise<Record<string, number> | null> {
  const url = process.env.FX_RATES_API_URL;
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const json = (await res.json()) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const ccy of Object.keys(SEED_RATES_TO_NGN)) {
      const v = Number(json[ccy]);
      if (Number.isFinite(v) && v > 0) out[ccy] = v;
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

export async function refreshFxRates(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const live = await fetchLiveRatesToNGN();
  const ratesToNGN = live ?? SEED_RATES_TO_NGN;
  const sourceLabel = live ? "live" : "dev-seed";
  const rows: (typeof schema.fxRatesTable.$inferInsert)[] = [];
  for (const [base, rate] of Object.entries(ratesToNGN)) {
    rows.push({
      id: newFxRateId(),
      baseCurrency: base,
      quoteCurrency: "NGN",
      rate,
      source: sourceLabel,
      asOfDate: today,
    });
    rows.push({
      id: newFxRateId(),
      baseCurrency: "NGN",
      quoteCurrency: base,
      rate: 1 / rate,
      source: sourceLabel,
      asOfDate: today,
    });
  }
  await db.insert(schema.fxRatesTable).values(rows).onConflictDoNothing();
  logger.info({ count: rows.length, asOf: today, source: sourceLabel }, "fx_rates_refreshed");
}

/** Currencies the manufacturer side accepts. */
export const SUPPORTED_ORIGIN_CURRENCIES = ["USD", "CNY", "VND", "JPY", "TWD", "EUR", "GBP"] as const;
export type OriginCurrency = (typeof SUPPORTED_ORIGIN_CURRENCIES)[number];
