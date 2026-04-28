import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, Share2, Heart, Star, MapPin, Truck, Package, ShieldCheck, UserPlus, UserCheck, Plane, Ship, ChevronDown, Globe, Flag } from "lucide-react";
import { Link, useParams, useLocation } from "wouter";
import { useTheme } from "@/lib/theme-context";
import { SEED_PRODUCTS } from "@/lib/seed";
import { useCountry } from "@/lib/country-context";
import { useCart } from "@/lib/cart-context";
import { useWishlist } from "@/lib/wishlist-context";
import { useFollows } from "@/lib/follows-context";
import { useReviews } from "@/lib/reviews-context";
import { useRecentlyViewed } from "@/lib/recently-viewed";
import { computeLandedCost, isImport, ShipMode } from "@/lib/landed-cost";
import { formatPrice } from "@/lib/format";
import { ThemeToggle } from "@/components/theme-toggle";
import { useToast } from "@/hooks/use-toast";

export default function ProductDetail() {
  const { productId } = useParams<{ productId: string }>();
  const [, setLocation] = useLocation();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { country } = useCountry();
  const { add } = useCart();
  const { isWishlisted, toggle: toggleWishlist } = useWishlist();
  const { isFollowing, toggle: toggleFollow } = useFollows();
  const { getForProduct, averageForProduct } = useReviews();
  const { track } = useRecentlyViewed();
  const { toast } = useToast();

  const product = SEED_PRODUCTS.find(p => p.id === productId) || SEED_PRODUCTS[0];
  const saved = isWishlisted(product.id);
  const following = isFollowing(product.sellerName);
  const productReviews = useMemo(() => getForProduct(product.id), [getForProduct, product.id]);
  const liveAverage = averageForProduct(product.id, product.rating);
  const totalRatingCount = productReviews.length || product.soldCount;

  useEffect(() => {
    track(product.id);
  }, [product.id, track]);

  const [selectedVariants, setSelectedVariants] = useState<Record<string, string>>(
    () => Object.fromEntries(product.variants.map(v => [v.name, v.options[0]]))
  );

  const variantNotes = product.variants
    .map(v => `${v.name}: ${selectedVariants[v.name]}`)
    .join(" · ");

  function handleAddToCart() {
    add(product.id, 1, variantNotes || undefined);
    toast({
      title: "Added to cart",
      description: product.title.slice(0, 60),
    });
  }

  function handleBuyNow() {
    add(product.id, 1, variantNotes || undefined);
    setLocation("/cart");
  }

  return (
    <div className={`w-full h-full relative overflow-hidden font-sans select-none flex flex-col ${isDark ? 'bg-[#0F1525] text-white' : 'bg-[#fbeed3] text-stone-900'}`}>
      
      {/* Top Header Transparent */}
      <div className="absolute top-0 left-0 right-0 p-4 pt-12 flex justify-between z-20">
        <button onClick={() => window.history.back()} className={`w-10 h-10 rounded-full backdrop-blur border flex items-center justify-center transition-colors ${isDark ? 'bg-black/40 border-white/10 hover:bg-black/60 text-white' : 'bg-[#fff5d8]/75 border-stone-400/55 hover:bg-[#fff5d8]/85 text-stone-900'}`}>
          <ChevronLeft className="h-6 w-6" />
        </button>
        <div className="flex gap-2">
          <ThemeToggle variant="overlay" />
          <button
            onClick={() => {
              if (navigator.share) {
                navigator.share({ title: product.title, url: window.location.href }).catch(() => {});
              } else {
                navigator.clipboard?.writeText(window.location.href);
                toast({ title: "Link copied" });
              }
            }}
            data-testid="button-share-product"
            className={`w-10 h-10 rounded-full backdrop-blur border flex items-center justify-center transition-colors ${isDark ? 'bg-black/40 border-white/10 hover:bg-black/60 text-white' : 'bg-[#fff5d8]/75 border-stone-400/55 hover:bg-[#fff5d8]/85 text-stone-900'}`}
          >
            <Share2 className="h-5 w-5" />
          </button>
          <button
            onClick={() => {
              const nowSaved = toggleWishlist(product.id);
              toast({ title: nowSaved ? "Saved to wishlist" : "Removed from wishlist" });
            }}
            data-testid="button-wishlist-product"
            className={`w-10 h-10 rounded-full backdrop-blur border flex items-center justify-center transition-colors ${
              saved
                ? 'bg-[#E6502E] text-white border-transparent'
                : isDark ? 'bg-black/40 border-white/10 hover:bg-black/60 text-white' : 'bg-[#fff5d8]/75 border-stone-400/55 hover:bg-[#fff5d8]/85 text-stone-900'
            }`}
          >
            <Heart className={`h-5 w-5 ${saved ? 'fill-current' : ''}`} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto no-scrollbar pb-24">
        {/* Image Carousel */}
        <div className={`relative w-full aspect-[4/5] ${isDark ? 'bg-[#171C30]' : 'bg-[#fbeed3]'}`}>
          <img src={product.images[0]} alt="Product" className="w-full h-full object-cover" />
          <div className={`absolute bottom-4 right-4 backdrop-blur text-[10px] font-bold px-2 py-1 rounded border ${isDark ? 'bg-black/60 text-white border-white/10' : 'bg-[#fff5d8]/75 text-stone-900 border-stone-400/55'}`}>
            1 / {product.images.length}
          </div>
          <div className={`absolute inset-0 bg-gradient-to-t ${isDark ? 'from-[#0F1525]' : 'from-[#fcfcf9]'} via-transparent to-transparent opacity-80`}></div>
        </div>

        {/* Product Info */}
        <div className="px-4 py-2">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className={`text-3xl font-black tracking-tight ${isDark ? 'text-[#5BA3F5]' : 'text-[#1B2A4A]'}`}>
                {formatPrice(product.priceMinor, country)}
              </p>
              {product.originalPriceMinor > product.priceMinor && (
                <p className={`text-sm line-through ${isDark ? 'text-white/40' : 'text-stone-400'}`}>
                  {formatPrice(product.originalPriceMinor, country)}
                </p>
              )}
            </div>
            {product.originalPriceMinor > product.priceMinor && (
              <div className={`text-[10px] font-bold px-2 py-1 rounded border ${isDark ? 'bg-[#FF8855]/20 text-[#FF8855] border-[#FF8855]/30 shadow-[0_0_10px_rgba(255,136,85,0.2)]' : 'bg-[#E6502E]/10 text-[#E6502E] border-[#E6502E]/30'}`}>
                -{Math.round((1 - product.priceMinor / product.originalPriceMinor) * 100)}% OFF
              </div>
            )}
          </div>
          
          <h1 className="text-lg font-bold mt-2 leading-tight">{product.title}</h1>
          
          <div className={`flex items-center gap-3 mt-3 text-xs ${isDark ? 'text-white/60' : 'text-stone-500'}`}>
            <div className="flex items-center gap-1" data-testid="product-rating-summary">
              <Star className={`w-3 h-3 fill-current ${isDark ? 'text-[#FF8855]' : 'text-[#E6502E]'}`} />
              <span className={`font-bold ${isDark ? 'text-white' : 'text-stone-800'}`}>{liveAverage.toFixed(1)}</span>
              <span>
                {productReviews.length > 0
                  ? `(${productReviews.length} review${productReviews.length === 1 ? "" : "s"})`
                  : `(${product.soldCount} sold)`}
              </span>
            </div>
            <span>•</span>
            <div className={`flex items-center gap-1 ${isDark ? 'text-[#5BA3F5]' : 'text-[#1B2A4A]'}`}>
              <MapPin className="w-3 h-3" />
              <span>{product.originLabel}</span>
            </div>
          </div>
        </div>

        <LandedCostPreview
          isDark={isDark}
          productPriceMinor={product.priceMinor}
          originCountry={product.originCountry}
          destinationCode={country.code}
          currencyCode={country.currency.code}
          wholesaleListingId={(product as { wholesaleListingId?: string }).wholesaleListingId}
        />

        {/* Variants */}
        {product.variants.map((variant) => (
          <div key={variant.name} className={`px-4 py-4 mt-2 border-y ${isDark ? 'border-white/10 bg-white/5' : 'border-stone-400/35 bg-stone-300/35'}`}>
            <p className="text-sm font-bold mb-3">Select {variant.name}</p>
            <div className="flex gap-3 overflow-x-auto no-scrollbar">
              {variant.options.map((opt) => {
                const picked = selectedVariants[variant.name] === opt;
                return (
                  <button
                    key={opt}
                    onClick={() => setSelectedVariants(prev => ({ ...prev, [variant.name]: opt }))}
                    data-testid={`variant-${variant.name}-${opt}`}
                    className={`min-w-12 px-3 h-12 rounded-xl flex items-center justify-center text-sm font-bold border transition-all ${
                      picked
                      ? isDark
                        ? "border-[#5BA3F5] bg-[#5BA3F5]/10 text-[#5BA3F5] shadow-[0_0_10px_rgba(91,163,245,0.2)]"
                        : "border-[#1B2A4A] bg-[#1B2A4A]/10 text-[#1B2A4A] shadow-sm"
                      : isDark
                        ? "border-white/10 bg-black text-white/70 hover:border-white/30"
                        : "border-stone-400/55 bg-white text-stone-600 hover:border-stone-500/45"
                    }`}
                  >
                    {opt}
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        {/* Seller Info */}
        <div className="px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="relative">
              <img src={product.sellerAvatar} className={`w-12 h-12 rounded-full border-2 ${isDark ? 'border-[#FF8855]' : 'border-[#E6502E]'}`} alt={product.sellerName} />
              {product.isLiveNow && (
                <div className={`absolute -bottom-1 left-1/2 -translate-x-1/2 text-white text-[8px] font-black px-1 rounded whitespace-nowrap animate-pulse ${isDark ? 'bg-[#FF8855]' : 'bg-[#E6502E]'}`}>
                  LIVE
                </div>
              )}
            </div>
            <div>
              <p className="text-sm font-bold">{product.sellerName}</p>
              <p className={`text-xs ${isDark ? 'text-white/50' : 'text-stone-500'}`}>98% positive</p>
            </div>
          </div>
          <button
            onClick={() => {
              const nowFollowing = toggleFollow(product.sellerName);
              toast({
                title: nowFollowing ? `Following ${product.sellerName}` : `Unfollowed ${product.sellerName}`,
                description: nowFollowing ? "You'll get drop alerts in your inbox." : undefined,
              });
            }}
            data-testid="button-follow-seller"
            className={`h-8 px-3 rounded-md text-xs font-bold border transition-colors flex items-center gap-1.5 ${
              following
                ? isDark
                  ? 'bg-[#5BA3F5]/15 border-[#5BA3F5]/40 text-[#5BA3F5]'
                  : 'bg-[#1B2A4A]/10 border-[#1B2A4A]/40 text-[#1B2A4A]'
                : isDark
                  ? 'border-[#5BA3F5] text-[#5BA3F5] hover:bg-[#5BA3F5]/10 bg-transparent'
                  : 'border-[#1B2A4A] text-[#1B2A4A] hover:bg-[#1B2A4A]/10 bg-transparent'
            }`}
          >
            {following ? <UserCheck className="w-3 h-3" /> : <UserPlus className="w-3 h-3" />}
            {following ? "Following" : "Follow"}
          </button>
        </div>

        <div className="px-4 mt-3">
          <Link
            href={`/safety/report?kind=product&id=${encodeURIComponent(product.id)}&label=${encodeURIComponent(product.title)}&seller=${encodeURIComponent(product.sellerName)}&back=${encodeURIComponent(`/product/${product.id}`)}`}
            data-testid="link-report-product"
            className={`flex items-center justify-center gap-1.5 text-xs font-bold py-2 rounded-lg border ${
              isDark
                ? "border-white/10 text-white/60 hover:bg-white/5"
                : "border-stone-300 text-stone-500 hover:bg-stone-100"
            }`}
          >
            <Flag className="w-3 h-3" />
            Report this listing
          </Link>
        </div>

        {/* Reviews */}
        <div className={`px-4 py-4 mt-2 border-y ${isDark ? 'bg-white/5 border-white/10' : 'bg-stone-300/35 border-stone-400/35'}`} data-testid="reviews-section">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-bold">Reviews</h3>
            <div className="flex items-center gap-1">
              <Star className={`w-3.5 h-3.5 fill-current ${isDark ? 'text-[#FF8855]' : 'text-[#E6502E]'}`} />
              <span className="text-sm font-bold">{liveAverage.toFixed(1)}</span>
              <span className={`text-xs ${isDark ? 'text-white/55' : 'text-stone-500'}`}>· {totalRatingCount}</span>
            </div>
          </div>
          {productReviews.length === 0 ? (
            <p className={`text-xs ${isDark ? 'text-white/55' : 'text-stone-500'}`}>
              No reviews yet. Be the first after your order is delivered.
            </p>
          ) : (
            <div className="space-y-3">
              {productReviews.slice(0, 3).map((r) => (
                <div key={r.id} data-testid={`review-${r.id}`} className={`p-3 rounded-lg ${isDark ? 'bg-black/30' : 'bg-white'}`}>
                  <div className="flex items-center gap-2 mb-1">
                    {Array.from({ length: 5 }).map((_, i) => (
                      <Star
                        key={i}
                        className={`w-3 h-3 ${
                          i < r.rating
                            ? isDark ? 'text-[#FF8855] fill-current' : 'text-[#E6502E] fill-current'
                            : isDark ? 'text-white/20' : 'text-stone-300'
                        }`}
                      />
                    ))}
                    <span className={`text-[11px] ${isDark ? 'text-white/40' : 'text-stone-400'}`}>
                      {new Date(r.createdAtIso).toLocaleDateString()}
                    </span>
                  </div>
                  {r.text && <p className="text-xs leading-relaxed">{r.text}</p>}
                </div>
              ))}
              {productReviews.length > 3 && (
                <p className={`text-xs text-center ${isDark ? 'text-white/55' : 'text-stone-500'}`}>
                  +{productReviews.length - 3} more
                </p>
              )}
            </div>
          )}
        </div>

        {/* Delivery Options */}
        <div className={`px-4 py-4 mt-2 border-y ${isDark ? 'bg-white/5 border-white/10' : 'bg-stone-300/35 border-stone-400/35'}`}>
          <h3 className="text-sm font-bold mb-3">Delivery Options in {country.name}</h3>
          
          <div className="space-y-3">
            {country.fulfillmentOptions.map((opt, i) => (
              <div key={opt.id} className={`flex gap-3 p-3 rounded-xl border relative overflow-hidden ${i === 0 ? (isDark ? 'bg-black border-[#5BA3F5]/30' : 'bg-white border-[#1B2A4A]/30') : (isDark ? 'bg-black border-white/10' : 'bg-white border-stone-400/55')}`}>
                {i === 0 && <div className={`absolute top-0 left-0 w-1 h-full ${isDark ? 'bg-[#5BA3F5]' : 'bg-[#1B2A4A]'}`}></div>}
                {opt.id.includes('box') ? <Package className={`w-5 h-5 mt-0.5 shrink-0 ${i === 0 ? (isDark ? 'text-[#5BA3F5]' : 'text-[#1B2A4A]') : (isDark ? 'text-white/50' : 'text-stone-400')}`} /> : 
                 opt.id.includes('pudo') || opt.id.includes('pickup') ? <MapPin className={`w-5 h-5 mt-0.5 shrink-0 ${i === 0 ? (isDark ? 'text-[#5BA3F5]' : 'text-[#1B2A4A]') : (isDark ? 'text-white/50' : 'text-stone-400')}`} /> :
                 <Truck className={`w-5 h-5 mt-0.5 shrink-0 ${i === 0 ? (isDark ? 'text-[#5BA3F5]' : 'text-[#1B2A4A]') : (isDark ? 'text-white/50' : 'text-stone-400')}`} />}
                <div className="flex-1">
                  <div className="flex justify-between items-start">
                    <p className={`text-sm font-bold ${i === 0 ? (isDark ? 'text-white' : 'text-stone-900') : (isDark ? 'text-white/80' : 'text-stone-800')}`}>{opt.label}</p>
                    <p className={`text-sm font-bold ${opt.feeMinor === 0 ? (isDark ? 'text-[#5BA3F5]' : 'text-[#1B2A4A]') : (isDark ? 'text-white/80' : 'text-stone-800')}`}>
                      {opt.feeMinor === 0 ? 'FREE' : formatPrice(opt.feeMinor, country)}
                    </p>
                  </div>
                  <p className={`text-xs mt-1 ${isDark ? 'text-white/60' : 'text-stone-500'}`}>{opt.description} • Arrives in {opt.etaLabel}.</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Protection */}
        <div className={`px-4 py-6 flex items-center gap-2 text-xs ${isDark ? 'text-white/60' : 'text-stone-500'}`}>
          <ShieldCheck className="w-4 h-4 text-emerald-500" />
          <span>Payment secured for {country.name}. Buyer protection included.</span>
        </div>
      </div>

      {/* Sticky Bottom CTA */}
      <div className={`absolute bottom-0 left-0 right-0 p-4 backdrop-blur-xl border-t flex gap-3 z-20 ${isDark ? 'bg-[#0F1525]/90 border-white/10' : 'bg-[#fbeed3]/90 border-stone-400/55'}`}>
        <button
          onClick={handleAddToCart}
          data-testid="button-add-to-cart"
          className={`flex-1 h-14 rounded-xl border font-bold transition-colors ${isDark ? 'bg-white/5 border-white/20 text-white hover:bg-white/10' : 'bg-stone-300/35 border-stone-400/55 text-stone-900 hover:bg-stone-300/55'}`}>
          Add to Cart
        </button>
        <button
          onClick={handleBuyNow}
          data-testid="button-buy-now"
          className={`flex-1 h-14 rounded-xl text-white font-black text-lg transition-all ${isDark ? 'bg-gradient-to-r from-[#FF8855] to-[#FF6B35] shadow-[0_0_20px_rgba(255,136,85,0.4)] hover:shadow-[0_0_30px_rgba(255,136,85,0.6)]' : 'bg-gradient-to-r from-[#E6502E] to-[#C4441E] shadow-md hover:shadow-lg'}`}>
          Buy Now
        </button>
      </div>

    </div>
  );
}

function LandedCostPreview({
  isDark,
  productPriceMinor,
  originCountry,
  destinationCode,
  currencyCode,
  wholesaleListingId,
}: {
  isDark: boolean;
  productPriceMinor: number;
  originCountry: string;
  destinationCode: import("@/lib/countries").CountryCode;
  currencyCode: string;
  wholesaleListingId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ShipMode>("air");
  const clientEstimate = useMemo(
    () =>
      computeLandedCost({
        productPriceMinor,
        originCountry,
        destinationCode,
        shipMode: mode,
      }),
    [productPriceMinor, originCountry, destinationCode, mode],
  );
  // When the product is backed by a wholesale listing, prefer the server-side
  // landed-cost quote (real FX + HS-driven duty + actual freight). Falls back
  // to the client-side estimate while loading or when no listing id is set.
  const [serverBreakdown, setServerBreakdown] = useState<typeof clientEstimate | null>(null);
  const [serverEtaLabel, setServerEtaLabel] = useState<string | null>(null);
  useEffect(() => {
    if (!wholesaleListingId) {
      setServerBreakdown(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/wholesale/quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            listingId: wholesaleListingId,
            qty: 1,
            destinationCountryCode: destinationCode,
            shipMode: mode,
          }),
        });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as {
          breakdown: {
            fobInDestMinor: number;
            freightMinor: number;
            insuranceMinor: number;
            dutyMinor: number;
            vatMinor: number;
            clearanceMinor: number;
            landedTotalMinor: number;
          };
          leadDays: number;
          transitDays: number;
          productionLeadDays: number;
        };
        if (cancelled) return;
        setServerBreakdown({
          isImport: true,
          shipMode: mode,
          originCountry,
          fobMinor: data.breakdown.fobInDestMinor,
          freightMinor: data.breakdown.freightMinor,
          insuranceMinor: data.breakdown.insuranceMinor,
          dutyMinor: data.breakdown.dutyMinor,
          vatMinor: data.breakdown.vatMinor,
          clearanceMinor: data.breakdown.clearanceMinor,
          totalMinor: data.breakdown.landedTotalMinor,
          etaLabel: `${data.transitDays} days transit · ${data.productionLeadDays}d production`,
        });
        setServerEtaLabel(`${data.transitDays} days transit · ${data.productionLeadDays}d production`);
      } catch {
        // Network failure — silently fall back to the client estimate.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wholesaleListingId, destinationCode, mode]);
  const breakdown = serverBreakdown ?? clientEstimate;
  const subtle = isDark ? "text-white/50" : "text-stone-600";
  const fees = breakdown.totalMinor - breakdown.fobMinor;
  const etaLabel = serverEtaLabel ?? breakdown.etaLabel;

  if (!isImport(originCountry)) {
    return (
      <div className={`px-4 mt-3`}>
        <div
          className={`flex items-center gap-2 text-xs px-3 py-2 rounded-lg border ${
            isDark
              ? "bg-emerald-400/10 border-emerald-400/30 text-emerald-300"
              : "bg-emerald-50 border-emerald-200 text-emerald-800"
          }`}
          data-testid="badge-local-origin"
        >
          <Flag className="w-3.5 h-3.5" />
          <span>Made in {originCountry} · no import duties</span>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 mt-3">
      <button
        onClick={() => setOpen((v) => !v)}
        data-testid="toggle-landed-cost"
        className={`w-full flex items-center justify-between px-3 py-3 rounded-xl border ${
          isDark
            ? "bg-[#FF8855]/10 border-[#FF8855]/30 text-[#FF8855]"
            : "bg-[#E6502E]/10 border-[#E6502E]/30 text-[#E6502E]"
        }`}
      >
        <div className="flex items-center gap-2">
          <Globe className="w-4 h-4" />
          <span className="text-sm font-bold">
            Imported from {originCountry}
          </span>
        </div>
        <div className="flex items-center gap-1 text-xs font-bold">
          Landed +{formatPrice(fees, currencyCode)}
          <ChevronDown
            className={`w-4 h-4 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </div>
      </button>
      {open && (
        <div
          className={`mt-2 rounded-xl border p-3 space-y-2 text-xs ${
            isDark
              ? "bg-white/5 border-white/10 text-white/80"
              : "bg-white border-stone-300 text-stone-800"
          }`}
          data-testid="landed-cost-detail"
        >
          <div
            className={`flex p-1 rounded-full ${
              isDark ? "bg-white/5" : "bg-stone-200"
            }`}
          >
            <ModePill
              active={mode === "air"}
              onClick={() => setMode("air")}
              isDark={isDark}
              icon={<Plane className="w-3.5 h-3.5" />}
              label="Air"
              testId="ship-mode-air"
            />
            <ModePill
              active={mode === "sea"}
              onClick={() => setMode("sea")}
              isDark={isDark}
              icon={<Ship className="w-3.5 h-3.5" />}
              label="Sea"
              testId="ship-mode-sea"
            />
          </div>
          <CostRow label="Item (FOB)" value={breakdown.fobMinor} ccy={currencyCode} subtle={subtle} />
          <CostRow label="Freight" value={breakdown.freightMinor} ccy={currencyCode} subtle={subtle} />
          <CostRow label="Insurance" value={breakdown.insuranceMinor} ccy={currencyCode} subtle={subtle} />
          <CostRow label="Import duty" value={breakdown.dutyMinor} ccy={currencyCode} subtle={subtle} />
          <CostRow label="VAT" value={breakdown.vatMinor} ccy={currencyCode} subtle={subtle} />
          <CostRow label="Clearance" value={breakdown.clearanceMinor} ccy={currencyCode} subtle={subtle} />
          <div
            className={`pt-2 border-t flex items-center justify-between ${
              isDark ? "border-white/10" : "border-stone-300"
            }`}
          >
            <span className="font-bold">Estimated landed total</span>
            <span className="font-black text-base">
              {formatPrice(breakdown.totalMinor, currencyCode)}
            </span>
          </div>
          <p className={`pt-1 text-[11px] ${subtle}`}>
            ETA: {etaLabel}. Duties paid by Epplaa at clearance, included
            above.
          </p>
          {serverBreakdown && (
            <p className={`pt-1 text-[10px] ${subtle}`}>Live quote · real FX + HS-coded duty</p>
          )}
        </div>
      )}
    </div>
  );
}

function CostRow({
  label,
  value,
  ccy,
  subtle,
}: {
  label: string;
  value: number;
  ccy: string;
  subtle: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className={subtle}>{label}</span>
      <span className="font-medium">{formatPrice(value, ccy)}</span>
    </div>
  );
}

function ModePill({
  active,
  onClick,
  isDark,
  icon,
  label,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  isDark: boolean;
  icon: React.ReactNode;
  label: string;
  testId: string;
}) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      className={`flex-1 flex items-center justify-center gap-1 py-1.5 rounded-full text-xs font-bold ${
        active
          ? isDark
            ? "bg-[#FF8855] text-white"
            : "bg-[#1B2A4A] text-white"
          : isDark
            ? "text-white/60"
            : "text-stone-600"
      }`}
    >
      {icon} {label}
    </button>
  );
}
