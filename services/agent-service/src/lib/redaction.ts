/**
 * PII redaction helpers used before exporting agent trace data to
 * Langfuse (or any other third-party observability sink).
 *
 * Scope:
 *   - email addresses
 *   - Nigerian phone numbers (E.164 +234… and local 0[789]XXXXXXXXX)
 *   - card PANs (13-19 digits, optional spaces/dashes; Luhn-check before
 *     redacting to avoid false positives on plain order ids)
 *   - BVN / NIN-like 11-digit identifiers (always treated as sensitive)
 *   - Nigerian bank account numbers (10 contiguous digits) — redacted
 *     only when prefixed by an account-related token to avoid mangling
 *     order totals or product ids.
 *
 * Each pattern replaces the match with `[REDACTED:<kind>]`. We never
 * "decode" what was redacted -- the goal is to keep the data out of
 * vendor logs at all, not provide a reversible mask.
 *
 * IMPORTANT: keep this list conservative. The trace is the operator's
 * primary debugging surface, so over-redacting hurts. The comprehensive
 * filter is enforced at the model gateway level before the prompt is
 * sent; this function is the last line of defence for data that has
 * already been processed.
 */

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE_NG_RE = /(?:\+234|234)[\s-]?[789]\d{9}|0[789]\d{9}/g;
const ID11_RE = /\b\d{11}\b/g; // BVN / NIN
const ACCOUNT_RE = /\b(account|acct|bvn|nin)[^\d]{0,8}\d{10,11}\b/gi;
// PAN: 13–19 digits with optional spaces/dashes between groups.
const PAN_RE = /\b(?:\d[ -]?){12,18}\d\b/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const charAt = digits.charAt(i);
    let n = Number.parseInt(charAt, 10);
    if (Number.isNaN(n)) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Apply all patterns to a single string; non-strings pass through. */
export function redactString(input: string): string {
  if (!input) return input;
  let out = input;
  out = out.replace(ACCOUNT_RE, "[REDACTED:account]");
  out = out.replace(EMAIL_RE, "[REDACTED:email]");
  out = out.replace(PAN_RE, (m) => {
    const digits = m.replace(/[^\d]/g, "");
    return digits.length >= 13 && digits.length <= 19 && luhnValid(digits)
      ? "[REDACTED:pan]"
      : m;
  });
  out = out.replace(PHONE_NG_RE, "[REDACTED:phone]");
  out = out.replace(ID11_RE, "[REDACTED:id11]");
  return out;
}

/**
 * Recursively redact every string in a JSON-like value. Returns a new
 * value; the input is not mutated. Cycles are guarded via a WeakSet.
 */
export function redactJson<T>(value: T): T {
  return walk(value, new WeakSet()) as T;
}

function walk(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return "[REDACTED:cycle]";
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((v) => walk(v, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = walk(v, seen);
  }
  return out;
}
