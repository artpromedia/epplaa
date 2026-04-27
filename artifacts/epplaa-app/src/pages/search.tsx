import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  Search as SearchIcon,
  Star,
  X,
  SlidersHorizontal,
  Clock,
  Heart,
  Radio,
} from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useCountry } from "@/lib/country-context";
import { SEED_PRODUCTS } from "@/lib/seed";
import { formatPrice } from "@/lib/format";
import { useWishlist } from "@/lib/wishlist-context";
import { useRecentlyViewed } from "@/lib/recently-viewed";
import {
  searchProducts,
  CATEGORIES,
  DEFAULT_FILTERS,
  SearchFilters,
} from "@/lib/search-utils";
import { ThemeToggle } from "@/components/theme-toggle";

const RECENT_QUERIES_KEY = "epplaa-recent-queries";

function useRecentQueries() {
  const read = () => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(RECENT_QUERIES_KEY);
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  };
  const [queries, setQueries] = useState<string[]>(read);
  function record(q: string) {
    const trimmed = q.trim();
    if (!trimmed) return;
    const next = [trimmed, ...queries.filter((x) => x !== trimmed)].slice(0, 6);
    setQueries(next);
    try {
      window.localStorage.setItem(RECENT_QUERIES_KEY, JSON.stringify(next));
    } catch {}
  }
  function clear() {
    setQueries([]);
    try {
      window.localStorage.removeItem(RECENT_QUERIES_KEY);
    } catch {}
  }
  return { queries, record, clear };
}

const SORT_OPTIONS: Array<{ value: SearchFilters["sort"]; label: string }> = [
  { value: "relevance", label: "Relevance" },
  { value: "popular", label: "Most popular" },
  { value: "rating", label: "Top rated" },
  { value: "price_asc", label: "Price: low → high" },
  { value: "price_desc", label: "Price: high → low" },
];

export default function Search() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { country } = useCountry();
  const [, setLocation] = useLocation();
  const { isWishlisted, toggle } = useWishlist();
  const { productIds: recentlyViewedIds } = useRecentlyViewed();
  const { queries, record, clear } = useRecentQueries();

  const [filters, setFilters] = useState<SearchFilters>(DEFAULT_FILTERS);
  const [showFilters, setShowFilters] = useState(false);

  const results = useMemo(() => searchProducts(filters), [filters]);

  const recentlyViewedProducts = useMemo(
    () =>
      recentlyViewedIds
        .map((id) => SEED_PRODUCTS.find((p) => p.id === id))
        .filter(Boolean) as typeof SEED_PRODUCTS,
    [recentlyViewedIds],
  );

  const isEmptyState =
    !filters.query.trim() &&
    !filters.category &&
    filters.minPriceMinor === null &&
    filters.maxPriceMinor === null &&
    filters.minRating === null &&
    !filters.freeShippingOnly &&
    !filters.liveNowOnly;

  const subtle = isDark ? "text-white/55" : "text-stone-500";
  const cardBorder = isDark
    ? "bg-white/5 border-white/10"
    : "bg-white border-stone-400/35";

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    record(filters.query);
  }

  function handleChip(q: string) {
    setFilters((prev) => ({ ...prev, query: q }));
    record(q);
  }

  function clearAll() {
    setFilters(DEFAULT_FILTERS);
  }

  const activeFilterCount = [
    filters.category,
    filters.minPriceMinor !== null,
    filters.maxPriceMinor !== null,
    filters.minRating !== null,
    filters.freeShippingOnly,
    filters.liveNowOnly,
    filters.sort !== "relevance",
  ].filter(Boolean).length;

  return (
    <div className="flex flex-col h-full w-full">
      <div
        className={`pt-12 pb-3 px-4 z-10 sticky top-0 ${
          isDark
            ? "bg-[#0F1525] border-b border-white/10"
            : "bg-[#fbeed3] border-b border-stone-400/35"
        }`}
      >
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-2xl font-bold">Search</h1>
          <ThemeToggle />
        </div>
        <form onSubmit={handleSubmit} className="flex items-center gap-2">
          <div className="relative flex-1">
            <SearchIcon
              className={`absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 ${
                isDark ? "text-white/50" : "text-stone-400"
              }`}
            />
            <input
              autoFocus
              value={filters.query}
              onChange={(e) =>
                setFilters((prev) => ({ ...prev, query: e.target.value }))
              }
              placeholder={`Search products, sellers, brands...`}
              data-testid="input-search"
              className={`w-full pl-10 pr-9 h-11 rounded-full text-sm outline-none ${
                isDark
                  ? "bg-white/5 border border-white/10 focus-visible:ring-1 focus-visible:ring-[#FF8855] placeholder:text-white/40 text-white"
                  : "bg-white border border-stone-400/55 focus-visible:ring-1 focus-visible:ring-[#E6502E] placeholder:text-stone-400 text-stone-900"
              }`}
            />
            {filters.query && (
              <button
                type="button"
                onClick={() =>
                  setFilters((prev) => ({ ...prev, query: "" }))
                }
                className={`absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full flex items-center justify-center ${
                  isDark
                    ? "text-white/60 hover:bg-white/10"
                    : "text-stone-500 hover:bg-stone-100"
                }`}
                data-testid="button-clear-query"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => setShowFilters((s) => !s)}
            data-testid="button-toggle-filters"
            className={`relative h-11 px-3 rounded-full border flex items-center gap-1.5 text-sm font-bold ${
              showFilters
                ? isDark
                  ? "bg-[#5BA3F5]/15 border-[#5BA3F5]/40 text-[#5BA3F5]"
                  : "bg-[#1B2A4A]/10 border-[#1B2A4A]/40 text-[#1B2A4A]"
                : isDark
                  ? "border-white/10 text-white/70 hover:bg-white/5"
                  : "border-stone-400/55 text-stone-700 hover:bg-stone-100"
            }`}
          >
            <SlidersHorizontal className="w-4 h-4" />
            {activeFilterCount > 0 && (
              <span
                className={`min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-black flex items-center justify-center ${
                  isDark ? "bg-[#FF8855] text-black" : "bg-[#E6502E] text-white"
                }`}
              >
                {activeFilterCount}
              </span>
            )}
          </button>
        </form>

        <div
          className={`flex gap-2 overflow-x-auto no-scrollbar pt-3 pb-1`}
        >
          <button
            onClick={() =>
              setFilters((prev) => ({ ...prev, category: null }))
            }
            data-testid="chip-category-all"
            className={`whitespace-nowrap px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
              filters.category === null
                ? isDark
                  ? "bg-[#5BA3F5] text-black"
                  : "bg-[#1B2A4A] text-white"
                : isDark
                  ? "bg-white/5 text-white/70 border border-white/10"
                  : "bg-white border border-stone-400/55 text-stone-600"
            }`}
          >
            All
          </button>
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              onClick={() =>
                setFilters((prev) => ({ ...prev, category: c.id }))
              }
              data-testid={`chip-category-${c.id}`}
              className={`whitespace-nowrap px-4 py-1.5 rounded-full text-sm font-medium transition-colors flex items-center gap-1 ${
                filters.category === c.id
                  ? isDark
                    ? "bg-[#5BA3F5] text-black"
                    : "bg-[#1B2A4A] text-white"
                  : isDark
                    ? "bg-white/5 text-white/70 border border-white/10"
                    : "bg-white border border-stone-400/55 text-stone-600"
              }`}
            >
              <span>{c.emoji}</span>
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {showFilters && (
        <div
          className={`px-4 py-3 border-b space-y-3 ${
            isDark
              ? "bg-[#0F1525] border-white/10"
              : "bg-[#fff5d8] border-stone-400/35"
          }`}
        >
          <div className="flex items-center justify-between">
            <p className="text-xs font-bold uppercase tracking-wider">
              Refine
            </p>
            <button
              onClick={clearAll}
              className={`text-xs font-bold ${
                isDark ? "text-[#FF8855]" : "text-[#E6502E]"
              }`}
              data-testid="button-clear-all-filters"
            >
              Clear all
            </button>
          </div>

          <div>
            <p className={`text-xs mb-1.5 ${subtle}`}>Sort by</p>
            <div className="flex gap-2 overflow-x-auto no-scrollbar">
              {SORT_OPTIONS.map((opt) => {
                const active = filters.sort === opt.value;
                return (
                  <button
                    key={opt.value}
                    onClick={() =>
                      setFilters((prev) => ({ ...prev, sort: opt.value }))
                    }
                    data-testid={`sort-${opt.value}`}
                    className={`whitespace-nowrap px-3 py-1.5 rounded-full text-xs font-bold border ${
                      active
                        ? isDark
                          ? "bg-[#5BA3F5]/15 border-[#5BA3F5]/40 text-[#5BA3F5]"
                          : "bg-[#1B2A4A]/10 border-[#1B2A4A]/40 text-[#1B2A4A]"
                        : isDark
                          ? "border-white/10 text-white/60"
                          : "border-stone-400/55 text-stone-600"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <ToggleFilter
              isDark={isDark}
              label="Free shipping only"
              icon={<span>🚚</span>}
              active={filters.freeShippingOnly}
              onClick={() =>
                setFilters((prev) => ({
                  ...prev,
                  freeShippingOnly: !prev.freeShippingOnly,
                }))
              }
              testId="filter-free-shipping"
            />
            <ToggleFilter
              isDark={isDark}
              label="Live now"
              icon={
                <span
                  className={`w-2 h-2 rounded-full ${
                    isDark ? "bg-[#FF8855]" : "bg-[#E6502E]"
                  } animate-pulse`}
                />
              }
              active={filters.liveNowOnly}
              onClick={() =>
                setFilters((prev) => ({
                  ...prev,
                  liveNowOnly: !prev.liveNowOnly,
                }))
              }
              testId="filter-live-now"
            />
          </div>

          <div>
            <p className={`text-xs mb-1.5 ${subtle}`}>Minimum rating</p>
            <div className="flex gap-2">
              {[null, 4, 4.5, 4.8].map((r, i) => {
                const active = filters.minRating === r;
                return (
                  <button
                    key={i}
                    onClick={() =>
                      setFilters((prev) => ({ ...prev, minRating: r }))
                    }
                    data-testid={`min-rating-${r ?? "any"}`}
                    className={`flex-1 px-2 py-1.5 rounded-full text-xs font-bold border flex items-center justify-center gap-1 ${
                      active
                        ? isDark
                          ? "bg-[#FF8855]/15 border-[#FF8855]/40 text-[#FF8855]"
                          : "bg-[#E6502E]/10 border-[#E6502E]/40 text-[#E6502E]"
                        : isDark
                          ? "border-white/10 text-white/60"
                          : "border-stone-400/55 text-stone-600"
                    }`}
                  >
                    {r === null ? (
                      "Any"
                    ) : (
                      <>
                        <Star className="w-3 h-3 fill-current" />
                        {r}+
                      </>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 pb-24 pt-3 space-y-4">
        {isEmptyState ? (
          <>
            {queries.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-bold uppercase tracking-wider">
                    Recent searches
                  </p>
                  <button
                    onClick={clear}
                    className={`text-xs ${subtle}`}
                    data-testid="button-clear-recent-queries"
                  >
                    Clear
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {queries.map((q) => (
                    <button
                      key={q}
                      onClick={() => handleChip(q)}
                      data-testid={`recent-query-${q}`}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm border ${
                        isDark
                          ? "bg-white/5 border-white/10 text-white/80"
                          : "bg-white border-stone-400/55 text-stone-700"
                      }`}
                    >
                      <Clock className="w-3 h-3" />
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {recentlyViewedProducts.length > 0 && (
              <div>
                <p className="text-sm font-bold uppercase tracking-wider mb-2">
                  Recently viewed
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {recentlyViewedProducts.slice(0, 6).map((p) => (
                    <ProductCard
                      key={p.id}
                      product={p}
                      country={country}
                      isDark={isDark}
                      isWishlisted={isWishlisted(p.id)}
                      onToggleWishlist={() => toggle(p.id)}
                    />
                  ))}
                </div>
              </div>
            )}

            <div>
              <p className="text-sm font-bold uppercase tracking-wider mb-2">
                Trending now
              </p>
              <div className="grid grid-cols-2 gap-2">
                {SEED_PRODUCTS.slice()
                  .sort((a, b) => b.soldCount - a.soldCount)
                  .slice(0, 6)
                  .map((p) => (
                    <ProductCard
                      key={p.id}
                      product={p}
                      country={country}
                      isDark={isDark}
                      isWishlisted={isWishlisted(p.id)}
                      onToggleWishlist={() => toggle(p.id)}
                    />
                  ))}
              </div>
            </div>
          </>
        ) : results.length === 0 ? (
          <div className="text-center py-16 space-y-2">
            <div
              className={`w-16 h-16 rounded-full mx-auto flex items-center justify-center ${
                isDark ? "bg-white/5 text-white/30" : "bg-stone-200 text-stone-400"
              }`}
            >
              <SearchIcon className="w-8 h-8" />
            </div>
            <p className="font-bold">No results</p>
            <p className={`text-sm ${subtle}`}>
              Try a different keyword or clear filters.
            </p>
            <button
              onClick={clearAll}
              className={`mt-3 px-4 py-2 rounded-full text-sm font-bold ${
                isDark ? "bg-[#5BA3F5] text-black" : "bg-[#1B2A4A] text-white"
              }`}
              data-testid="button-reset-search"
            >
              Reset search
            </button>
          </div>
        ) : (
          <div>
            <p className={`text-xs mb-2 ${subtle}`}>
              {results.length} result{results.length === 1 ? "" : "s"}
            </p>
            <div className="grid grid-cols-2 gap-2">
              {results.map((p) => (
                <ProductCard
                  key={p.id}
                  product={p}
                  country={country}
                  isDark={isDark}
                  isWishlisted={isWishlisted(p.id)}
                  onToggleWishlist={() => toggle(p.id)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ToggleFilter({
  isDark,
  label,
  icon,
  active,
  onClick,
  testId,
}: {
  isDark: boolean;
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      className={`w-full px-3 py-2 rounded-full text-xs font-bold border flex items-center justify-center gap-1.5 ${
        active
          ? isDark
            ? "bg-[#5BA3F5]/15 border-[#5BA3F5]/40 text-[#5BA3F5]"
            : "bg-[#1B2A4A]/10 border-[#1B2A4A]/40 text-[#1B2A4A]"
          : isDark
            ? "border-white/10 text-white/60"
            : "border-stone-400/55 text-stone-600"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function ProductCard({
  product,
  country,
  isDark,
  isWishlisted,
  onToggleWishlist,
}: {
  product: (typeof SEED_PRODUCTS)[number];
  country: ReturnType<typeof useCountry>["country"];
  isDark: boolean;
  isWishlisted: boolean;
  onToggleWishlist: () => void;
}) {
  return (
    <Link
      href={`/product/${product.id}`}
      data-testid={`search-result-${product.id}`}
      className={`relative rounded-xl overflow-hidden aspect-[3/4] block ${
        isDark ? "bg-[#171C30]" : "bg-[#fbeed3] border border-stone-400/35"
      }`}
    >
      <img
        src={product.images[0]}
        className="w-full h-full object-cover opacity-90"
        alt={product.title}
      />
      <button
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onToggleWishlist();
        }}
        data-testid={`wishlist-toggle-${product.id}`}
        className={`absolute top-2 right-2 w-7 h-7 rounded-full flex items-center justify-center backdrop-blur ${
          isWishlisted
            ? "bg-[#E6502E] text-white"
            : isDark
              ? "bg-black/50 text-white"
              : "bg-white/80 text-stone-700"
        }`}
      >
        <Heart
          className={`w-3.5 h-3.5 ${isWishlisted ? "fill-current" : ""}`}
        />
      </button>
      {product.isLiveNow && (
        <div
          className={`absolute top-2 left-2 text-white text-[9px] font-black px-1.5 py-0.5 rounded flex items-center gap-1 ${
            isDark ? "bg-[#FF8855]" : "bg-[#E6502E]"
          } animate-pulse`}
        >
          <Radio className="w-2 h-2" /> LIVE
        </div>
      )}
      <div
        className={`absolute inset-0 bg-gradient-to-t ${
          isDark ? "from-black/85" : "from-black/65"
        } via-transparent to-transparent`}
      />
      <div className="absolute bottom-2 left-2 right-2">
        <p className="text-xs font-medium leading-tight text-white/95 line-clamp-2 mb-1">
          {product.title}
        </p>
        <div className="flex items-center justify-between">
          <p
            className={`text-sm font-black ${
              isDark ? "text-[#5BA3F5]" : "text-white"
            }`}
          >
            {formatPrice(product.priceMinor, country)}
          </p>
          <div className="flex items-center gap-0.5 text-[10px] text-white/90">
            <Star className="w-2.5 h-2.5 fill-current text-[#FF8855]" />
            {product.rating}
          </div>
        </div>
      </div>
    </Link>
  );
}
