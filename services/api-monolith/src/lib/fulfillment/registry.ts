import { ShipbubbleCarrier } from "./shipbubble";
import { GigCarrier } from "./gig";
import { BoxCarrier } from "./boxLocker";
import type { Carrier, RateQuote, RateRequest } from "./types";

/**
 * Carrier registry. Picks the right carrier(s) for a given fulfillment
 * option and aggregates quotes across multiple providers so the buyer can
 * compare. Box / pickup-point optionIds are routed exclusively to the
 * BoxCarrier (no external 3PL needed for in-locker stock); home-delivery
 * options aggregate Shipbubble + GIG.
 */

const BOX_OPTION_HINTS = ["box", "locker"];
const PUDO_OPTION_HINTS = ["pudo", "pickup", "paxi", "pargo", "speedaf", "g4s"];

const carriers: Record<string, Carrier> = {
  shipbubble: new ShipbubbleCarrier(),
  gig: new GigCarrier(),
  box: new BoxCarrier(),
};

export function getCarrier(code: string): Carrier {
  const c = carriers[code];
  if (!c) throw new Error(`unknown_carrier:${code}`);
  return c;
}

export function listCarriers(): Carrier[] {
  return Object.values(carriers);
}

function isBoxOption(optionId: string | undefined): boolean {
  if (!optionId) return false;
  const id = optionId.toLowerCase();
  return BOX_OPTION_HINTS.some((h) => id.includes(h));
}

function isPudoOption(optionId: string | undefined): boolean {
  if (!optionId) return false;
  const id = optionId.toLowerCase();
  return PUDO_OPTION_HINTS.some((h) => id.includes(h));
}

/**
 * Aggregate quotes from the right set of carriers for the requested option.
 *  - box / pickup-point options: Box only (PUDO-style pickup uses the
 *    same Box adapter for the dispatch contract; the actual partner is
 *    captured via fulfillment_locations.partnerCode for the manifest).
 *  - everything else (home delivery): Shipbubble + GIG.
 */
export async function aggregateQuotes(req: RateRequest): Promise<RateQuote[]> {
  const codes: string[] = isBoxOption(req.optionId) || isPudoOption(req.optionId)
    ? ["box"]
    : ["shipbubble", "gig"];
  const settled = await Promise.allSettled(codes.map((c) => carriers[c]!.quote(req)));
  const out: RateQuote[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled") out.push(...r.value);
  }
  // Sort cheapest first so the default selection in the UI is the lowest
  // price within the carrier set the user picked.
  out.sort((a, b) => a.priceMinor - b.priceMinor);
  return out;
}
