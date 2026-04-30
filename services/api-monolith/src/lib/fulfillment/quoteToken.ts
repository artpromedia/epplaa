import crypto from "node:crypto";
import { logger } from "../logger";

/**
 * Signed shipping-quote tokens.
 *
 * `/fulfillment/rates` issues one of these per quote it returns. The token
 * binds the (carrier, service, priceMinor, currency, addressFingerprint,
 * cartFingerprint, userId) tuple under an HMAC of `SESSION_SECRET`, so a
 * client cannot tamper with the shipping price or swap the selected
 * service after the quote is issued. `POST /orders` validates the token
 * server-side and overwrites totalsMinor.shipping with the token's
 * priceMinor — the only number we trust for charging the buyer.
 *
 * Tokens expire after 30 minutes; if the cart or address changes the
 * fingerprints no longer match and the order is rejected with a clear
 * "re-quote required" error.
 */

const TTL_MS = 30 * 60 * 1000;
const VERSION = 1;

interface QuoteClaims {
  v: number;
  /** Subject — the buyer the quote was issued to. */
  uid: string;
  /** Carrier id (e.g. "shipbubble"). */
  c: string;
  /** Service id (e.g. "standard"). */
  s: string;
  /** Price in minor units (kobo etc.) — server-of-record amount. */
  p: number;
  /** Currency code (NGN/KES/...). */
  cur: string;
  /** Hash of the shipping address the quote was generated for. */
  addr: string;
  /** Hash of the cart contents (productId+qty pairs) priced at quote time. */
  cart: string;
  /** issued-at unix ms */
  iat: number;
  /** expires-at unix ms */
  exp: number;
}

function secret(): Buffer {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is required to sign shipping quotes");
  return Buffer.from(s, "utf8");
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function hmac(payload: string): string {
  return b64url(crypto.createHmac("sha256", secret()).update(payload).digest());
}

/** Stable hash of an unordered cart so order doesn't matter. */
export function cartFingerprint(items: Array<{ productId: string; qty: number }>): string {
  const norm = items
    .map((it) => `${String(it.productId)}:${Math.max(1, Math.floor(Number(it.qty || 0)))}`)
    .filter(Boolean)
    .sort()
    .join("|");
  return crypto.createHash("sha256").update(norm).digest("hex").slice(0, 32);
}

export interface IssueQuoteTokenInput {
  userId: string;
  carrier: string;
  service: string;
  priceMinor: number;
  currencyCode: string;
  addrHash: string;
  cartHash: string;
}

export function issueQuoteToken(input: IssueQuoteTokenInput): string {
  const now = Date.now();
  const claims: QuoteClaims = {
    v: VERSION,
    uid: input.userId,
    c: input.carrier,
    s: input.service,
    p: Math.max(0, Math.floor(input.priceMinor)),
    cur: input.currencyCode.toUpperCase(),
    addr: input.addrHash,
    cart: input.cartHash,
    iat: now,
    exp: now + TTL_MS,
  };
  const payload = b64url(Buffer.from(JSON.stringify(claims), "utf8"));
  const sig = hmac(payload);
  return `${payload}.${sig}`;
}

export type QuoteVerdict =
  | {
      ok: true;
      carrier: string;
      service: string;
      priceMinor: number;
      currencyCode: string;
    }
  | { ok: false; reason: string };

export interface VerifyQuoteTokenInput {
  userId: string;
  carrier: string;
  service: string;
  currencyCode: string;
  addrHash: string;
  cartHash: string;
  /** Maximum acceptable price the client claims (defensive bound). */
  maxPriceMinor?: number;
}

export function verifyQuoteToken(token: string, expected: VerifyQuoteTokenInput): QuoteVerdict {
  if (!token || typeof token !== "string") return { ok: false, reason: "missing_quote_token" };
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed_quote_token" };
  const [payload, sig] = parts as [string, string];
  let expectedSig: string;
  try {
    expectedSig = hmac(payload);
  } catch (err) {
    logger.error({ err: (err as Error).message }, "quote_token_sign_failed");
    return { ok: false, reason: "server_misconfigured" };
  }
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_quote_signature" };
  }
  let claims: QuoteClaims;
  try {
    claims = JSON.parse(fromB64url(payload).toString("utf8")) as QuoteClaims;
  } catch {
    return { ok: false, reason: "malformed_quote_claims" };
  }
  if (claims.v !== VERSION) return { ok: false, reason: "stale_quote_version" };
  if (Date.now() > claims.exp) return { ok: false, reason: "quote_expired" };
  if (claims.uid !== expected.userId) return { ok: false, reason: "quote_user_mismatch" };
  if (claims.c !== expected.carrier) return { ok: false, reason: "quote_carrier_mismatch" };
  if (claims.s !== expected.service) return { ok: false, reason: "quote_service_mismatch" };
  if (claims.cur !== expected.currencyCode.toUpperCase()) return { ok: false, reason: "quote_currency_mismatch" };
  if (claims.addr !== expected.addrHash) return { ok: false, reason: "quote_address_mismatch" };
  if (claims.cart !== expected.cartHash) return { ok: false, reason: "quote_cart_mismatch" };
  if (typeof expected.maxPriceMinor === "number" && claims.p > expected.maxPriceMinor) {
    return { ok: false, reason: "quote_price_above_bound" };
  }
  return {
    ok: true,
    carrier: claims.c,
    service: claims.s,
    priceMinor: claims.p,
    currencyCode: claims.cur,
  };
}
