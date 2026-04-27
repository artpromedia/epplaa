import React from "react";
import { Heart, MessageCircle, Share2, Gift, X, ChevronRight, Plus } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";

export default function LiveShopping() {
  return (
    <div className="w-[390px] h-[844px] bg-[#050505] text-white relative overflow-hidden font-sans select-none">
      {/* Video Background */}
      <div className="absolute inset-0">
        <img 
          src="/__mockup/images/lagos-host-stream.png" 
          alt="Live stream" 
          className="w-full h-full object-cover opacity-90"
        />
        {/* Gradient overlays for readability */}
        <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-transparent to-black/90"></div>
      </div>

      {/* Top Header */}
      <div className="absolute top-12 left-4 right-4 flex items-center justify-between z-10">
        <div className="flex items-center bg-black/40 backdrop-blur-md rounded-full p-1 pr-3 border border-white/10">
          <Avatar className="h-8 w-8 border border-[#ff00ff]">
            <AvatarImage src="/__mockup/images/lagos-avatar-2.png" />
            <AvatarFallback>AD</AvatarFallback>
          </Avatar>
          <div className="ml-2 flex flex-col">
            <span className="text-xs font-bold leading-tight">Ada Beauty</span>
            <span className="text-[10px] text-white/70 leading-tight">2.4K watching</span>
          </div>
          <Button size="sm" className="ml-3 h-6 rounded-full bg-[#00ffff] text-black hover:bg-[#00cccc] text-xs px-3 font-bold">
            Follow
          </Button>
        </div>
        
        <div className="flex gap-2">
          <div className="bg-black/40 backdrop-blur-md h-10 w-10 rounded-full flex items-center justify-center border border-white/10">
            <span className="text-xs font-bold text-[#ff00ff]">LIVE</span>
          </div>
          <div className="bg-black/40 backdrop-blur-md h-10 w-10 rounded-full flex items-center justify-center border border-white/10">
            <X className="h-5 w-5" />
          </div>
        </div>
      </div>

      {/* Main Content Area (Bottom aligned) */}
      <div className="absolute bottom-0 left-0 right-0 p-4 pb-8 flex flex-col justify-end z-10">
        
        {/* Chat Area */}
        <div className="w-[70%] h-48 overflow-y-auto flex flex-col justify-end space-y-3 mb-4 mask-image-to-top">
          <div className="flex items-start gap-2">
            <Avatar className="h-6 w-6 border border-white/20">
              <AvatarImage src="/__mockup/images/lagos-avatar-1.png" />
            </Avatar>
            <div className="bg-black/30 backdrop-blur-sm rounded-xl rounded-tl-none p-2 border border-white/5">
              <p className="text-[10px] text-white/50 font-bold mb-0.5">Tunde</p>
              <p className="text-xs">How much for the blue one?</p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Avatar className="h-6 w-6 border border-white/20">
              <AvatarFallback className="bg-[#ff00ff]/20 text-[#ff00ff] text-[10px]">C</AvatarFallback>
            </Avatar>
            <div className="bg-black/30 backdrop-blur-sm rounded-xl rounded-tl-none p-2 border border-white/5">
              <p className="text-[10px] text-[#00ffff] font-bold mb-0.5">Chioma_99</p>
              <p className="text-xs">Ship to Surulere?</p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Avatar className="h-6 w-6 border border-white/20">
              <AvatarFallback className="bg-[#00ffff]/20 text-[#00ffff] text-[10px]">F</AvatarFallback>
            </Avatar>
            <div className="bg-black/30 backdrop-blur-sm rounded-xl rounded-tl-none p-2 border border-white/5">
              <p className="text-[10px] text-white/50 font-bold mb-0.5">Femi</p>
              <p className="text-xs">Na which size you wear?</p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Avatar className="h-6 w-6 border border-white/20">
              <AvatarFallback className="bg-white/20 text-white text-[10px]">O</AvatarFallback>
            </Avatar>
            <div className="bg-black/30 backdrop-blur-sm rounded-xl rounded-tl-none p-2 border border-white/5">
              <p className="text-[10px] text-[#ff00ff] font-bold mb-0.5">Olu</p>
              <p className="text-xs">I need this sharp sharp</p>
            </div>
          </div>
        </div>

        <div className="flex gap-3 items-end">
          {/* Pinned Product Card */}
          <div className="flex-1 bg-black/60 backdrop-blur-xl border border-[#ff00ff]/30 rounded-2xl p-3 flex gap-3 shadow-[0_0_20px_rgba(255,0,255,0.15)] relative overflow-hidden">
            <div className="absolute top-0 right-0 w-16 h-16 bg-[#ff00ff]/20 blur-xl rounded-full"></div>
            <img src="/__mockup/images/lagos-product-serum.png" alt="Product" className="w-16 h-16 rounded-xl object-cover border border-white/10" />
            <div className="flex-1 flex flex-col justify-between">
              <div>
                <p className="text-xs font-bold leading-tight line-clamp-2">Korean glass-skin serum from Tokyo supplier</p>
                <p className="text-sm font-black text-[#00ffff] mt-1">₦18,500</p>
              </div>
              <Button size="sm" className="h-7 w-full mt-2 bg-[#ff00ff] hover:bg-[#cc00cc] text-white text-xs font-bold rounded-lg shadow-[0_0_10px_rgba(255,0,255,0.4)]">
                Buy now
              </Button>
            </div>
          </div>

          {/* Action Rail */}
          <div className="flex flex-col gap-4">
            <div className="flex flex-col items-center gap-1">
              <button className="h-12 w-12 rounded-full bg-black/40 backdrop-blur-md border border-white/10 flex items-center justify-center text-white hover:bg-white/20 hover:scale-110 transition-transform">
                <Heart className="h-6 w-6 text-[#ff00ff] fill-[#ff00ff]" />
              </button>
              <span className="text-[10px] font-bold">12.8K</span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <button className="h-12 w-12 rounded-full bg-black/40 backdrop-blur-md border border-white/10 flex items-center justify-center text-white hover:bg-white/20 hover:scale-110 transition-transform">
                <MessageCircle className="h-6 w-6" />
              </button>
              <span className="text-[10px] font-bold">452</span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <button className="h-12 w-12 rounded-full bg-black/40 backdrop-blur-md border border-white/10 flex items-center justify-center text-white hover:bg-white/20 hover:scale-110 transition-transform">
                <Share2 className="h-6 w-6" />
              </button>
              <span className="text-[10px] font-bold">Share</span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <button className="h-12 w-12 rounded-full bg-[#ff00ff]/20 backdrop-blur-md border border-[#ff00ff]/50 flex items-center justify-center text-[#ff00ff] hover:bg-[#ff00ff]/40 hover:scale-110 transition-transform shadow-[0_0_15px_rgba(255,0,255,0.3)]">
                <Gift className="h-6 w-6" />
              </button>
              <span className="text-[10px] font-bold text-[#ff00ff]">Gift</span>
            </div>
          </div>
        </div>

        {/* Comment Input */}
        <div className="mt-4 flex gap-2 items-center">
          <div className="flex-1 bg-black/40 backdrop-blur-md border border-white/10 rounded-full h-10 px-4 flex items-center">
            <span className="text-white/50 text-sm">Add a comment...</span>
          </div>
        </div>

      </div>
    </div>
  );
}
