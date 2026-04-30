import React from "react";
import { Search, Home, Compass, PlusSquare, Inbox, User, Play, Video, Flame, Star } from "lucide-react";

export function Discovery() {
  return (
    <div className="flex justify-center items-center min-h-screen bg-gray-100 font-['Plus_Jakarta_Sans']">
      <div className="relative w-[390px] h-[844px] bg-[#FAFAFA] overflow-hidden shadow-2xl flex flex-col">
        {/* Top Header */}
        <div className="bg-white px-4 pt-12 pb-3 shadow-sm z-10 sticky top-0 border-b-4 border-[#00E5FF]">
          <div className="flex justify-between items-center mb-4">
            <h1 className="text-2xl font-black font-['Space_Grotesk'] tracking-tighter uppercase italic text-black">
              Epplaa
            </h1>
            <div className="w-10 h-10 bg-[#FFCC00] rounded-full flex items-center justify-center border-2 border-black shadow-[2px_2px_0px_#000]">
              <Search size={20} className="text-black" strokeWidth={3} />
            </div>
          </div>
          
          {/* Categories */}
          <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-hide no-scrollbar -mx-4 px-4">
            <button className="bg-black text-white px-5 py-2 rounded-full font-bold text-sm whitespace-nowrap shadow-[2px_2px_0px_#FF3366]">All</button>
            <button className="bg-white border-2 border-black text-black px-5 py-2 rounded-full font-bold text-sm whitespace-nowrap shadow-[2px_2px_0px_#000] hover:bg-gray-50">Fashion</button>
            <button className="bg-white border-2 border-black text-black px-5 py-2 rounded-full font-bold text-sm whitespace-nowrap shadow-[2px_2px_0px_#000] hover:bg-gray-50">Beauty</button>
            <button className="bg-white border-2 border-black text-black px-5 py-2 rounded-full font-bold text-sm whitespace-nowrap shadow-[2px_2px_0px_#000] hover:bg-gray-50">Phones</button>
            <button className="bg-white border-2 border-black text-black px-5 py-2 rounded-full font-bold text-sm whitespace-nowrap shadow-[2px_2px_0px_#000] hover:bg-gray-50">Imports</button>
          </div>
        </div>

        {/* Feed Content */}
        <div className="flex-1 overflow-y-auto p-3 pb-24 grid grid-cols-2 gap-3">
          
          {/* Live Tile 1 */}
          <div className="relative rounded-2xl overflow-hidden aspect-[3/4] bg-zinc-800 border-2 border-black shadow-[4px_4px_0px_#FF3366] group">
            <img src="/__mockup/images/naija-pop-host.png" className="w-full h-full object-cover" alt="Live stream" />
            <div className="absolute top-2 left-2 flex items-center gap-1 bg-[#FF3366] text-white px-2 py-0.5 rounded-sm border border-black">
              <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />
              <span className="text-[10px] font-bold uppercase tracking-wider">Live</span>
            </div>
            <div className="absolute top-2 right-2 bg-black/60 backdrop-blur-md px-1.5 py-0.5 rounded text-white text-[10px] font-bold border border-white/20">
              2.4K
            </div>
            <div className="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/90 to-transparent">
              <p className="text-white text-xs font-bold line-clamp-2 leading-tight">Ankara Two-Piece Promo! Live from Balogun</p>
              <div className="flex items-center gap-1 mt-1">
                <img src="/__mockup/images/naija-pop-avatar.png" className="w-4 h-4 rounded-full border border-white" alt="Avatar" />
                <span className="text-white/80 text-[10px]">Chioma Style</span>
              </div>
            </div>
          </div>

          {/* Short Video Tile 1 */}
          <div className="relative rounded-2xl overflow-hidden aspect-[3/4] bg-zinc-800 border-2 border-black shadow-[4px_4px_0px_#00E5FF] group">
            <img src="/__mockup/images/naija-pop-feed-1.png" className="w-full h-full object-cover" alt="Product" />
            <div className="absolute top-2 right-2 bg-black/60 backdrop-blur-md w-6 h-6 rounded-full flex items-center justify-center border border-white/20">
              <Video size={12} className="text-white" />
            </div>
            <div className="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/90 to-transparent">
              <p className="text-white text-xs font-bold line-clamp-1">Clear cases from Shenzhen</p>
              <div className="mt-1 inline-block bg-[#00E5FF] text-black px-1.5 py-0.5 rounded text-[10px] font-bold border border-black">
                ₦2,500
              </div>
            </div>
          </div>

          {/* Short Video Tile 2 */}
          <div className="relative rounded-2xl overflow-hidden aspect-[3/4] bg-zinc-800 border-2 border-black shadow-[4px_4px_0px_#FFCC00] group">
            <img src="/__mockup/images/naija-pop-feed-2.png" className="w-full h-full object-cover" alt="Product" />
            <div className="absolute top-2 right-2 bg-black/60 backdrop-blur-md w-6 h-6 rounded-full flex items-center justify-center border border-white/20">
              <Video size={12} className="text-white" />
            </div>
            <div className="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/90 to-transparent">
              <p className="text-white text-xs font-bold line-clamp-1">Korean Glass Skin Gloss</p>
              <div className="mt-1 inline-block bg-[#FFCC00] text-black px-1.5 py-0.5 rounded text-[10px] font-bold border border-black">
                ₦8,000
              </div>
            </div>
          </div>

          {/* Live Tile 2 */}
          <div className="relative rounded-2xl overflow-hidden aspect-[3/4] bg-zinc-800 border-2 border-black shadow-[4px_4px_0px_#FF3366] group">
            <img src="/__mockup/images/naija-pop-feed-3.png" className="w-full h-full object-cover" alt="Live stream" />
            <div className="absolute top-2 left-2 flex items-center gap-1 bg-[#FF3366] text-white px-2 py-0.5 rounded-sm border border-black">
              <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />
              <span className="text-[10px] font-bold uppercase tracking-wider">Live</span>
            </div>
            <div className="absolute top-2 right-2 bg-black/60 backdrop-blur-md px-1.5 py-0.5 rounded text-white text-[10px] font-bold border border-white/20">
              850
            </div>
            <div className="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/90 to-transparent">
              <p className="text-white text-xs font-bold line-clamp-2 leading-tight">Sneaker Drop! Size 42-45 available</p>
              <div className="flex items-center gap-1 mt-1">
                <div className="w-4 h-4 rounded-full bg-blue-500 border border-white flex items-center justify-center text-[8px] text-white">JB</div>
                <span className="text-white/80 text-[10px]">Jide Kicks</span>
              </div>
            </div>
          </div>

          {/* More Short Video */}
          <div className="relative rounded-2xl overflow-hidden aspect-[3/4] bg-zinc-800 border-2 border-black shadow-[4px_4px_0px_#00E5FF] group">
            <img src="/__mockup/images/naija-pop-product-earbuds.png" className="w-full h-full object-cover" alt="Product" />
            <div className="absolute top-2 left-2 bg-[#FFCC00] text-black px-1.5 py-0.5 rounded text-[10px] font-bold border border-black shadow-sm flex items-center gap-1">
              <Flame size={10} fill="currentColor" /> Trending
            </div>
            <div className="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/90 to-transparent">
              <p className="text-white text-xs font-bold line-clamp-1">Wireless Pods Pro</p>
              <div className="mt-1 inline-block bg-[#00E5FF] text-black px-1.5 py-0.5 rounded text-[10px] font-bold border border-black">
                ₦12,500
              </div>
            </div>
          </div>

        </div>

        {/* Bottom Nav */}
        <div className="absolute bottom-0 left-0 right-0 bg-white border-t-2 border-black px-6 py-2 pb-6 flex justify-between items-center z-50">
          <button className="flex flex-col items-center gap-1 text-black">
            <Home size={24} strokeWidth={2.5} />
            <span className="text-[10px] font-bold">Home</span>
          </button>
          <button className="flex flex-col items-center gap-1 text-gray-400">
            <Compass size={24} strokeWidth={2.5} />
            <span className="text-[10px] font-bold">Discover</span>
          </button>
          
          <div className="relative -top-5">
            <button className="w-14 h-14 rounded-full bg-[#FF3366] text-white flex items-center justify-center shadow-[4px_4px_0px_#000] border-2 border-black hover:translate-y-1 hover:shadow-[2px_2px_0px_#000] transition-all">
              <PlusSquare size={28} strokeWidth={2.5} />
            </button>
          </div>

          <button className="flex flex-col items-center gap-1 text-gray-400 relative">
            <Inbox size={24} strokeWidth={2.5} />
            <span className="absolute -top-1 -right-1 w-4 h-4 bg-[#FF3366] text-white text-[9px] font-bold rounded-full flex items-center justify-center border border-white">3</span>
            <span className="text-[10px] font-bold">Inbox</span>
          </button>
          <button className="flex flex-col items-center gap-1 text-gray-400">
            <User size={24} strokeWidth={2.5} />
            <span className="text-[10px] font-bold">Profile</span>
          </button>
        </div>

      </div>
    </div>
  );
}
