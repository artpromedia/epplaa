import { Router, type IRouter } from "express";
import { inArray } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { logger } from "../lib/logger";
import { aggregateQuotes, verifyAddress } from "../lib/fulfillment";
import type { ShipmentItem, ShippingAddress } from "../lib/fulfillment";
import { addressFingerprint, issueVerificationToken } from "../lib/fulfillment/verifyToken";
import { cartFingerprint, issueQuoteToken } from "../lib/fulfillment/quoteToken";
import { getUserId } from "../lib/auth";

const router: IRouter = Router();

const DEFAULT_ITEM_WEIGHT_G = 500;

/**
 * POST /fulfillment/verify-address
 *
 * Wrap the OkHi address-verification adapter. Returns a place id and a
 * confidence score (0-100). The frontend gates "Continue" on confidence
 * >= 70 for home-delivery orders; below that we steer the buyer to a
 * Box / PUDO instead of risking a failed delivery attempt.
 */
router.post("/fulfillment/verify-address", async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const countryCode = String(body.countryCode ?? "").toUpperCase();
  const line = String(body.line ?? "").trim();
  const area = String(body.area ?? "").trim();
  const city = String(body.city ?? "").trim();
  if (!countryCode || !line) {
    res.status(400).json({ error: "bad_request", detail: "countryCode and line are required" });
    return;
  }
  const lat = typeof body.lat === "number" ? body.lat : undefined;
  const lng = typeof body.lng === "number" ? body.lng : undefined;
  try {
    const result = await verifyAddress({ countryCode, line, area, city, lat, lng });
    // Issue a short-lived signed token bound to the address fingerprint
    // so POST /orders can verify the buyer really went through OkHi for
    // exactly this address.
    const addrHash = addressFingerprint({ countryCode, line, area, city, lat, lng });
    const verificationToken = issueVerificationToken({
      placeId: result.placeId,
      confidencePct: result.confidencePct,
      addrHash,
    });
    res.json({ ...result, verificationToken });
  } catch (err) {
    logger.error({ err: (err as Error).message }, "verify_address_failed");
    res.status(500).json({ error: "verify_failed" });
  }
});

interface RateRequestBody {
  optionId?: string;
  currencyCode?: string;
  destination?: Partial<ShippingAddress>;
  items?: Array<{ productId?: string; qty?: number }>;
}

/**
 * POST /fulfillment/rates
 *
 * Aggregate live carrier quotes for a checkout. The frontend calls this
 * once the address (or pickup point) has been chosen — the response is the
 * canonical list of (carrier, service, price, eta) cards rendered on the
 * delivery-method screen. Items are resolved server-side from the
 * products table so the buyer cannot tamper with declared value.
 */
router.post("/fulfillment/rates", async (req, res) => {
  const body = req.body as RateRequestBody;
  const currencyCode = String(body.currencyCode ?? "NGN").toUpperCase();
  const destInput = body.destination ?? {};
  const destination: ShippingAddress = {
    line: String(destInput.line ?? ""),
    area: String(destInput.area ?? ""),
    city: String(destInput.city ?? ""),
    state: typeof destInput.state === "string" ? destInput.state : undefined,
    countryCode: String(destInput.countryCode ?? "NG").toUpperCase(),
    postcode: typeof destInput.postcode === "string" ? destInput.postcode : undefined,
    lat: typeof destInput.lat === "number" ? destInput.lat : undefined,
    lng: typeof destInput.lng === "number" ? destInput.lng : undefined,
    placeId: typeof destInput.placeId === "string" ? destInput.placeId : undefined,
  };
  const cleanItems = (body.items ?? [])
    .map((it) => ({
      productId: String(it.productId ?? "").trim(),
      qty: Math.max(1, Math.floor(Number(it.qty ?? 0))),
    }))
    .filter((it) => it.productId && it.qty > 0);
  if (cleanItems.length === 0) {
    res.status(400).json({ error: "bad_request", detail: "items required" });
    return;
  }
  const productRows = await db
    .select({
      id: schema.productsTable.id,
      title: schema.productsTable.title,
      priceMinor: schema.productsTable.priceMinor,
    })
    .from(schema.productsTable)
    .where(inArray(schema.productsTable.id, Array.from(new Set(cleanItems.map((i) => i.productId)))));
  const productMap = new Map(productRows.map((p) => [p.id, p]));
  const items: ShipmentItem[] = cleanItems
    .map((it): ShipmentItem | null => {
      const p = productMap.get(it.productId);
      if (!p) return null;
      return {
        productId: p.id,
        qty: it.qty,
        weightG: DEFAULT_ITEM_WEIGHT_G,
        valueMinor: p.priceMinor * it.qty,
        description: p.title,
      };
    })
    .filter((x): x is ShipmentItem => x !== null);
  if (items.length === 0) {
    res.status(400).json({ error: "bad_request", detail: "no_known_items" });
    return;
  }
  try {
    const quotes = await aggregateQuotes({
      origin: {
        line: "Epplaa Hub",
        area: "Ikoyi",
        city: "Lagos",
        state: "Lagos",
        countryCode: "NG",
      },
      destination,
      items,
      currencyCode,
      optionId: body.optionId,
    });
    // Sign each quote so POST /orders can validate that the buyer is
    // submitting a real server-issued (carrier, service, priceMinor) tuple
    // for THIS user, address, and cart — and not a tampered shipping
    // amount. Anonymous callers get unsigned quotes (the order endpoint
    // will reject them at submission time, steering the buyer to sign
    // in).
    const userId = getUserId(req);
    const addrHash = addressFingerprint({
      countryCode: destination.countryCode,
      line: destination.line,
      area: destination.area,
      city: destination.city,
      lat: destination.lat,
      lng: destination.lng,
    });
    const cartHash = cartFingerprint(cleanItems);
    const signed = quotes.map((q) => ({
      ...q,
      ...(userId
        ? {
            quoteToken: issueQuoteToken({
              userId,
              carrier: q.carrier,
              service: q.service,
              priceMinor: q.priceMinor,
              currencyCode: q.currencyCode,
              addrHash,
              cartHash,
            }),
          }
        : {}),
    }));
    res.json({ quotes: signed });
  } catch (err) {
    logger.error({ err: (err as Error).message }, "rates_failed");
    res.status(500).json({ error: "rates_failed" });
  }
});

export default router;
