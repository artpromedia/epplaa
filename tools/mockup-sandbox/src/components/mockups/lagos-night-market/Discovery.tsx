import React, { useState } from "react";
import { Search, Home, Compass, MessageSquare, User, Plus, Sun, Moon } from "lucide-react";
import { Input } from "@/components/ui/input";

export default function Discovery() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const isDark = theme === "dark";
  const categories = ["For You", "Beauty", "Phones", "Fashion", "Home", "Imports", "Electronics"];

  return (
    <div className={`w-[390px] h-[844px] relative overflow-hidden font-sans select-none flex flex-col ${isDark ? 'bg-[#050505] text-white' : 'bg-[#fbeed3] text-stone-900'}`}>
      {/* Header */}
      <div className={`pt-12 pb-4 px-4 z-10 ${isDark ? 'bg-gradient-to-b from-[#000000] to-transparent' : 'bg-gradient-to-b from-white to-transparent'}`}>
        <div className="flex items-center gap-3 mb-4">
          <div className="relative flex-1">
            <Search className={`absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 ${isDark ? 'text-white/50' : 'text-stone-400'}`} />
            <Input 
              placeholder="Search Lagos Night Market..." 
              className={`pl-10 h-10 rounded-full text-sm ${isDark ? 'bg-white/5 border-white/10 focus-visible:ring-[#ff00ff] placeholder:text-white/40' : 'bg-stone-300/35 border-stone-400/55 focus-visible:ring-[#d900d9] placeholder:text-stone-400 text-stone-900'}`}
            />
          </div>
          <button 
            onClick={() => setTheme(isDark ? "light" : "dark")}
            className={`h-10 w-10 rounded-full flex items-center justify-center border transition-colors ${isDark ? 'bg-white/5 border-white/10 hover:bg-white/10 text-white' : 'bg-stone-300/35 border-stone-400/55 hover:bg-stone-300/55 text-stone-900'}`}
          >
            {isDark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
          </button>
        </div>
        
        {/* Category Chips */}
        <div className={`flex gap-2 overflow-x-auto no-scrollbar pb-2 ${isDark ? 'mask-image-to-right' : ''}`}>
          {categories.map((cat, i) => (
            <button 
              key={cat}
              className={`whitespace-nowrap px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
                i === 0 
                  ? isDark 
                    ? "bg-[#00ffff] text-black shadow-[0_0_10px_rgba(0,255,255,0.3)]" 
                    : "bg-[#00b3b3] text-white shadow-sm"
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
      <div className="flex-1 overflow-y-auto px-2 pb-24 no-scrollbar">
        <div className="grid grid-cols-2 gap-2">
          
          {/* Live Tile 1 */}
          <div className="relative rounded-xl overflow-hidden aspect-[3/4] group">
            <img src="/__mockup/images/lagos-host-stream.png" className="w-full h-full object-cover" alt="Stream" />
            <div className={`absolute inset-0 bg-gradient-to-t ${isDark ? 'from-black/80 via-transparent to-black/20' : 'from-black/70 via-transparent to-black/10'}`}></div>
            <div className={`absolute top-2 left-2 text-white text-[10px] font-black px-2 py-0.5 rounded flex items-center gap-1 ${isDark ? 'bg-[#ff00ff] shadow-[0_0_10px_rgba(255,0,255,0.6)] animate-pulse' : 'bg-[#d900d9] shadow-sm animate-pulse'}`}>
              <span className="w-1.5 h-1.5 rounded-full bg-white"></span>
              LIVE
            </div>
            <div className="absolute top-2 right-2 bg-black/50 backdrop-blur text-white text-[10px] font-bold px-1.5 py-0.5 rounded">
              2.4K
            </div>
            <div className="absolute bottom-2 left-2 right-2">
              <p className="text-xs font-bold leading-tight mb-1 text-white line-clamp-2">Naija Beauty Haul! Glow up szn ✨</p>
              <div className="flex items-center gap-1">
                <img src="/__mockup/images/lagos-avatar-2.png" className={`w-4 h-4 rounded-full border ${isDark ? 'border-[#00ffff]' : 'border-[#00b3b3]'}`} alt="Host" />
                <span className="text-[10px] text-white/90">Ada Beauty</span>
              </div>
            </div>
          </div>

          {/* Product Tile 1 */}
          <div className={`relative rounded-xl overflow-hidden aspect-[3/4] ${isDark ? 'bg-[#111]' : 'bg-[#fbeed3] border border-stone-400/35'}`}>
            <img src="/__mockup/images/lagos-product-serum.png" className="w-full h-full object-cover opacity-90" alt="Product" />
            <div className={`absolute inset-0 bg-gradient-to-t ${isDark ? 'from-black/80' : 'from-black/60'} via-transparent to-transparent`}></div>
            <div className="absolute bottom-2 left-2 right-2">
              <p className="text-xs font-medium leading-tight text-white/90 line-clamp-1 mb-1">Tokyo Glass Skin Serum</p>
              <p className={`text-sm font-black ${isDark ? 'text-[#00ffff]' : 'text-[#00ffff]'}`}>₦18,500</p>
            </div>
          </div>

          {/* Product Tile 2 */}
          <div className={`relative rounded-xl overflow-hidden aspect-[3/4] ${isDark ? 'bg-[#111]' : 'bg-[#fbeed3] border border-stone-400/35'}`}>
            <img src="/__mockup/images/lagos-feed-1.png" className="w-full h-full object-cover" alt="Product" />
            <div className={`absolute inset-0 bg-gradient-to-t ${isDark ? 'from-black/80' : 'from-black/60'} via-transparent to-transparent`}></div>
            <div className="absolute bottom-2 left-2 right-2">
              <p className="text-xs font-medium leading-tight text-white/90 line-clamp-1 mb-1">AirMax Imports Direct</p>
              <p className={`text-sm font-black ${isDark ? 'text-[#00ffff]' : 'text-[#00ffff]'}`}>₦45,000</p>
            </div>
          </div>

          {/* Live Tile 2 */}
          <div className="relative rounded-xl overflow-hidden aspect-[3/4] group">
            <img src="/__mockup/images/lagos-feed-2.png" className="w-full h-full object-cover" alt="Stream" />
            <div className={`absolute inset-0 bg-gradient-to-t ${isDark ? 'from-black/80 via-transparent to-black/20' : 'from-black/70 via-transparent to-black/10'}`}></div>
            <div className={`absolute top-2 left-2 text-white text-[10px] font-black px-2 py-0.5 rounded flex items-center gap-1 ${isDark ? 'bg-[#ff00ff] shadow-[0_0_10px_rgba(255,0,255,0.6)]' : 'bg-[#d900d9] shadow-sm'}`}>
              <span className="w-1.5 h-1.5 rounded-full bg-white"></span>
              LIVE
            </div>
            <div className="absolute top-2 right-2 bg-black/50 backdrop-blur text-white text-[10px] font-bold px-1.5 py-0.5 rounded">
              856
            </div>
            <div className="absolute bottom-2 left-2 right-2">
              <p className="text-xs font-bold leading-tight mb-1 text-white line-clamp-2">Shenzhen tech drops 🔥</p>
              <div className="flex items-center gap-1">
                <img src="/__mockup/images/lagos-avatar-1.png" className={`w-4 h-4 rounded-full border ${isDark ? 'border-[#ff00ff]' : 'border-[#d900d9]'}`} alt="Host" />
                <span className="text-[10px] text-white/90">TechBoy</span>
              </div>
            </div>
          </div>

          {/* Product Tile 3 */}
          <div className={`relative rounded-xl overflow-hidden aspect-[3/4] ${isDark ? 'bg-[#111]' : 'bg-[#fbeed3] border border-stone-400/35'}`}>
            <img src="/__mockup/images/lagos-product-carousel-1.png" className="w-full h-full object-cover opacity-90" alt="Product" />
            <div className={`absolute inset-0 bg-gradient-to-t ${isDark ? 'from-black/80' : 'from-black/60'} via-transparent to-transparent`}></div>
            <div className="absolute bottom-2 left-2 right-2">
              <p className="text-xs font-medium leading-tight text-white/90 line-clamp-1 mb-1">Ankara Two-Piece</p>
              <p className={`text-sm font-black ${isDark ? 'text-[#00ffff]' : 'text-[#00ffff]'}`}>₦22,000</p>
            </div>
          </div>

        </div>
      </div>

      {/* Bottom Nav */}
      <div className={`absolute bottom-0 left-0 right-0 h-20 backdrop-blur-xl border-t flex items-center justify-around px-2 pb-4 z-20 ${isDark ? 'bg-[#0a0a0a]/90 border-white/5' : 'bg-[#fff5d8]/92 border-stone-400/55'}`}>
        <button className={`flex flex-col items-center gap-1 w-16 ${isDark ? 'text-white/50 hover:text-white' : 'text-stone-500 hover:text-stone-900'}`}>
          <Home className="h-6 w-6" />
          <span className="text-[10px] font-medium">Home</span>
        </button>
        <button className={`flex flex-col items-center gap-1 w-16 ${isDark ? 'text-[#00ffff]' : 'text-[#00b3b3]'}`}>
          <Compass className="h-6 w-6" />
          <span className="text-[10px] font-medium">Discover</span>
        </button>
        
        <div className="relative -top-5">
          <button className={`h-14 w-14 rounded-full p-[2px] ${isDark ? 'bg-gradient-to-tr from-[#ff00ff] to-[#00ffff] shadow-[0_0_20px_rgba(255,0,255,0.4)]' : 'bg-gradient-to-tr from-[#d900d9] to-[#00b3b3] shadow-md'}`}>
            <div className={`h-full w-full rounded-full flex items-center justify-center ${isDark ? 'bg-black' : 'bg-white'}`}>
              <Plus className={`h-6 w-6 ${isDark ? 'text-white' : 'text-stone-900'}`} />
            </div>
          </button>
        </div>

        <button className={`flex flex-col items-center gap-1 w-16 relative ${isDark ? 'text-white/50 hover:text-white' : 'text-stone-500 hover:text-stone-900'}`}>
          <MessageSquare className="h-6 w-6" />
          <span className={`absolute top-0 right-3 w-2 h-2 rounded-full ${isDark ? 'bg-[#ff00ff]' : 'bg-[#d900d9]'}`}></span>
          <span className="text-[10px] font-medium">Inbox</span>
        </button>
        <button className={`flex flex-col items-center gap-1 w-16 ${isDark ? 'text-white/50 hover:text-white' : 'text-stone-500 hover:text-stone-900'}`}>
          <User className="h-6 w-6" />
          <span className="text-[10px] font-medium">Profile</span>
        </button>
      </div>

    </div>
  );
}
