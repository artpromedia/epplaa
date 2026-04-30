/**
 * Money formatter — works with minor units (cents/fen/sen). Falls back to a
 * plain `<amount> <currency>` rendering when `Intl.NumberFormat` rejects an
 * unknown ISO code so the UI never crashes on an exotic currency.
 */
export function formatMinor(amountMinor: number, currency: string): string {
  if (!Number.isFinite(amountMinor)) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: 2,
    }).format(amountMinor / 100);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${currency}`;
  }
}
