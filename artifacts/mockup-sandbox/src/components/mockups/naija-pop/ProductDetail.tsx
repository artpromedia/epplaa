import React, { useState } from "react";
import { ChevronLeft, Share2, Heart, Star, ChevronRight, Package, MapPin, Truck, ShieldCheck, Home, Compass, PlusSquare, Inbox, User, MessageCircle } from "lucide-react";

export function ProductDetail() {
  const [selectedSize, setSelectedSize] = useState("M");
  const [isLiked, setIsLiked] = useState(false);

  return (
    <div className="flex justify-center items-center min-h-screen bg-gray-100 font-['Plus_Jakarta_Sans']">
      <div className="relative w-[390px] h-[844px] bg-[#FAFAFA] overflow-hidden shadow-2xl flex flex-col">
        
        {/* Top Nav (Absolute over image) */}
        <div className="absolute top-12 left-4 right-4 flex justify-between items-center z-10">
          <button className="w-10 h-10 bg-white/80 backdrop-blur-md rounded-full flex items-center justify-center border-2 border-black shadow-[2px_2px_0px_#000]">
            <ChevronLeft size={24} className="text-black pr-1" />
          </button>
          <div className="flex gap-2">
            <button className="w-10 h-10 bg-white/80 backdrop-blur-md rounded-full flex items-center justify-center border-2 border-black shadow-[2px_2px_0px_#000]">
              <Share2 size={20} className="text-black" />
            </button>
            <button 
              onClick={() => setIsLiked(!isLiked)}
              className="w-10 h-10 bg-white/80 backdrop-blur-md rounded-full flex items-center justify-center border-2 border-black shadow-[2px_2px_0px_#000]"
            >
              <Heart size={20} className={isLiked ? "fill-[#FF3366] text-[#FF3366]" : "text-black"} />
            </button>
          </div>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto pb-32">
          {/* Product Image */}
          <div className="w-full aspect-[4/5] bg-gray-200 relative border-b-4 border-black">
            <img src="/__mockup/images/naija-pop-product-fashion.png" className="w-full h-full object-cover" alt="Ankara Two Piece" />
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-1">
              <div className="w-2 h-2 rounded-full bg-black"></div>
              <div className="w-2 h-2 rounded-full bg-white border border-black"></div>
              <div className="w-2 h-2 rounded-full bg-white border border-black"></div>
              <div className="w-2 h-2 rounded-full bg-white border border-black"></div>
            </div>
            <div className="absolute bottom-4 right-4 bg-[#FFCC00] text-black text-xs font-bold px-2 py-1 rounded border-2 border-black shadow-[2px_2px_0px_#000]">
              1/4
            </div>
          </div>

          <div className="p-4 bg-white border-b-4 border-black">
            <div className="flex justify-between items-start mb-2">
              <div className="flex flex-col">
                <span className="text-[#FF3366] font-black text-3xl font-mono tracking-tighter shadow-sm">₦18,500</span>
                <span className="text-gray-400 font-bold text-sm line-through">₦25,000</span>
              </div>
              <div className="bg-[#00E5FF] text-black text-[10px] font-black px-2 py-1 rounded uppercase border-2 border-black shadow-[2px_2px_0px_#000] rotate-3">
                -26% OFF
              </div>
            </div>
            
            <h1 className="text-xl font-bold font-['Space_Grotesk'] leading-tight mb-2 text-black">
              Ankara Two-Piece Set (Owanbe Ready) - Premium Cotton Blend
            </h1>
            
            <div className="flex items-center gap-2 mb-3">
              <div className="flex text-[#FFCC00]">
                <Star size={14} fill="currentColor" />
                <Star size={14} fill="currentColor" />
                <Star size={14} fill="currentColor" />
                <Star size={14} fill="currentColor" />
                <Star size={14} fill="currentColor" className="text-gray-300" />
              </div>
              <span className="text-xs font-bold text-gray-500">4.8 (124 reviews)</span>
              <span className="text-xs font-bold text-gray-300">•</span>
              <span className="text-xs font-bold text-gray-500">430 sold</span>
            </div>

            <div className="inline-flex bg-zinc-100 text-zinc-800 text-[10px] font-bold px-2 py-1 rounded border border-zinc-300 items-center gap-1">
              <MapPin size={12} /> Sold by Lagos Seller
            </div>
          </div>

          {/* Seller Block */}
          <div className="p-4 bg-[#FAFAFA] border-b-4 border-black flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="relative">
                <img src="/__mockup/images/naija-pop-avatar.png" className="w-12 h-12 rounded-full border-2 border-black" alt="Seller Avatar" />
                <div className="absolute -bottom-2 -left-1 bg-[#FF3366] text-white text-[8px] font-bold px-1.5 py-0.5 rounded border border-black uppercase flex items-center gap-0.5">
                  <span className="w-1 h-1 bg-white rounded-full animate-pulse"></span> Live
                </div>
              </div>
              <div>
                <h3 className="font-bold text-sm text-black">Chioma Style</h3>
                <p className="text-xs text-gray-500 font-medium">98% positive feedback</p>
              </div>
            </div>
            <button className="bg-black text-white text-xs font-bold px-4 py-2 rounded-full shadow-[2px_2px_0px_#FFCC00]">
              Follow
            </button>
          </div>

          {/* Variants */}
          <div className="p-4 bg-white border-b-4 border-black">
            <h3 className="font-bold text-sm mb-3 text-black">Select Size</h3>
            <div className="flex gap-3">
              {['S', 'M', 'L', 'XL', 'XXL'].map((size) => (
                <button 
                  key={size}
                  onClick={() => setSelectedSize(size)}
                  className={`w-12 h-12 rounded-xl flex items-center justify-center font-bold text-sm border-2 transition-all ${
                    selectedSize === size 
                      ? 'border-black bg-[#FFCC00] shadow-[2px_2px_0px_#000] -translate-y-0.5' 
                      : 'border-gray-200 bg-white text-gray-500 hover:border-black'
                  }`}
                >
                  {size}
                </button>
              ))}
            </div>
          </div>

          {/* Delivery Options */}
          <div className="p-4 bg-white border-b-4 border-black">
            <h3 className="font-bold text-sm mb-3 text-black">Delivery in Lagos</h3>
            <div className="flex flex-col gap-3">
              
              <div className="flex gap-3 p-3 rounded-xl border-2 border-black bg-blue-50/50 relative overflow-hidden">
                <div className="absolute top-0 right-0 bg-[#00E5FF] text-black text-[9px] font-bold px-2 py-0.5 border-b-2 border-l-2 border-black">CHEAPEST</div>
                <div className="bg-white w-10 h-10 rounded-lg border-2 border-black flex items-center justify-center shadow-[2px_2px_0px_#000] shrink-0">
                  <Package size={20} className="text-black" />
                </div>
                <div className="flex-1">
                  <h4 className="font-bold text-sm text-black">Epplaa Box Locker</h4>
                  <p className="text-xs text-gray-500 mt-0.5">Pick up at any Smart Locker</p>
                  <p className="text-xs font-bold text-[#FF3366] mt-1">Free Delivery</p>
                </div>
              </div>

              <div className="flex gap-3 p-3 rounded-xl border-2 border-gray-200 bg-white">
                <div className="bg-gray-100 w-10 h-10 rounded-lg flex items-center justify-center shrink-0">
                  <MapPin size={20} className="text-gray-500" />
                </div>
                <div className="flex-1">
                  <h4 className="font-bold text-sm text-black">PUDO Partner Store</h4>
                  <p className="text-xs text-gray-500 mt-0.5">Pick up at a nearby agent</p>
                  <p className="text-xs font-bold text-black mt-1">₦500</p>
                </div>
              </div>

              <div className="flex gap-3 p-3 rounded-xl border-2 border-gray-200 bg-white">
                <div className="bg-gray-100 w-10 h-10 rounded-lg flex items-center justify-center shrink-0">
                  <Truck size={20} className="text-gray-500" />
                </div>
                <div className="flex-1">
                  <h4 className="font-bold text-sm text-black">Home Delivery</h4>
                  <p className="text-xs text-gray-500 mt-0.5">Delivered by Kwik (1-2 days)</p>
                  <p className="text-xs font-bold text-black mt-1">₦1,500</p>
                </div>
              </div>

            </div>
          </div>

          {/* Payment Info */}
          <div className="p-4 bg-[#FAFAFA] mb-8">
            <div className="flex items-center gap-2 mb-2 text-xs font-bold text-gray-500">
              <ShieldCheck size={14} className="text-green-600" /> Safe Payments via Paystack
            </div>
            <div className="flex gap-2 text-[10px] font-bold text-black/60 opacity-80 uppercase tracking-wider">
              <span>Cards</span> • <span>Transfer</span> • <span>USSD</span>
            </div>
          </div>
        </div>

        {/* Sticky Bottom Nav / CTA */}
        <div className="absolute bottom-0 left-0 right-0 bg-white border-t-4 border-black z-50">
          <div className="flex gap-3 p-4 pb-2">
            <button className="w-14 h-14 rounded-2xl bg-white border-2 border-black flex flex-col items-center justify-center shadow-[2px_2px_0px_#000] shrink-0 active:translate-y-0.5 active:shadow-[0px_0px_0px_#000] transition-all">
              <MessageCircle size={20} className="text-black" />
              <span className="text-[9px] font-bold mt-1">Chat</span>
            </button>
            <button className="flex-1 h-14 rounded-2xl bg-[#00E5FF] border-2 border-black flex items-center justify-center font-bold text-black shadow-[4px_4px_0px_#000] active:translate-y-1 active:shadow-[0px_0px_0px_#000] transition-all text-sm uppercase tracking-wide">
              Add to Cart
            </button>
            <button className="flex-1 h-14 rounded-2xl bg-[#FF3366] border-2 border-black flex items-center justify-center font-bold text-white shadow-[4px_4px_0px_#000] active:translate-y-1 active:shadow-[0px_0px_0px_#000] transition-all text-sm uppercase tracking-wide">
              Buy Now
            </button>
          </div>
          
          {/* App Bottom Nav Indicator (Fake) */}
          <div className="px-6 py-2 pb-6 flex justify-between items-center opacity-40 grayscale pointer-events-none mt-2 border-t border-gray-100">
            <button className="flex flex-col items-center gap-1 text-black">
              <Home size={20} strokeWidth={2.5} />
            </button>
            <button className="flex flex-col items-center gap-1 text-black">
              <Compass size={20} strokeWidth={2.5} />
            </button>
            <button className="flex flex-col items-center gap-1 text-black">
              <PlusSquare size={20} strokeWidth={2.5} />
            </button>
            <button className="flex flex-col items-center gap-1 text-black">
              <Inbox size={20} strokeWidth={2.5} />
            </button>
            <button className="flex flex-col items-center gap-1 text-black">
              <User size={20} strokeWidth={2.5} />
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
