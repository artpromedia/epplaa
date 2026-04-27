import { Search } from "lucide-react";
import { Link } from "wouter";
import { useTheme } from "@/lib/theme-context";
import { SEED_PRODUCTS, SEED_STREAMS } from "@/lib/seed";
import { useCountry } from "@/lib/country-context";
import { formatPrice } from "@/lib/format";
import { ThemeToggle } from "@/components/theme-toggle";

export default function Discovery() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { country } = useCountry();
  
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
