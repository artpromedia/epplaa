import { Country } from "./countries";

export function formatPrice(amountMinor: number, country: Country): string {
  const amountMajor = amountMinor / country.currency.minorPerMajor;
  
  // Use Intl.NumberFormat for thousands separators
  const formatter = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: country.currency.decimals,
    maximumFractionDigits: country.currency.decimals,
  });
  
  return `${country.currency.symbol}${formatter.format(amountMajor)}`;
}
