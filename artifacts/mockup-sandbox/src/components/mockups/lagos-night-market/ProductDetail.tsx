import React from "react";
import { ChevronLeft, Share2, Heart, Star, MapPin, Truck, Package, ShieldCheck, ChevronRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function ProductDetail() {
  return (
    <div className="w-[390px] h-[844px] bg-[#050505] text-white relative overflow-hidden font-sans select-none flex flex-col">
      
      {/* Top Header Transparent */}
      <div className="absolute top-0 left-0 right-0 p-4 pt-12 flex justify-between z-20">
        <button className="w-10 h-10 rounded-full bg-black/40 backdrop-blur border border-white/10 flex items-center justify-center hover:bg-black/60">
          <ChevronLeft className="h-6 w-6" />
        </button>
        <div className="flex gap-2">
          <button className="w-10 h-10 rounded-full bg-black/40 backdrop-blur border border-white/10 flex items-center justify-center hover:bg-black/60">
            <Share2 className="h-5 w-5" />
          </button>
          <button className="w-10 h-10 rounded-full bg-black/40 backdrop-blur border border-white/10 flex items-center justify-center hover:bg-black/60">
            <Heart className="h-5 w-5" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto no-scrollbar pb-24">
        {/* Image Carousel */}
        <div className="relative w-full aspect-[4/5] bg-[#111]">
          <img src="/__mockup/images/lagos-product-carousel-1.png" alt="Product" className="w-full h-full object-cover" />
          <div className="absolute bottom-4 right-4 bg-black/60 backdrop-blur text-white text-[10px] font-bold px-2 py-1 rounded border border-white/10">
            1 / 4
          </div>
          <div className="absolute inset-0 bg-gradient-to-t from-[#050505] via-transparent to-transparent opacity-80"></div>
        </div>

        {/* Product Info */}
        <div className="px-4 py-2">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-3xl font-black text-[#00ffff] tracking-tight">₦24,500</p>
              <p className="text-sm text-white/40 line-through">₦32,000</p>
            </div>
            <div className="bg-[#ff00ff]/20 text-[#ff00ff] text-[10px] font-bold px-2 py-1 rounded border border-[#ff00ff]/30 shadow-[0_0_10px_rgba(255,0,255,0.2)]">
              -23% OFF
            </div>
          </div>
          
          <h1 className="text-lg font-bold mt-2 leading-tight">Premium Ankara Two-Piece Set - Lagos Fashion Week Edition</h1>
          
          <div className="flex items-center gap-3 mt-3 text-xs text-white/60">
            <div className="flex items-center gap-1">
              <Star className="w-3 h-3 text-[#ff00ff] fill-[#ff00ff]" />
              <span className="font-bold text-white">4.8</span>
              <span>(124 sold)</span>
            </div>
            <span>•</span>
            <div className="flex items-center gap-1 text-[#00ffff]">
              <MapPin className="w-3 h-3" />
              <span>Made in Nigeria</span>
            </div>
          </div>
        </div>

        {/* Variants */}
        <div className="px-4 py-4 mt-2 border-y border-white/10 bg-white/5">
          <p className="text-sm font-bold mb-3">Select Size</p>
          <div className="flex gap-3">
            {['S', 'M', 'L', 'XL'].map((size, i) => (
              <button 
                key={size} 
                className={`w-12 h-12 rounded-xl flex items-center justify-center text-sm font-bold border transition-all ${
                  i === 1 
                  ? "border-[#00ffff] bg-[#00ffff]/10 text-[#00ffff] shadow-[0_0_10px_rgba(0,255,255,0.2)]" 
                  : "border-white/10 bg-black text-white/70 hover:border-white/30"
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
              <img src="/__mockup/images/lagos-avatar-2.png" className="w-12 h-12 rounded-full border-2 border-[#ff00ff]" alt="Seller" />
              <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 bg-[#ff00ff] text-white text-[8px] font-black px-1 rounded whitespace-nowrap animate-pulse">
                LIVE
              </div>
            </div>
            <div>
              <p className="text-sm font-bold">Ada's Boutique</p>
              <p className="text-xs text-white/50">Lagos seller • 98% positive</p>
            </div>
          </div>
          <Button size="sm" variant="outline" className="h-8 border-[#00ffff] text-[#00ffff] hover:bg-[#00ffff]/10">
            View Shop
          </Button>
        </div>

        {/* Delivery Options */}
        <div className="px-4 py-4 mt-2 bg-white/5 border-y border-white/10">
          <h3 className="text-sm font-bold mb-3">Delivery Options</h3>
          
          <div className="space-y-3">
            <div className="flex gap-3 p-3 rounded-xl bg-black border border-[#00ffff]/30 relative overflow-hidden">
              <div className="absolute top-0 left-0 w-1 h-full bg-[#00ffff]"></div>
              <Package className="w-5 h-5 text-[#00ffff] mt-0.5 shrink-0" />
              <div className="flex-1">
                <div className="flex justify-between items-start">
                  <p className="text-sm font-bold">Epplaa Box Locker</p>
                  <p className="text-sm font-bold text-[#00ffff]">FREE</p>
                </div>
                <p className="text-xs text-white/60 mt-1">Pick up from smart locker near you. Arrives in 1-2 days.</p>
              </div>
            </div>

            <div className="flex gap-3 p-3 rounded-xl bg-black border border-white/10">
              <MapPin className="w-5 h-5 text-white/50 mt-0.5 shrink-0" />
              <div className="flex-1">
                <div className="flex justify-between items-start">
                  <p className="text-sm font-bold text-white/80">PUDO Pickup Partner</p>
                  <p className="text-sm font-bold text-white/80">₦500</p>
                </div>
                <p className="text-xs text-white/50 mt-1">Pick up from a verified local shop.</p>
              </div>
            </div>

            <div className="flex gap-3 p-3 rounded-xl bg-black border border-white/10">
              <Truck className="w-5 h-5 text-white/50 mt-0.5 shrink-0" />
              <div className="flex-1">
                <div className="flex justify-between items-start">
                  <p className="text-sm font-bold text-white/80">Home Delivery</p>
                  <p className="text-sm font-bold text-white/80">₦2,500</p>
                </div>
                <p className="text-xs text-white/50 mt-1">Via Glovo / GIG. Arrives today by 6PM.</p>
              </div>
            </div>
          </div>
        </div>

        {/* Protection */}
        <div className="px-4 py-6 flex items-center gap-2 text-xs text-white/60">
          <ShieldCheck className="w-4 h-4 text-emerald-400" />
          <span>Payment secured by Paystack. Buyer protection included.</span>
        </div>
      </div>

      {/* Sticky Bottom CTA */}
      <div className="absolute bottom-0 left-0 right-0 p-4 bg-[#050505]/90 backdrop-blur-xl border-t border-white/10 flex gap-3 z-20">
        <button className="flex-1 h-14 rounded-xl bg-white/5 border border-white/20 text-white font-bold hover:bg-white/10 transition-colors">
          Add to Cart
        </button>
        <button className="flex-1 h-14 rounded-xl bg-gradient-to-r from-[#ff00ff] to-[#cc00cc] text-white font-black text-lg shadow-[0_0_20px_rgba(255,0,255,0.4)] hover:shadow-[0_0_30px_rgba(255,0,255,0.6)] transition-all">
          Buy Now
        </button>
      </div>

    </div>
  );
}
