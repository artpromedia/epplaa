import { SEED_PRODUCTS } from "./seed";

export type SeedProduct = (typeof SEED_PRODUCTS)[number];

export interface SearchFilters {
  query: string;
  category: string | null;
  minPriceMinor: number | null;
  maxPriceMinor: number | null;
  minRating: number | null;
  freeShippingOnly: boolean;
  liveNowOnly: boolean;
  sort: "relevance" | "price_asc" | "price_desc" | "rating" | "popular";
}

export const DEFAULT_FILTERS: SearchFilters = {
  query: "",
  category: null,
  minPriceMinor: null,
  maxPriceMinor: null,
  minRating: null,
  freeShippingOnly: false,
  liveNowOnly: false,
  sort: "relevance",
};

export interface Category {
  id: string;
  label: string;
  emoji: string;
  match: (p: SeedProduct) => boolean;
}

export const CATEGORIES: Category[] = [
  {
    id: "fashion",
    label: "Fashion",
    emoji: "👗",
    match: (p) => /ankara|fashion|fits|set|wear|sneaker|style/i.test(p.title),
  },
  {
    id: "beauty",
    label: "Beauty",
    emoji: "💄",
    match: (p) => /beauty|serum|skin|glow|haul/i.test(p.title),
  },
  {
    id: "tech",
    label: "Tech",
    emoji: "📱",
    match: (p) => /tech|airmax|sound|power bank|phone|gadget|charger|charging/i.test(p.title),
  },
  {
    id: "home",
    label: "Home",
    emoji: "🏠",
    match: (p) => /home|decor|kitchen|bed/i.test(p.title),
  },
  {
    id: "food",
    label: "Food",
    emoji: "🍲",
    match: (p) => /food|spice|snack|drink|jollof/i.test(p.title),
  },
];

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function scoreMatch(product: SeedProduct, query: string): number {
  if (!query.trim()) return 1;
  const tokens = tokenize(query);
  if (tokens.length === 0) return 1;
  const haystacks = [
    { text: product.title.toLowerCase(), weight: 3 },
    { text: product.sellerName.toLowerCase(), weight: 2 },
    { text: product.originLabel.toLowerCase(), weight: 1 },
    { text: product.originCountry.toLowerCase(), weight: 1 },
  ];
  let score = 0;
  for (const tok of tokens) {
    for (const h of haystacks) {
      if (h.text.includes(tok)) score += h.weight;
    }
  }
  return score;
}

export function searchProducts(
  filters: SearchFilters,
  products: SeedProduct[] = SEED_PRODUCTS,
  freeShippingMaxMinor = 200000,
): SeedProduct[] {
  const cat = filters.category
    ? CATEGORIES.find((c) => c.id === filters.category)
    : null;

  const scored = products
    .map((p) => ({ p, score: scoreMatch(p, filters.query) }))
    .filter(({ p, score }) => {
      if (filters.query.trim() && score === 0) return false;
      if (cat && !cat.match(p)) return false;
      if (filters.minPriceMinor !== null && p.priceMinor < filters.minPriceMinor) return false;
      if (filters.maxPriceMinor !== null && p.priceMinor > filters.maxPriceMinor) return false;
      if (filters.minRating !== null && p.rating < filters.minRating) return false;
      if (filters.freeShippingOnly && p.priceMinor > freeShippingMaxMinor) return false;
      if (filters.liveNowOnly && !p.isLiveNow) return false;
      return true;
    });

  switch (filters.sort) {
    case "price_asc":
      scored.sort((a, b) => a.p.priceMinor - b.p.priceMinor);
      break;
    case "price_desc":
      scored.sort((a, b) => b.p.priceMinor - a.p.priceMinor);
      break;
    case "rating":
      scored.sort((a, b) => b.p.rating - a.p.rating);
      break;
    case "popular":
      scored.sort((a, b) => b.p.soldCount - a.p.soldCount);
      break;
    default:
      scored.sort((a, b) => b.score - a.score || b.p.soldCount - a.p.soldCount);
  }

  return scored.map(({ p }) => p);
}

export function categoryForProduct(p: SeedProduct): Category | undefined {
  return CATEGORIES.find((c) => c.match(p));
}
