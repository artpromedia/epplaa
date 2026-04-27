import { Heart, MessageCircle, Share2, Gift, X } from "lucide-react";
import { Link, useParams } from "wouter";
import { useTheme } from "@/lib/theme-context";
import { SEED_STREAMS, SEED_PRODUCTS, SEED_COMMENTS } from "@/lib/seed";
import { useCountry } from "@/lib/country-context";
import { formatPrice } from "@/lib/format";
import { ThemeToggle } from "@/components/theme-toggle";

export default function LiveShopping() {
  const { streamId } = useParams<{ streamId: string }>();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { country } = useCountry();

  const stream = SEED_STREAMS.find(s => s.id === streamId) || SEED_STREAMS[0];
  const pinnedProduct = SEED_PRODUCTS.find(p => p.id === stream.currentProductId);

  return (
    <div className={`w-full h-full relative overflow-hidden font-sans select-none ${isDark ? 'bg-[#0F1525] text-white' : 'bg-[#fbeed3] text-stone-900'}`}>
      {/* Video Background */}
      <div className="absolute inset-0">
        <img 
          src={stream.posterImage} 
          alt="Live stream" 
          className="w-full h-full object-cover opacity-90"
        />
        {/* Gradient overlays for readability */}
        <div className={`absolute inset-0 bg-gradient-to-b ${isDark ? 'from-black/60 via-transparent to-black/90' : 'from-[#fff5d8]/55 via-transparent to-[#fff5d8]/95'}`}></div>
      </div>

      {/* Top Header */}
      <div className="absolute top-12 left-4 right-4 flex items-center justify-between z-10">
        <div className={`flex items-center backdrop-blur-md rounded-full p-1 pr-3 border ${isDark ? 'bg-black/40 border-white/10' : 'bg-[#fff5d8]/75 border-stone-400/55'}`}>
          <img src={stream.hostAvatar} className="h-8 w-8 rounded-full border border-[#FF8855]" alt={stream.hostName} />
          <div className="ml-2 flex flex-col">
            <span className="text-xs font-bold leading-tight">{stream.hostName}</span>
            <span className={`text-[10px] leading-tight ${isDark ? 'text-white/70' : 'text-stone-700'}`}>{stream.viewerCount} watching</span>
          </div>
          <button className="ml-3 h-6 rounded-full bg-[#5BA3F5] text-black hover:bg-[#3D7BC4] text-xs px-3 font-bold">
            Follow
          </button>
        </div>
        
        <div className="flex gap-2">
          <ThemeToggle variant="overlay" />
          <div className={`backdrop-blur-md h-10 w-10 rounded-full flex items-center justify-center border ${isDark ? 'bg-black/40 border-white/10' : 'bg-[#fff5d8]/75 border-stone-400/55'}`}>
            <span className={`text-xs font-bold ${isDark ? 'text-[#FF8855]' : 'text-[#E6502E]'}`}>LIVE</span>
          </div>
          <Link href="/" className={`backdrop-blur-md h-10 w-10 rounded-full flex items-center justify-center border ${isDark ? 'bg-black/40 border-white/10 text-white' : 'bg-[#fff5d8]/75 border-stone-400/55 text-stone-900'}`}>
            <X className="h-5 w-5" />
          </Link>
        </div>
      </div>

      {/* Main Content Area (Bottom aligned) */}
      <div className="absolute bottom-0 left-0 right-0 p-4 pb-8 flex flex-col justify-end z-10">
        
        {/* Chat Area */}
        <div className="w-[70%] h-48 overflow-y-auto flex flex-col justify-end space-y-3 mb-4 mask-image-to-top">
          {SEED_COMMENTS.slice(0, 4).map((comment, i) => (
            <div key={i} className="flex items-start gap-2">
              {comment.avatar ? (
                <img src={comment.avatar} className={`h-6 w-6 rounded-full border ${isDark ? 'border-white/20' : 'border-stone-400/55'}`} alt={comment.username} />
              ) : (
                <div className={`h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-bold border ${isDark ? `border-white/20 ${comment.darkFallbackBg} ${comment.darkFallbackColor}` : `border-stone-400/55 ${comment.fallbackBg} ${comment.fallbackColor}`}`}>
                  {comment.avatarFallback}
                </div>
              )}
              <div className={`backdrop-blur-sm rounded-xl rounded-tl-none p-2 border ${isDark ? 'bg-black/30 border-white/5' : 'bg-[#fff5d8]/75 border-stone-400/35'}`}>
                <p className={`text-[10px] font-bold mb-0.5 ${isDark ? comment.darkColor : comment.color}`}>{comment.username}</p>
                <p className="text-xs">{comment.text}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="flex gap-3 items-end">
          {/* Pinned Product Card */}
          {pinnedProduct && (
            <Link href={`/product/${pinnedProduct.id}`} className={`flex-1 backdrop-blur-xl border rounded-2xl p-3 flex gap-3 relative overflow-hidden block ${isDark ? 'bg-black/60 border-[#FF8855]/30 shadow-[0_0_20px_rgba(255,136,85,0.15)]' : 'bg-[#fff5d8]/85 border-[#E6502E]/30 shadow-md'}`}>
              <div className={`absolute top-0 right-0 w-16 h-16 blur-xl rounded-full ${isDark ? 'bg-[#FF8855]/20' : 'bg-[#E6502E]/10'}`}></div>
              <img src={pinnedProduct.images[0]} alt="Product" className={`w-16 h-16 rounded-xl object-cover border ${isDark ? 'border-white/10' : 'border-stone-400/35'}`} />
              <div className="flex-1 flex flex-col justify-between z-10">
                <div>
                  <p className="text-xs font-bold leading-tight line-clamp-2">{pinnedProduct.title}</p>
                  <p className={`text-sm font-black mt-1 ${isDark ? 'text-[#5BA3F5]' : 'text-[#1B2A4A]'}`}>{formatPrice(pinnedProduct.priceMinor, country)}</p>
                </div>
                <button className={`h-7 w-full mt-2 text-white text-xs font-bold rounded-lg ${isDark ? 'bg-[#FF8855] hover:bg-[#FF6B35] shadow-[0_0_10px_rgba(255,136,85,0.4)]' : 'bg-[#E6502E] hover:bg-[#C4441E] shadow-[0_4px_10px_rgba(230,80,46,0.3)]'}`}>
                  Buy now
                </button>
              </div>
            </Link>
          )}
          {!pinnedProduct && <div className="flex-1" />}

          {/* Action Rail */}
          <div className="flex flex-col gap-4">
            <div className="flex flex-col items-center gap-1">
              <button className={`h-12 w-12 rounded-full backdrop-blur-md border flex items-center justify-center hover:scale-110 transition-transform ${isDark ? 'bg-black/40 border-white/10 text-white hover:bg-white/20' : 'bg-[#fff5d8]/75 border-stone-400/55 text-stone-900 hover:bg-stone-300/40'}`}>
                <Heart className={`h-6 w-6 ${isDark ? 'text-[#FF8855] fill-[#FF8855]' : 'text-[#E6502E] fill-[#E6502E]'}`} />
              </button>
              <span className={`text-[10px] font-bold ${isDark ? 'text-white' : 'text-stone-800'}`}>12.8K</span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <button className={`h-12 w-12 rounded-full backdrop-blur-md border flex items-center justify-center hover:scale-110 transition-transform ${isDark ? 'bg-black/40 border-white/10 text-white hover:bg-white/20' : 'bg-[#fff5d8]/75 border-stone-400/55 text-stone-900 hover:bg-stone-300/40'}`}>
                <MessageCircle className="h-6 w-6" />
              </button>
              <span className={`text-[10px] font-bold ${isDark ? 'text-white' : 'text-stone-800'}`}>452</span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <button className={`h-12 w-12 rounded-full backdrop-blur-md border flex items-center justify-center hover:scale-110 transition-transform ${isDark ? 'bg-black/40 border-white/10 text-white hover:bg-white/20' : 'bg-[#fff5d8]/75 border-stone-400/55 text-stone-900 hover:bg-stone-300/40'}`}>
                <Share2 className="h-6 w-6" />
              </button>
              <span className={`text-[10px] font-bold ${isDark ? 'text-white' : 'text-stone-800'}`}>Share</span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <button className={`h-12 w-12 rounded-full backdrop-blur-md border flex items-center justify-center hover:scale-110 transition-transform ${isDark ? 'bg-[#FF8855]/20 border-[#FF8855]/50 text-[#FF8855] hover:bg-[#FF8855]/40 shadow-[0_0_15px_rgba(255,136,85,0.3)]' : 'bg-[#E6502E]/10 border-[#E6502E]/30 text-[#E6502E] hover:bg-[#E6502E]/20 shadow-sm'}`}>
                <Gift className="h-6 w-6" />
              </button>
              <span className={`text-[10px] font-bold ${isDark ? 'text-[#FF8855]' : 'text-[#E6502E]'}`}>Gift</span>
            </div>
          </div>
        </div>

        {/* Comment Input */}
        <div className="mt-4 flex gap-2 items-center">
          <div className={`flex-1 backdrop-blur-md border rounded-full h-10 px-4 flex items-center ${isDark ? 'bg-black/40 border-white/10' : 'bg-[#fff5d8]/75 border-stone-400/55'}`}>
            <span className={`text-sm ${isDark ? 'text-white/50' : 'text-stone-500'}`}>Add a comment...</span>
          </div>
        </div>

      </div>
    </div>
  );
}
