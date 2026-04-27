import React, { useState } from "react";
import { Heart, MessageCircle, Share2, Gift, X, MoreVertical, Plus, Zap, Eye } from "lucide-react";

export function LiveShopping() {
  const [likes, setLikes] = useState(1245);
  const [isFollowing, setIsFollowing] = useState(false);

  return (
    <div className="flex justify-center items-center min-h-screen bg-black font-['Plus_Jakarta_Sans']">
      <div className="relative w-[390px] h-[844px] bg-zinc-900 overflow-hidden shadow-2xl">
        {/* Background Video Layer */}
        <div className="absolute inset-0 w-full h-full">
          <img 
            src="/__mockup/images/naija-pop-host.png" 
            alt="Live Stream Host" 
            className="w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-black/40"></div>
        </div>

        {/* Top Bar */}
        <div className="absolute top-12 left-4 right-4 flex justify-between items-start z-10">
          <div className="flex gap-2 items-center">
            <div className="bg-black/40 backdrop-blur-md rounded-full p-1 pr-3 flex items-center gap-2 border border-white/10">
              <div className="relative">
                <img src="/__mockup/images/naija-pop-avatar.png" alt="Host Avatar" className="w-10 h-10 rounded-full object-cover border-2 border-[#FF3366]" />
                <div className="absolute -bottom-1 -right-1 bg-[#FF3366] text-white text-[9px] font-bold px-1 rounded-sm uppercase tracking-wider">LIVE</div>
              </div>
              <div className="flex flex-col">
                <span className="text-white text-sm font-bold leading-tight">Chioma Style</span>
                <span className="text-white/80 text-[10px]">Lagos, NG</span>
              </div>
              {!isFollowing && (
                <button 
                  onClick={() => setIsFollowing(true)}
                  className="ml-2 bg-[#FF3366] hover:bg-[#FF3366]/90 text-white w-7 h-7 rounded-full flex items-center justify-center transition-transform active:scale-95"
                >
                  <Plus size={16} strokeWidth={3} />
                </button>
              )}
            </div>
            <div className="bg-black/40 backdrop-blur-md rounded-full px-3 py-1.5 flex items-center gap-1.5 border border-white/10">
              <Eye size={12} className="text-white/80" />
              <span className="text-white text-xs font-bold font-mono">2.4K</span>
            </div>
          </div>
          <div className="flex gap-2">
            <button className="w-10 h-10 rounded-full bg-black/40 backdrop-blur-md flex items-center justify-center text-white border border-white/10">
              <MoreVertical size={20} />
            </button>
            <button className="w-10 h-10 rounded-full bg-black/40 backdrop-blur-md flex items-center justify-center text-white border border-white/10">
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Floating Hearts Animation Area */}
        <div className="absolute bottom-32 right-4 w-16 h-64 pointer-events-none overflow-hidden">
          {/* Decorative floating elements would go here in a real app */}
        </div>

        {/* Live Chat */}
        <div className="absolute bottom-36 left-4 right-20 h-48 overflow-hidden z-10 flex flex-col justify-end">
          <div className="flex flex-col gap-3 pb-2">
            <div className="bg-black/30 backdrop-blur-sm rounded-xl p-2 inline-block max-w-[85%]">
              <span className="text-[#00E5FF] font-bold text-xs mr-2">Tunde B.</span>
              <span className="text-white text-sm">How much for the blue one?</span>
            </div>
            <div className="bg-black/30 backdrop-blur-sm rounded-xl p-2 inline-block max-w-[85%]">
              <span className="text-[#FFCC00] font-bold text-xs mr-2">Adaeze_Shop</span>
              <span className="text-white text-sm">I want to buy 2. Can you ship to Surulere today?</span>
            </div>
            <div className="bg-black/30 backdrop-blur-sm rounded-xl p-2 inline-block max-w-[85%]">
              <span className="text-[#FF3366] font-bold text-xs mr-2">Bisi4Real</span>
              <span className="text-white text-sm">Na which size you wear? The fit is too mad!</span>
            </div>
            <div className="bg-black/30 backdrop-blur-sm rounded-xl p-2 inline-block max-w-[85%]">
              <span className="text-[#00E5FF] font-bold text-xs mr-2">Emeka</span>
              <span className="text-white text-sm">Abeg show the back again</span>
            </div>
          </div>
        </div>

        {/* Pinned Product Card */}
        <div className="absolute top-28 left-4 right-4 z-10">
          <div className="bg-white p-2 rounded-2xl flex gap-3 shadow-xl transform rotate-[-1deg] border-2 border-black">
            <img src="/__mockup/images/naija-pop-product-fashion.png" alt="Ankara Two Piece" className="w-16 h-16 rounded-xl object-cover bg-gray-100" />
            <div className="flex-1 flex flex-col justify-between py-0.5">
              <div>
                <h3 className="font-bold text-black leading-tight text-sm line-clamp-2 font-['Space_Grotesk']">Ankara Two-Piece Set (Owanbe Ready)</h3>
              </div>
              <div className="flex justify-between items-center mt-1">
                <span className="font-bold text-[#FF3366] font-mono tracking-tight">₦18,500</span>
                <button className="bg-black text-white text-xs font-bold px-3 py-1.5 rounded-lg uppercase">Buy</button>
              </div>
            </div>
            <div className="absolute -top-3 -right-2 bg-[#FFCC00] text-black text-[10px] font-bold px-2 py-1 rounded-full transform rotate-[5deg] border border-black shadow-sm">
              SELLING FAST
            </div>
          </div>
        </div>

        {/* Action Rail */}
        <div className="absolute bottom-28 right-4 flex flex-col gap-4 z-10">
          <button className="flex flex-col items-center gap-1">
            <div className="w-12 h-12 rounded-full bg-black/40 backdrop-blur-md flex items-center justify-center text-white border border-white/10 relative overflow-hidden">
              <img src="/__mockup/images/naija-pop-product-serum.png" alt="Shop" className="w-full h-full object-cover opacity-80" />
              <div className="absolute inset-0 bg-black/20 flex items-center justify-center">
                <span className="font-bold text-xs">Shop</span>
              </div>
              <div className="absolute -top-1 -right-1 bg-[#FF3366] text-white text-[10px] font-bold w-5 h-5 rounded-full flex items-center justify-center border border-black">
                4
              </div>
            </div>
          </button>
          
          <button className="flex flex-col items-center gap-1" onClick={() => setLikes(l => l + 1)}>
            <div className="w-12 h-12 rounded-full bg-black/40 backdrop-blur-md flex items-center justify-center text-white border border-white/10 hover:scale-110 transition-transform">
              <Heart size={24} className={likes > 1245 ? "fill-[#FF3366] text-[#FF3366]" : ""} />
            </div>
            <span className="text-white text-xs font-bold drop-shadow-md">{likes}</span>
          </button>
          
          <button className="flex flex-col items-center gap-1">
            <div className="w-12 h-12 rounded-full bg-black/40 backdrop-blur-md flex items-center justify-center text-white border border-white/10">
              <MessageCircle size={24} />
            </div>
            <span className="text-white text-xs font-bold drop-shadow-md">128</span>
          </button>
          
          <button className="flex flex-col items-center gap-1">
            <div className="w-12 h-12 rounded-full bg-black/40 backdrop-blur-md flex items-center justify-center text-white border border-white/10">
              <Share2 size={24} />
            </div>
            <span className="text-white text-xs font-bold drop-shadow-md">Share</span>
          </button>

          <button className="flex flex-col items-center gap-1 mt-2">
            <div className="w-12 h-12 rounded-full bg-gradient-to-br from-[#FFCC00] to-[#FF9900] flex items-center justify-center text-black border-2 border-white shadow-[0_0_15px_rgba(255,204,0,0.5)]">
              <Gift size={24} fill="currentColor" />
            </div>
          </button>
        </div>

        {/* Bottom Input Area */}
        <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/80 to-transparent z-10 pb-8">
          <div className="flex gap-3 items-center">
            <div className="flex-1 bg-black/40 backdrop-blur-md border border-white/20 rounded-full h-12 flex items-center px-4 text-white/60">
              <span className="text-sm">Say something nice...</span>
            </div>
            <button className="w-12 h-12 rounded-full bg-[#00E5FF] flex items-center justify-center text-black shadow-[4px_4px_0px_#000]">
              <Zap size={20} fill="currentColor" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
