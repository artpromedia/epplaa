import React from "react";
import { Search, Home, Compass, MessageSquare, User, Plus } from "lucide-react";
import { Input } from "@/components/ui/input";

export default function Discovery() {
  const categories = ["For You", "Beauty", "Phones", "Fashion", "Home", "Imports", "Electronics"];

  return (
    <div className="w-[390px] h-[844px] bg-[#050505] text-white relative overflow-hidden font-sans select-none flex flex-col">
      {/* Header */}
      <div className="pt-12 pb-4 px-4 bg-gradient-to-b from-[#000000] to-transparent z-10">
        <div className="flex items-center gap-3 mb-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-white/50" />
            <Input 
              placeholder="Search Lagos Night Market..." 
              className="bg-white/5 border-white/10 pl-10 h-10 rounded-full text-sm focus-visible:ring-[#ff00ff] placeholder:text-white/40"
            />
          </div>
        </div>
        
        {/* Category Chips */}
        <div className="flex gap-2 overflow-x-auto no-scrollbar pb-2 mask-image-to-right">
          {categories.map((cat, i) => (
            <button 
              key={cat}
              className={`whitespace-nowrap px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
                i === 0 
                  ? "bg-[#00ffff] text-black shadow-[0_0_10px_rgba(0,255,255,0.3)]" 
                  : "bg-white/5 text-white/70 border border-white/10 hover:bg-white/10 hover:text-white"
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Feed Grid */}
      <div className="flex-1 overflow-y-auto px-2 pb-24 no-scrollbar">
        <div className="grid grid-cols-2 gap-2">
          
          {/* Live Tile 1 */}
          <div className="relative rounded-xl overflow-hidden aspect-[3/4] group">
            <img src="/__mockup/images/lagos-host-stream.png" className="w-full h-full object-cover" alt="Stream" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/20"></div>
            <div className="absolute top-2 left-2 bg-[#ff00ff] text-white text-[10px] font-black px-2 py-0.5 rounded flex items-center gap-1 shadow-[0_0_10px_rgba(255,0,255,0.6)] animate-pulse">
              <span className="w-1.5 h-1.5 rounded-full bg-white"></span>
              LIVE
            </div>
            <div className="absolute top-2 right-2 bg-black/50 backdrop-blur text-white text-[10px] font-bold px-1.5 py-0.5 rounded">
              2.4K
            </div>
            <div className="absolute bottom-2 left-2 right-2">
              <p className="text-xs font-bold leading-tight mb-1 text-white line-clamp-2">Naija Beauty Haul! Glow up szn ✨</p>
              <div className="flex items-center gap-1">
                <img src="/__mockup/images/lagos-avatar-2.png" className="w-4 h-4 rounded-full border border-[#00ffff]" alt="Host" />
                <span className="text-[10px] text-white/80">Ada Beauty</span>
              </div>
            </div>
          </div>

          {/* Product Tile 1 */}
          <div className="relative rounded-xl overflow-hidden aspect-[3/4] bg-[#111]">
            <img src="/__mockup/images/lagos-product-serum.png" className="w-full h-full object-cover opacity-80" alt="Product" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent"></div>
            <div className="absolute bottom-2 left-2 right-2">
              <p className="text-xs font-medium leading-tight text-white/90 line-clamp-1 mb-1">Tokyo Glass Skin Serum</p>
              <p className="text-sm font-black text-[#00ffff]">₦18,500</p>
            </div>
          </div>

          {/* Product Tile 2 */}
          <div className="relative rounded-xl overflow-hidden aspect-[3/4] bg-[#111]">
            <img src="/__mockup/images/lagos-feed-1.png" className="w-full h-full object-cover" alt="Product" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent"></div>
            <div className="absolute bottom-2 left-2 right-2">
              <p className="text-xs font-medium leading-tight text-white/90 line-clamp-1 mb-1">AirMax Imports Direct</p>
              <p className="text-sm font-black text-[#00ffff]">₦45,000</p>
            </div>
          </div>

          {/* Live Tile 2 */}
          <div className="relative rounded-xl overflow-hidden aspect-[3/4] group">
            <img src="/__mockup/images/lagos-feed-2.png" className="w-full h-full object-cover" alt="Stream" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/20"></div>
            <div className="absolute top-2 left-2 bg-[#ff00ff] text-white text-[10px] font-black px-2 py-0.5 rounded flex items-center gap-1 shadow-[0_0_10px_rgba(255,0,255,0.6)]">
              <span className="w-1.5 h-1.5 rounded-full bg-white"></span>
              LIVE
            </div>
            <div className="absolute top-2 right-2 bg-black/50 backdrop-blur text-white text-[10px] font-bold px-1.5 py-0.5 rounded">
              856
            </div>
            <div className="absolute bottom-2 left-2 right-2">
              <p className="text-xs font-bold leading-tight mb-1 text-white line-clamp-2">Shenzhen tech drops 🔥</p>
              <div className="flex items-center gap-1">
                <img src="/__mockup/images/lagos-avatar-1.png" className="w-4 h-4 rounded-full border border-[#ff00ff]" alt="Host" />
                <span className="text-[10px] text-white/80">TechBoy</span>
              </div>
            </div>
          </div>

          {/* Product Tile 3 */}
          <div className="relative rounded-xl overflow-hidden aspect-[3/4] bg-[#111]">
            <img src="/__mockup/images/lagos-product-carousel-1.png" className="w-full h-full object-cover opacity-90" alt="Product" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent"></div>
            <div className="absolute bottom-2 left-2 right-2">
              <p className="text-xs font-medium leading-tight text-white/90 line-clamp-1 mb-1">Ankara Two-Piece</p>
              <p className="text-sm font-black text-[#00ffff]">₦22,000</p>
            </div>
          </div>

        </div>
      </div>

      {/* Bottom Nav */}
      <div className="absolute bottom-0 left-0 right-0 h-20 bg-[#0a0a0a]/90 backdrop-blur-xl border-t border-white/5 flex items-center justify-around px-2 pb-4 z-20">
        <button className="flex flex-col items-center gap-1 w-16 text-white/50 hover:text-white">
          <Home className="h-6 w-6" />
          <span className="text-[10px] font-medium">Home</span>
        </button>
        <button className="flex flex-col items-center gap-1 w-16 text-[#00ffff]">
          <Compass className="h-6 w-6" />
          <span className="text-[10px] font-medium">Discover</span>
        </button>
        
        <div className="relative -top-5">
          <button className="h-14 w-14 rounded-full bg-gradient-to-tr from-[#ff00ff] to-[#00ffff] p-[2px] shadow-[0_0_20px_rgba(255,0,255,0.4)]">
            <div className="h-full w-full bg-black rounded-full flex items-center justify-center">
              <Plus className="h-6 w-6 text-white" />
            </div>
          </button>
        </div>

        <button className="flex flex-col items-center gap-1 w-16 text-white/50 hover:text-white relative">
          <MessageSquare className="h-6 w-6" />
          <span className="absolute top-0 right-3 w-2 h-2 rounded-full bg-[#ff00ff]"></span>
          <span className="text-[10px] font-medium">Inbox</span>
        </button>
        <button className="flex flex-col items-center gap-1 w-16 text-white/50 hover:text-white">
          <User className="h-6 w-6" />
          <span className="text-[10px] font-medium">Profile</span>
        </button>
      </div>

    </div>
  );
}
