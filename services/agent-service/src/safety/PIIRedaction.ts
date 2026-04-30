/**
 * PIIRedaction — pre-processing pass to redact PII before LLM calls.
 *
 * @see §14.9.2 (PII Redaction)
 *
 * Redacts:
 *   - Nigerian phone numbers (e.g., +234XXXXXXXXXX, 0XXXXXXXXXX)
 *   - BVN fragments (11-digit sequences starting with typical BVN prefixes)
 *   - NIN fragments (11-digit sequences)
 *   - Named entities (names, addresses) — hook for NER model
 *
 * Redacted content is replaced with [REDACTED:<type>] placeholders.
 * The original content is NEVER sent to any LLM provider.
 *
 * AI Sprint 0: regex-based rules implemented; NER hook is a stub.
 */

export type RedactionType = "PHONE" | "BVN" | "NIN" | "NAME" | "ADDRESS";

export interface RedactionResult {
  /** The redacted text, safe to send to an LLM provider. */
  redactedText: string;
  /** Number of substitutions made per type. */
  counts: Record<RedactionType, number>;
}

// ---------------------------------------------------------------------------
// Regex patterns for Nigerian PII
// ---------------------------------------------------------------------------

// Nigerian phone: +234XXXXXXXXXX or 0XXXXXXXXXX (7-10 additional digits)
const PHONE_PATTERN = /(?:\+234|0)[789]\d{9}/g;

// BVN: 11-digit number (Nigerian Bank Verification Number)
// Real BVNs start with specific digits; we match any 11-digit sequence
// that appears in isolation (word boundaries) as a conservative heuristic.
const BVN_PATTERN = /\b\d{11}\b/g;

// NIN: same structure as BVN (11 digits); we use the same pattern and
// label them both, since both are high-sensitivity.
// In practice, context (the word "BVN" or "NIN" nearby) disambiguates.

// ---------------------------------------------------------------------------
// Main redaction function
// ---------------------------------------------------------------------------

/**
 * Redacts known Nigerian PII patterns from user input.
 * Call this before passing any user content to wrapUserContent() or the
 * LLM gateway.
 *
 * @see §14.9.2
 */
export function redact(text: string): RedactionResult {
  const counts: Record<RedactionType, number> = {
    PHONE: 0,
    BVN: 0,
    NIN: 0,
    NAME: 0,
    ADDRESS: 0,
  };

  let result = text;

  // 1. Phone numbers
  result = result.replace(PHONE_PATTERN, () => {
    counts.PHONE += 1;
    return "[REDACTED:PHONE]";
  });

  // 2. BVN/NIN (11-digit sequences; both are treated as high-sensitivity)
  result = result.replace(BVN_PATTERN, (match) => {
    // Heuristic: prefer BVN label since it's more common in e-commerce context.
    // TODO (AI Sprint 8): use context window to distinguish BVN vs NIN.
    if (match.startsWith("2") || match.startsWith("3")) {
      counts.BVN += 1;
      return "[REDACTED:BVN]";
    }
    counts.NIN += 1;
    return "[REDACTED:NIN]";
  });

  // 3. Named entities — NER hook (stub)
  // TODO (AI Sprint 8): call nerRedact(result) to redact names and addresses.

  return { redactedText: result, counts };
}

/**
 * NER-based name and address redaction hook.
 * TODO (AI Sprint 8): integrate a local NER model (e.g., Hugging Face
 * transformers via Node.js binding) to detect and redact names/addresses.
 *
 * @see §14.9.2
 */
export async function nerRedact(text: string): Promise<RedactionResult> {
  // TODO (AI Sprint 8): run NER inference; replace NAME and ADDRESS entities.
  // For now, return the regex-only result.
  return redact(text);
}
