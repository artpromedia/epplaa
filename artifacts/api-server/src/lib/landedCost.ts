import { dutyRateForHs, vatRateFor } from "./customs";
import { getRate } from "./fx";

/**
 * Server-side landed-cost calculator. Single source of truth used by
 * both the wholesale-quote endpoint (preview) and order placement
 * (frozen breakdown). Mirrors the buyer-facing client estimate in
 * `epplaa-app/src/lib/landed-cost.ts` but uses real FX + HS-driven duty.
 *
 * All input/output amounts are minor units. `originCurrencyCode` is the
 * currency of the FOB price; everything else (freight, insurance, duty,
 * VAT, clearance, landed total) is normalised to `destinationCurrencyCode`.
 */

export type ShipMode = "air" | "sea";

export interface LandedCostInput {
  fobUnitPriceMinor: number;
  qty: number;
  originCurrencyCode: string;
  destinationCurrencyCode: string;
  destinationCountryCode: string;
  hsCode: string;
  shipMode: ShipMode;
  weightGrams: number;
}

export interface LandedCostBreakdown {
  fobMinor: number; // in origin currency
  fobInDestMinor: number; // FOB converted into destination currency
  freightMinor: number;
  insuranceMinor: number;
  dutyMinor: number;
  vatMinor: number;
  clearanceMinor: number;
  landedTotalMinor: number;
  fxRate: number;
  shipMode: ShipMode;
  etaDays: number;
  dutyRate: number;
  vatRate: number;
}

const FREIGHT_USD_PER_KG: Record<ShipMode, number> = {
  // Indicative VN/CN → Lagos rates as of April 2026 (USD per kg).
  air: 6.5,
  sea: 1.2,
};

const SEA_MIN_USD = 80;
const AIR_MIN_USD = 30;
const ETA_DAYS: Record<ShipMode, number> = { air: 7, sea: 28 };

const CLEARANCE_FEE_NGN = 25_000_00; // ₦25,000 flat clearance/handling

export async function computeLandedCost(input: LandedCostInput): Promise<LandedCostBreakdown> {
  const fobMinor = input.fobUnitPriceMinor * input.qty;

  // FX leg: origin → destination
  const fxRate = await getRate(input.originCurrencyCode, input.destinationCurrencyCode);
  const fobInDestMinor = Math.round(fobMinor * fxRate);

  // Freight: USD-quoted then converted into destination currency
  const usdToDest = await getRate("USD", input.destinationCurrencyCode);
  const weightKg = Math.max(0.1, input.weightGrams / 1000) * input.qty;
  const baseUsd = FREIGHT_USD_PER_KG[input.shipMode] * weightKg;
  const minUsd = input.shipMode === "sea" ? SEA_MIN_USD : AIR_MIN_USD;
  const freightUsd = Math.max(baseUsd, minUsd);
  const freightMinor = Math.round(freightUsd * 100 * usdToDest);

  // Insurance: 1% of (FOB + freight)
  const insuranceMinor = Math.round((fobInDestMinor + freightMinor) * 0.01);

  // Duty: HS-based, applied to (FOB + freight + insurance) in destination currency
  const dutyRate = dutyRateForHs(input.hsCode, input.destinationCountryCode);
  const dutiableBase = fobInDestMinor + freightMinor + insuranceMinor;
  const dutyMinor = Math.round(dutiableBase * dutyRate);

  // VAT: applied to (dutiable base + duty)
  const vatRate = vatRateFor(input.destinationCountryCode);
  const vatMinor = Math.round((dutiableBase + dutyMinor) * vatRate);

  // Clearance: flat fee in destination currency. NGN base; FX-convert to other dest.
  const ngnToDest = await getRate("NGN", input.destinationCurrencyCode);
  const clearanceMinor = Math.round(CLEARANCE_FEE_NGN * ngnToDest);

  const landedTotalMinor = fobInDestMinor + freightMinor + insuranceMinor + dutyMinor + vatMinor + clearanceMinor;

  return {
    fobMinor,
    fobInDestMinor,
    freightMinor,
    insuranceMinor,
    dutyMinor,
    vatMinor,
    clearanceMinor,
    landedTotalMinor,
    fxRate,
    shipMode: input.shipMode,
    etaDays: ETA_DAYS[input.shipMode],
    dutyRate,
    vatRate,
  };
}
