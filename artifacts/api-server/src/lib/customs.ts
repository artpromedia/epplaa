/**
 * Customs / HS-code helpers. Production would call a tariff API
 * (e.g. WCO, Trade Tariff UK, or NCS Nigeria) — here we use a
 * static lookup table keyed by the first two HS digits (the chapter).
 *
 * Duty rates are illustrative for West-African import lanes (Nigeria
 * dominant). VAT is a flat 7.5% on the dutiable base for NG; other
 * destinations use the rate from `VAT_RATES_BY_DEST`.
 */

const HS_CHAPTER_DUTY: Record<string, number> = {
  // Common consumer-good chapters
  "61": 0.2, // Apparel, knitted
  "62": 0.2, // Apparel, woven
  "64": 0.2, // Footwear
  "33": 0.1, // Beauty / cosmetics
  "85": 0.05, // Electrical machinery (phones, electronics)
  "84": 0.1, // Industrial machinery
  "94": 0.15, // Furniture & lighting
  "95": 0.15, // Toys, games, sports
  "42": 0.2, // Leather goods
  "71": 0.05, // Jewellery (low duty, high VAT effectively)
  "30": 0.0, // Pharmaceuticals (often zero duty)
  "08": 0.05, // Edible fruit
};

const VAT_RATES_BY_DEST: Record<string, number> = {
  NG: 0.075,
  GH: 0.125,
  KE: 0.16,
  ZA: 0.15,
  EG: 0.14,
  MA: 0.2,
  CI: 0.18,
  TZ: 0.18,
  UG: 0.18,
  RW: 0.18,
  ET: 0.15,
  SN: 0.18,
  CM: 0.1925,
  BW: 0.14,
  ZM: 0.16,
  CD: 0.16,
};

const DEFAULT_DUTY = 0.2;
const DEFAULT_VAT = 0.075;

/**
 * Validate an HS code. Accepts 6 to 10 digit numeric strings.
 * Returns null on success or an error message string.
 */
export function validateHsCode(code: string): string | null {
  const digits = code.replace(/\D/g, "");
  if (!digits) return "hs_code_required";
  if (digits.length < 6) return "hs_code_too_short";
  if (digits.length > 10) return "hs_code_too_long";
  if (digits !== code) return "hs_code_must_be_digits";
  return null;
}

/** Returns duty rate (0..1) for the given HS code and destination. */
export function dutyRateForHs(hsCode: string, _destCountryCode: string): number {
  const chapter = (hsCode || "").slice(0, 2);
  return HS_CHAPTER_DUTY[chapter] ?? DEFAULT_DUTY;
}

export function vatRateFor(destCountryCode: string): number {
  return VAT_RATES_BY_DEST[destCountryCode] ?? DEFAULT_VAT;
}

/**
 * Document checklist returned to the manufacturer portal so the operator
 * can see what they still need to upload before the order can clear.
 * The list is intentionally short for v1 — production would branch on
 * commodity type and destination country.
 */
export interface CustomsDocItem {
  code: string;
  label: string;
  required: boolean;
}

export function requiredDocsForOrder(_destCountryCode: string): CustomsDocItem[] {
  return [
    { code: "commercial_invoice", label: "Commercial Invoice", required: true },
    { code: "packing_list", label: "Packing List", required: true },
    { code: "bill_of_lading", label: "Bill of Lading / Air Waybill", required: true },
    { code: "form_m", label: "Form M (Nigeria) / equivalent import permit", required: true },
    { code: "soncap", label: "SONCAP / destination quality certificate", required: false },
    { code: "certificate_of_origin", label: "Certificate of Origin", required: false },
  ];
}
