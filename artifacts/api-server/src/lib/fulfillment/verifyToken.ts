import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Short-lived signed token issued by `/fulfillment/verify-address` and
 * validated server-side at `POST /orders` so a client cannot fabricate a
 * verification result.
 *
 * The token is `<payloadJson b64url>.<hmacHex>`. The payload binds the
 * verified result (placeId + confidencePct) to a fingerprint of the
 * address the buyer submitted, plus an expiry. At order-placement time we
 * recompute the fingerprint from the order's deliveryAddress and reject
 * the order unless the signature, expiry, AND fingerprint all match.
 */

const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface VerificationPayload {
  v: 1;
  placeId: string;
  confidencePct: number;
  addrHash: string;
  iat: number;
  exp: number;
}

function signingKey(): string {
  // SESSION_SECRET is always present (system-managed). Falling back to a
  // dev-only constant keeps stub mode working in CI without leaking secrets.
  return process.env.SESSION_SECRET ?? "epplaa-dev-fulfillment-secret";
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

/**
 * Stable hash of the address fingerprint. Coordinates are rounded to
 * 5 decimal places (~1m precision) so trivial drift between verify and
 * order-placement doesn't break the binding.
 */
export function addressFingerprint(input: {
  countryCode: string;
  line: string;
  area: string;
  city: string;
  lat?: number;
  lng?: number;
}): string {
  const norm = [
    input.countryCode.toUpperCase().trim(),
    input.line.toLowerCase().replace(/\s+/g, " ").trim(),
    input.area.toLowerCase().replace(/\s+/g, " ").trim(),
    input.city.toLowerCase().replace(/\s+/g, " ").trim(),
    typeof input.lat === "number" ? input.lat.toFixed(5) : "",
    typeof input.lng === "number" ? input.lng.toFixed(5) : "",
  ].join("|");
  return createHmac("sha256", signingKey()).update(`addr:${norm}`).digest("hex").slice(0, 32);
}

export function issueVerificationToken(input: {
  placeId: string;
  confidencePct: number;
  addrHash: string;
}): string {
  const now = Date.now();
  const payload: VerificationPayload = {
    v: 1,
    placeId: input.placeId,
    confidencePct: input.confidencePct,
    addrHash: input.addrHash,
    iat: now,
    exp: now + TOKEN_TTL_MS,
  };
  const json = JSON.stringify(payload);
  const body = b64urlEncode(Buffer.from(json, "utf8"));
  const sig = createHmac("sha256", signingKey()).update(body).digest("hex");
  return `${body}.${sig}`;
}

export type VerifyTokenError = "missing" | "malformed" | "bad_signature" | "expired" | "addr_mismatch";

export function verifyVerificationToken(
  token: string | undefined,
  expected: { addrHash: string; minConfidence: number },
): { ok: true; placeId: string; confidencePct: number } | { ok: false; reason: VerifyTokenError } {
  if (!token) return { ok: false, reason: "missing" };
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [body, sig] = parts as [string, string];
  const expectedSig = createHmac("sha256", signingKey()).update(body).digest("hex");
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expectedSig, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }
  let payload: VerificationPayload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString("utf8")) as VerificationPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload.exp !== "number" || payload.exp < Date.now()) {
    return { ok: false, reason: "expired" };
  }
  if (payload.addrHash !== expected.addrHash) {
    return { ok: false, reason: "addr_mismatch" };
  }
  if (typeof payload.confidencePct !== "number" || payload.confidencePct < expected.minConfidence) {
    return { ok: false, reason: "addr_mismatch" };
  }
  return { ok: true, placeId: payload.placeId, confidencePct: payload.confidencePct };
}
