import { Country, COUNTRIES, CountryCode } from "./countries";

export function formatPrice(amountMinor: number, country: Country): string {
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
