import { Search, Play, ChevronRight, Clock, Flame, Sparkles, MapPin } from "lucide-react";
import { Link } from "wouter";
import { useTheme } from "@/lib/theme-context";
import { SEED_PRODUCTS, SEED_STREAMS } from "@/lib/seed";
import { SEED_REPLAYS } from "@/lib/replays";
import { useCountry } from "@/lib/country-context";
import { formatPrice } from "@/lib/format";
import { ThemeToggle } from "@/components/theme-toggle";
import epplaaBoxImage from "@assets/epplaa_box_1777409658029.png";
import {
  useGetForYou,
  useGetTrendingStreams,
} from "@workspace/api-client-react";

export default function Discovery() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { country } = useCountry();

  const forYou = useGetForYou({ country: country.code, limit: 8 });
  const trending = useGetTrendingStreams({ limit: 8 });
  const forYouItems = forYou.data?.items ?? [];
  const trendingItems = trending.data?.items ?? [];
  
  const categories = ["For You", "Beauty", "Phones", "Fashion", "Home", "Imports", "Electronics"];

  return (
    <div className="flex flex-col h-full w-full">
      {/* Header */}
      <div className={`pt-12 pb-4 px-4 z-10 sticky top-0 ${isDark ? 'bg-gradient-to-b from-[#000000] to-transparent' : 'bg-gradient-to-b from-white to-transparent'}`}>
        <div className="flex items-center gap-3 mb-4">
          <Link
            href="/search"
            data-testid="link-open-search"
            className={`relative flex-1 block`}
          >
            <Search className={`absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 ${isDark ? 'text-white/50' : 'text-stone-400'}`} />
            <div
              className={`w-full pl-10 h-10 rounded-full text-sm flex items-center ${isDark ? 'bg-white/5 border border-white/10 text-white/50' : 'bg-stone-300/35 border border-stone-400/55 text-stone-500'}`}
            >
              Search products, sellers, brands...
            </div>
          </Link>
          <ThemeToggle />
        </div>
        
        {/* Category Chips */}
        <div className={`flex gap-2 overflow-x-auto no-scrollbar pb-2 ${isDark ? 'mask-image-to-right' : ''}`}>
          {categories.map((cat, i) => (
            <button 
              key={cat}
              className={`whitespace-nowrap px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
                i === 0 
                  ? isDark 
                    ? "bg-[#5BA3F5] text-black shadow-[0_0_10px_rgba(91,163,245,0.3)]" 
                    : "bg-[#1B2A4A] text-white shadow-sm"
                  : isDark
                    ? "bg-white/5 text-white/70 border border-white/10 hover:bg-white/10 hover:text-white"
                    : "bg-white border border-stone-400/55 text-stone-600 hover:bg-stone-300/40 hover:text-stone-900"
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Feed Grid */}
      <div className="flex-1 overflow-y-auto px-2 pb-6 no-scrollbar">
        {/* Epplaa Box — pickup locker promo */}
        <div className="px-2 mb-3" data-testid="card-epplaa-box">
          <div
            className={`relative rounded-2xl overflow-hidden ${
              isDark ? "bg-[#0F1525]" : "bg-[#1B2A4A]"
            }`}
          >
            <img
              src={epplaaBoxImage}
              alt="Epplaa Box pickup locker"
              className="w-full h-32 object-cover opacity-90"
            />
            <div className="absolute inset-0 bg-gradient-to-r from-black/70 via-black/30 to-transparent" />
            <div className="absolute inset-0 flex flex-col justify-center px-4">
              <div className="flex items-center gap-1.5 mb-1">
                <MapPin className="w-3 h-3 text-[#5BA3F5]" />
                <span className="text-[10px] uppercase tracking-wider font-bold text-[#5BA3F5]">
                  Epplaa Box
                </span>
              </div>
              <p className="text-sm font-black text-white leading-tight max-w-[60%]">
                Pick up here. Anytime.
              </p>
              <p className="text-[10px] text-white/70 mt-0.5 max-w-[60%]">
                Lockers in Lagos, more cities soon
              </p>
            </div>
          </div>
        </div>

        {/* For You — personalized product picks */}
        {forYouItems.length > 0 && (
          <div className="px-2 mb-3" data-testid="rail-for-you">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-black tracking-tight flex items-center gap-1">
                <Sparkles className={`w-3.5 h-3.5 ${isDark ? "text-[#5BA3F5]" : "text-[#1B2A4A]"}`} />
                For You
              </h2>
            </div>
            <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-2 px-2 pb-1">
              {forYouItems.map((p) => (
                <Link
                  key={p.id}
                  href={`/product/${p.id}`}
                  data-testid={`for-you-${p.id}`}
                  className={`relative shrink-0 w-32 aspect-[3/4] rounded-xl overflow-hidden block ${
                    isDark ? "bg-[#171C30]" : "bg-[#fbeed3] border border-stone-400/35"
                  }`}
                >
                  <img
                    src={p.images?.[0] ?? ""}
                    alt={p.title}
                    className="w-full h-full object-cover"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-transparent to-transparent" />
                  {p.reasons?.[0] && (
                    <div className="absolute top-1.5 left-1.5 bg-black/60 backdrop-blur text-white text-[9px] font-bold px-1.5 py-0.5 rounded">
                      {labelReason(p.reasons[0])}
                    </div>
                  )}
                  <div className="absolute bottom-1.5 left-1.5 right-1.5">
                    <p className="text-[10px] text-white font-medium leading-tight line-clamp-2 mb-0.5">
                      {p.title}
                    </p>
                    <p className={`text-[11px] font-black ${isDark ? "text-[#5BA3F5]" : "text-white"}`}>
                      {formatPrice(p.priceMinor, country)}
                    </p>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Trending Now — live streams ranked by viewer growth */}
        {trendingItems.length > 0 && (
          <div className="px-2 mb-3" data-testid="rail-trending-streams">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-black tracking-tight flex items-center gap-1">
                <Flame className={`w-3.5 h-3.5 ${isDark ? "text-[#FF8855]" : "text-[#E6502E]"}`} />
                Trending Now
              </h2>
            </div>
            <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-2 px-2 pb-1">
              {trendingItems.map((s) => (
                <Link
                  key={s.id}
                  href={`/live/${s.id}`}
                  data-testid={`trending-stream-${s.id}`}
                  className="relative shrink-0 w-32 aspect-[3/4] rounded-xl overflow-hidden block"
                >
                  <img
                    src={s.posterImage}
                    alt={s.title}
                    className="w-full h-full object-cover"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/20" />
                  {s.isLive && (
                    <div
                      className={`absolute top-1.5 left-1.5 text-white text-[9px] font-black px-1.5 py-0.5 rounded flex items-center gap-1 ${
                        isDark ? "bg-[#FF8855]" : "bg-[#E6502E]"
                      } animate-pulse`}
                    >
                      <span className="w-1 h-1 rounded-full bg-white" />
                      LIVE
                    </div>
                  )}
                  <div className="absolute top-1.5 right-1.5 bg-black/60 backdrop-blur text-white text-[9px] font-bold px-1.5 py-0.5 rounded">
                    {formatViewers(s.currentViewers)}
                  </div>
                  <div className="absolute bottom-1.5 left-1.5 right-1.5">
                    <p className="text-[10px] text-white font-bold leading-tight line-clamp-2">
                      {s.title}
                    </p>
                    <p className="text-[9px] text-white/85 mt-0.5">{s.hostName}</p>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Replays rail — horizontal scroll of recently-ended streams */}
        <div className="px-2 mb-3">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-black tracking-tight">
              Live replays
            </h2>
            <Link
              href="/replays"
              data-testid="link-all-replays"
              className={`text-[11px] font-bold flex items-center gap-0.5 ${
                isDark ? "text-[#FF8855]" : "text-[#E6502E]"
              }`}
            >
              See all <ChevronRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-2 px-2 pb-1">
            {SEED_REPLAYS.slice(0, 5).map((r) => (
              <Link
                key={r.id}
                href={`/replay/${r.id}`}
                data-testid={`link-replay-rail-${r.id}`}
                className="relative shrink-0 w-28 aspect-[3/4] rounded-xl overflow-hidden block"
              >
                <img
                  src={r.posterImage}
                  alt={r.title}
                  className="w-full h-full object-cover"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-black/40" />
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="h-9 w-9 rounded-full bg-black/55 backdrop-blur flex items-center justify-center border border-white/25">
                    <Play className="h-4 w-4 fill-white text-white ml-0.5" />
                  </div>
                </div>
                <div className="absolute top-1.5 left-1.5 bg-black/65 backdrop-blur text-white text-[9px] font-bold px-1 py-0.5 rounded flex items-center gap-0.5">
                  <Clock className="h-2.5 w-2.5" />
                  {r.durationLabel}
                </div>
                <div className="absolute bottom-1.5 left-1.5 right-1.5">
                  <p className="text-[10px] font-bold leading-tight text-white line-clamp-2">
                    {r.title}
                  </p>
                  <p className="text-[9px] text-white/80 mt-0.5">
                    {r.hostName} · {r.viewCount}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          
          {SEED_STREAMS.slice(0, 1).map((stream) => (
            <Link key={stream.id} href={`/live/${stream.id}`} className="relative rounded-xl overflow-hidden aspect-[3/4] group block cursor-pointer">
              <img src={stream.posterImage} className="w-full h-full object-cover" alt="Stream" />
              <div className={`absolute inset-0 bg-gradient-to-t ${isDark ? 'from-black/80 via-transparent to-black/20' : 'from-black/70 via-transparent to-black/10'}`}></div>
              <div className={`absolute top-2 left-2 text-white text-[10px] font-black px-2 py-0.5 rounded flex items-center gap-1 ${isDark ? 'bg-[#FF8855] shadow-[0_0_10px_rgba(255,136,85,0.6)] animate-pulse' : 'bg-[#E6502E] shadow-sm animate-pulse'}`}>
                <span className="w-1.5 h-1.5 rounded-full bg-white"></span>
                LIVE
              </div>
              <div className="absolute top-2 right-2 bg-black/50 backdrop-blur text-white text-[10px] font-bold px-1.5 py-0.5 rounded">
                {stream.viewerCount}
              </div>
              <div className="absolute bottom-2 left-2 right-2">
                <p className="text-xs font-bold leading-tight mb-1 text-white line-clamp-2">{stream.title}</p>
                <div className="flex items-center gap-1">
                  <img src={stream.hostAvatar} className={`w-4 h-4 rounded-full border ${isDark ? 'border-[#5BA3F5]' : 'border-[#1B2A4A]'}`} alt="Host" />
                  <span className="text-[10px] text-white/90">{stream.hostName}</span>
                </div>
              </div>
            </Link>
          ))}

          {SEED_PRODUCTS.slice(0, 1).map((product) => (
            <Link key={product.id} href={`/product/${product.id}`} className={`relative rounded-xl overflow-hidden aspect-[3/4] block cursor-pointer ${isDark ? 'bg-[#171C30]' : 'bg-[#fbeed3] border border-stone-400/35'}`}>
              <img src={product.images[0]} className="w-full h-full object-cover opacity-90" alt="Product" />
              <div className={`absolute inset-0 bg-gradient-to-t ${isDark ? 'from-black/80' : 'from-black/60'} via-transparent to-transparent`}></div>
              <div className="absolute bottom-2 left-2 right-2">
                <p className="text-xs font-medium leading-tight text-white/90 line-clamp-1 mb-1">{product.title}</p>
                <p className={`text-sm font-black ${isDark ? 'text-[#5BA3F5]' : 'text-[#1B2A4A]'}`}>{formatPrice(product.priceMinor, country)}</p>
              </div>
            </Link>
          ))}

          {SEED_PRODUCTS.slice(2, 3).map((product) => (
            <Link key={product.id} href={`/product/${product.id}`} className={`relative rounded-xl overflow-hidden aspect-[3/4] block cursor-pointer ${isDark ? 'bg-[#171C30]' : 'bg-[#fbeed3] border border-stone-400/35'}`}>
              <img src={product.images[0]} className="w-full h-full object-cover opacity-90" alt="Product" />
              <div className={`absolute inset-0 bg-gradient-to-t ${isDark ? 'from-black/80' : 'from-black/60'} via-transparent to-transparent`}></div>
              <div className="absolute bottom-2 left-2 right-2">
                <p className="text-xs font-medium leading-tight text-white/90 line-clamp-1 mb-1">{product.title}</p>
                <p className={`text-sm font-black ${isDark ? 'text-[#5BA3F5]' : 'text-[#1B2A4A]'}`}>{formatPrice(product.priceMinor, country)}</p>
              </div>
            </Link>
          ))}

          {SEED_STREAMS.slice(1, 2).map((stream) => (
             <Link key={stream.id} href={`/live/${stream.id}`} className="relative rounded-xl overflow-hidden aspect-[3/4] group block cursor-pointer">
               <img src={stream.posterImage} className="w-full h-full object-cover" alt="Stream" />
               <div className={`absolute inset-0 bg-gradient-to-t ${isDark ? 'from-black/80 via-transparent to-black/20' : 'from-black/70 via-transparent to-black/10'}`}></div>
               <div className={`absolute top-2 left-2 text-white text-[10px] font-black px-2 py-0.5 rounded flex items-center gap-1 ${isDark ? 'bg-[#FF8855] shadow-[0_0_10px_rgba(255,136,85,0.6)] animate-pulse' : 'bg-[#E6502E] shadow-sm animate-pulse'}`}>
                 <span className="w-1.5 h-1.5 rounded-full bg-white"></span>
                 LIVE
               </div>
               <div className="absolute top-2 right-2 bg-black/50 backdrop-blur text-white text-[10px] font-bold px-1.5 py-0.5 rounded">
                 {stream.viewerCount}
               </div>
               <div className="absolute bottom-2 left-2 right-2">
                 <p className="text-xs font-bold leading-tight mb-1 text-white line-clamp-2">{stream.title}</p>
                 <div className="flex items-center gap-1">
                   <img src={stream.hostAvatar} className={`w-4 h-4 rounded-full border ${isDark ? 'border-[#FF8855]' : 'border-[#E6502E]'}`} alt="Host" />
                   <span className="text-[10px] text-white/90">{stream.hostName}</span>
                 </div>
               </div>
             </Link>
           ))}

          {SEED_PRODUCTS.slice(1, 2).map((product) => (
            <Link key={product.id} href={`/product/${product.id}`} className={`relative rounded-xl overflow-hidden aspect-[3/4] block cursor-pointer ${isDark ? 'bg-[#171C30]' : 'bg-[#fbeed3] border border-stone-400/35'}`}>
              <img src={product.images[0]} className="w-full h-full object-cover opacity-90" alt="Product" />
              <div className={`absolute inset-0 bg-gradient-to-t ${isDark ? 'from-black/80' : 'from-black/60'} via-transparent to-transparent`}></div>
              <div className="absolute bottom-2 left-2 right-2">
                <p className="text-xs font-medium leading-tight text-white/90 line-clamp-1 mb-1">{product.title}</p>
                <p className={`text-sm font-black ${isDark ? 'text-[#5BA3F5]' : 'text-[#1B2A4A]'}`}>{formatPrice(product.priceMinor, country)}</p>
              </div>
            </Link>
          ))}
          
           {SEED_STREAMS.slice(2, 3).map((stream) => (
             <Link key={stream.id} href={`/live/${stream.id}`} className="relative rounded-xl overflow-hidden aspect-[3/4] group block cursor-pointer">
               <img src={stream.posterImage} className="w-full h-full object-cover" alt="Stream" />
               <div className={`absolute inset-0 bg-gradient-to-t ${isDark ? 'from-black/80 via-transparent to-black/20' : 'from-black/70 via-transparent to-black/10'}`}></div>
               <div className={`absolute top-2 left-2 text-white text-[10px] font-black px-2 py-0.5 rounded flex items-center gap-1 ${isDark ? 'bg-[#FF8855] shadow-[0_0_10px_rgba(255,136,85,0.6)] animate-pulse' : 'bg-[#E6502E] shadow-sm animate-pulse'}`}>
                 <span className="w-1.5 h-1.5 rounded-full bg-white"></span>
                 LIVE
               </div>
               <div className="absolute top-2 right-2 bg-black/50 backdrop-blur text-white text-[10px] font-bold px-1.5 py-0.5 rounded">
                 {stream.viewerCount}
               </div>
               <div className="absolute bottom-2 left-2 right-2">
                 <p className="text-xs font-bold leading-tight mb-1 text-white line-clamp-2">{stream.title}</p>
                 <div className="flex items-center gap-1">
                   <img src={stream.hostAvatar} className={`w-4 h-4 rounded-full border ${isDark ? 'border-[#FF8855]' : 'border-[#E6502E]'}`} alt="Host" />
                   <span className="text-[10px] text-white/90">{stream.hostName}</span>
                 </div>
               </div>
             </Link>
           ))}

        </div>
      </div>
    </div>
  );
}

function labelReason(reason: string): string {
  switch (reason) {
    case "follows": return "From a seller you follow";
    case "wishlist": return "Like your wishlist";
    case "recently_viewed": return "Based on recent views";
    case "country": return "Popular near you";
    case "trending": return "Trending";
    default: return reason;
  }
}

function formatViewers(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}
