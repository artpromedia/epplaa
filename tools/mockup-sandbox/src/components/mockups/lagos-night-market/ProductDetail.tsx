import React, { useState } from "react";
import { ChevronLeft, Share2, Heart, Star, MapPin, Truck, Package, ShieldCheck, ChevronRight, Check, Sun, Moon } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function ProductDetail() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const isDark = theme === "dark";

  return (
    <div className={`w-[390px] h-[844px] relative overflow-hidden font-sans select-none flex flex-col ${isDark ? 'bg-[#050505] text-white' : 'bg-[#fbeed3] text-stone-900'}`}>
      
      {/* Top Header Transparent */}
      <div className="absolute top-0 left-0 right-0 p-4 pt-12 flex justify-between z-20">
        <button className={`w-10 h-10 rounded-full backdrop-blur border flex items-center justify-center transition-colors ${isDark ? 'bg-black/40 border-white/10 hover:bg-black/60 text-white' : 'bg-[#fff5d8]/75 border-stone-400/55 hover:bg-[#fff5d8]/85 text-stone-900'}`}>
          <ChevronLeft className="h-6 w-6" />
        </button>
        <div className="flex gap-2">
          <button 
            onClick={() => setTheme(isDark ? "light" : "dark")}
            className={`w-10 h-10 rounded-full backdrop-blur border flex items-center justify-center transition-colors ${isDark ? 'bg-black/40 border-white/10 hover:bg-black/60 text-white' : 'bg-[#fff5d8]/75 border-stone-400/55 hover:bg-[#fff5d8]/85 text-stone-900'}`}
          >
            {isDark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
          </button>
          <button className={`w-10 h-10 rounded-full backdrop-blur border flex items-center justify-center transition-colors ${isDark ? 'bg-black/40 border-white/10 hover:bg-black/60 text-white' : 'bg-[#fff5d8]/75 border-stone-400/55 hover:bg-[#fff5d8]/85 text-stone-900'}`}>
            <Share2 className="h-5 w-5" />
          </button>
          <button className={`w-10 h-10 rounded-full backdrop-blur border flex items-center justify-center transition-colors ${isDark ? 'bg-black/40 border-white/10 hover:bg-black/60 text-white' : 'bg-[#fff5d8]/75 border-stone-400/55 hover:bg-[#fff5d8]/85 text-stone-900'}`}>
            <Heart className="h-5 w-5" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto no-scrollbar pb-24">
        {/* Image Carousel */}
        <div className={`relative w-full aspect-[4/5] ${isDark ? 'bg-[#111]' : 'bg-[#fbeed3]'}`}>
          <img src="/__mockup/images/lagos-product-carousel-1.png" alt="Product" className="w-full h-full object-cover" />
          <div className={`absolute bottom-4 right-4 backdrop-blur text-[10px] font-bold px-2 py-1 rounded border ${isDark ? 'bg-black/60 text-white border-white/10' : 'bg-[#fff5d8]/75 text-stone-900 border-stone-400/55'}`}>
            1 / 4
          </div>
          <div className={`absolute inset-0 bg-gradient-to-t ${isDark ? 'from-[#050505]' : 'from-[#fcfcf9]'} via-transparent to-transparent opacity-80`}></div>
        </div>

        {/* Product Info */}
        <div className="px-4 py-2">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className={`text-3xl font-black tracking-tight ${isDark ? 'text-[#00ffff]' : 'text-[#00b3b3]'}`}>₦24,500</p>
              <p className={`text-sm line-through ${isDark ? 'text-white/40' : 'text-stone-400'}`}>₦32,000</p>
            </div>
            <div className={`text-[10px] font-bold px-2 py-1 rounded border ${isDark ? 'bg-[#ff00ff]/20 text-[#ff00ff] border-[#ff00ff]/30 shadow-[0_0_10px_rgba(255,0,255,0.2)]' : 'bg-[#d900d9]/10 text-[#d900d9] border-[#d900d9]/30'}`}>
              -23% OFF
            </div>
          </div>
          
          <h1 className="text-lg font-bold mt-2 leading-tight">Premium Ankara Two-Piece Set - Lagos Fashion Week Edition</h1>
          
          <div className={`flex items-center gap-3 mt-3 text-xs ${isDark ? 'text-white/60' : 'text-stone-500'}`}>
            <div className="flex items-center gap-1">
              <Star className={`w-3 h-3 fill-current ${isDark ? 'text-[#ff00ff]' : 'text-[#d900d9]'}`} />
              <span className={`font-bold ${isDark ? 'text-white' : 'text-stone-800'}`}>4.8</span>
              <span>(124 sold)</span>
            </div>
            <span>•</span>
            <div className={`flex items-center gap-1 ${isDark ? 'text-[#00ffff]' : 'text-[#00b3b3]'}`}>
              <MapPin className="w-3 h-3" />
              <span>Made in Nigeria</span>
            </div>
          </div>
        </div>

        {/* Variants */}
        <div className={`px-4 py-4 mt-2 border-y ${isDark ? 'border-white/10 bg-white/5' : 'border-stone-400/35 bg-stone-300/35'}`}>
          <p className="text-sm font-bold mb-3">Select Size</p>
          <div className="flex gap-3">
            {['S', 'M', 'L', 'XL'].map((size, i) => (
              <button 
                key={size} 
                className={`w-12 h-12 rounded-xl flex items-center justify-center text-sm font-bold border transition-all ${
                  i === 1 
                  ? isDark 
                    ? "border-[#00ffff] bg-[#00ffff]/10 text-[#00ffff] shadow-[0_0_10px_rgba(0,255,255,0.2)]" 
                    : "border-[#00b3b3] bg-[#00b3b3]/10 text-[#00b3b3] shadow-sm"
                  : isDark
                    ? "border-white/10 bg-black text-white/70 hover:border-white/30"
                    : "border-stone-400/55 bg-white text-stone-600 hover:border-stone-500/45"
                }`}
              >
                {size}
              </button>
            ))}
          </div>
        </div>

        {/* Seller Info */}
        <div className="px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="relative">
              <img src="/__mockup/images/lagos-avatar-2.png" className={`w-12 h-12 rounded-full border-2 ${isDark ? 'border-[#ff00ff]' : 'border-[#d900d9]'}`} alt="Seller" />
              <div className={`absolute -bottom-1 left-1/2 -translate-x-1/2 text-white text-[8px] font-black px-1 rounded whitespace-nowrap animate-pulse ${isDark ? 'bg-[#ff00ff]' : 'bg-[#d900d9]'}`}>
                LIVE
              </div>
            </div>
            <div>
              <p className="text-sm font-bold">Ada's Boutique</p>
              <p className={`text-xs ${isDark ? 'text-white/50' : 'text-stone-500'}`}>Lagos seller • 98% positive</p>
            </div>
          </div>
          <Button size="sm" variant="outline" className={`h-8 bg-transparent ${isDark ? 'border-[#00ffff] text-[#00ffff] hover:bg-[#00ffff]/10' : 'border-[#00b3b3] text-[#00b3b3] hover:bg-[#00b3b3]/10'}`}>
            View Shop
          </Button>
        </div>

        {/* Delivery Options */}
        <div className={`px-4 py-4 mt-2 border-y ${isDark ? 'bg-white/5 border-white/10' : 'bg-stone-300/35 border-stone-400/35'}`}>
          <h3 className="text-sm font-bold mb-3">Delivery Options</h3>
          
          <div className="space-y-3">
            <div className={`flex gap-3 p-3 rounded-xl border relative overflow-hidden ${isDark ? 'bg-black border-[#00ffff]/30' : 'bg-white border-[#00b3b3]/30'}`}>
              <div className={`absolute top-0 left-0 w-1 h-full ${isDark ? 'bg-[#00ffff]' : 'bg-[#00b3b3]'}`}></div>
              <Package className={`w-5 h-5 mt-0.5 shrink-0 ${isDark ? 'text-[#00ffff]' : 'text-[#00b3b3]'}`} />
              <div className="flex-1">
                <div className="flex justify-between items-start">
                  <p className="text-sm font-bold">Epplaa Box Locker</p>
                  <p className={`text-sm font-bold ${isDark ? 'text-[#00ffff]' : 'text-[#00b3b3]'}`}>FREE</p>
                </div>
                <p className={`text-xs mt-1 ${isDark ? 'text-white/60' : 'text-stone-500'}`}>Pick up from smart locker near you. Arrives in 1-2 days.</p>
              </div>
            </div>

            <div className={`flex gap-3 p-3 rounded-xl border ${isDark ? 'bg-black border-white/10' : 'bg-white border-stone-400/55'}`}>
              <MapPin className={`w-5 h-5 mt-0.5 shrink-0 ${isDark ? 'text-white/50' : 'text-stone-400'}`} />
              <div className="flex-1">
                <div className="flex justify-between items-start">
                  <p className={`text-sm font-bold ${isDark ? 'text-white/80' : 'text-stone-800'}`}>PUDO Pickup Partner</p>
                  <p className={`text-sm font-bold ${isDark ? 'text-white/80' : 'text-stone-800'}`}>₦500</p>
                </div>
                <p className={`text-xs mt-1 ${isDark ? 'text-white/50' : 'text-stone-500'}`}>Pick up from a verified local shop.</p>
              </div>
            </div>

            <div className={`flex gap-3 p-3 rounded-xl border ${isDark ? 'bg-black border-white/10' : 'bg-white border-stone-400/55'}`}>
              <Truck className={`w-5 h-5 mt-0.5 shrink-0 ${isDark ? 'text-white/50' : 'text-stone-400'}`} />
              <div className="flex-1">
                <div className="flex justify-between items-start">
                  <p className={`text-sm font-bold ${isDark ? 'text-white/80' : 'text-stone-800'}`}>Home Delivery</p>
                  <p className={`text-sm font-bold ${isDark ? 'text-white/80' : 'text-stone-800'}`}>₦2,500</p>
                </div>
                <p className={`text-xs mt-1 ${isDark ? 'text-white/50' : 'text-stone-500'}`}>Via Glovo / GIG. Arrives today by 6PM.</p>
              </div>
            </div>
          </div>
        </div>

        {/* Protection */}
        <div className={`px-4 py-6 flex items-center gap-2 text-xs ${isDark ? 'text-white/60' : 'text-stone-500'}`}>
          <ShieldCheck className="w-4 h-4 text-emerald-500" />
          <span>Payment secured by Paystack. Buyer protection included.</span>
        </div>
      </div>

      {/* Sticky Bottom CTA */}
      <div className={`absolute bottom-0 left-0 right-0 p-4 backdrop-blur-xl border-t flex gap-3 z-20 ${isDark ? 'bg-[#050505]/90 border-white/10' : 'bg-[#fbeed3]/90 border-stone-400/55'}`}>
        <button className={`flex-1 h-14 rounded-xl border font-bold transition-colors ${isDark ? 'bg-white/5 border-white/20 text-white hover:bg-white/10' : 'bg-stone-300/35 border-stone-400/55 text-stone-900 hover:bg-stone-300/55'}`}>
          Add to Cart
        </button>
        <button className={`flex-1 h-14 rounded-xl text-white font-black text-lg transition-all ${isDark ? 'bg-gradient-to-r from-[#ff00ff] to-[#cc00cc] shadow-[0_0_20px_rgba(255,0,255,0.4)] hover:shadow-[0_0_30px_rgba(255,0,255,0.6)]' : 'bg-gradient-to-r from-[#d900d9] to-[#b300b3] shadow-md hover:shadow-lg'}`}>
          Buy Now
        </button>
      </div>

    </div>
  );
}
