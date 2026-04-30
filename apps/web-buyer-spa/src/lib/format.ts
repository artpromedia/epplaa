import { Country, COUNTRIES, CountryCode } from "./countries";

// `formatPrice` accepts either a full Country object (preferred when you
// already have the active profile) or a country code / currency code string.
// We resolve strings to a Country lazily so call sites scattered across the
// app can stay terse — `formatPrice(amt, country)` or `formatPrice(amt, "NG")`
// or `formatPrice(amt, "NGN")` all work.
type CountryLike = Country | string;

const CURRENCY_TO_COUNTRY: Record<string, CountryCode> = (() => {
  const map: Record<string, CountryCode> = {};
  for (const code of Object.keys(COUNTRIES) as CountryCode[]) {
    const c = COUNTRIES[code];
    // First country claiming a currency wins the lookup, which is fine for
    // formatting (decimals + symbol are identical across the same currency).
    if (!map[c.currency.code]) map[c.currency.code] = code;
  }
  return map;
})();

function resolveCountry(input: CountryLike): Country {
  if (typeof input !== "string") return input;
  const direct = COUNTRIES[input as CountryCode];
  if (direct) return direct;
  const viaCurrency = CURRENCY_TO_COUNTRY[input];
  if (viaCurrency) return COUNTRIES[viaCurrency];
  // Last-resort fallback so we never throw at format time.
  return COUNTRIES.NG;
}

export function formatPrice(amountMinor: number, input: CountryLike): string {
  const country = resolveCountry(input);
  const amountMajor = amountMinor / country.currency.minorPerMajor;

  // Use Intl.NumberFormat for thousands separators
  const formatter = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: country.currency.decimals,
    maximumFractionDigits: country.currency.decimals,
  });

  return `${country.currency.symbol}${formatter.format(amountMajor)}`;
}

/**
 * Format a price using the *order's own* country snapshot. Falls back to the
 * passed-in `fallback` country (current profile) if the order's country code
 * is not in the supported list.
 */
export function formatOrderPrice(
  amountMinor: number,
  countryCode: string,
  fallback: Country,
): string {
  const country = COUNTRIES[countryCode as CountryCode] ?? fallback;
  return formatPrice(amountMinor, country);
}
