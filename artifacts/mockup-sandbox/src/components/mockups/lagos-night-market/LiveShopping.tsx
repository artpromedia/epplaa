import React, { useState } from "react";
import { Heart, MessageCircle, Share2, Gift, X, Sun, Moon } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";

export default function LiveShopping() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const isDark = theme === "dark";

  return (
    <div className={`w-[390px] h-[844px] relative overflow-hidden font-sans select-none ${isDark ? 'bg-[#050505] text-white' : 'bg-[#fdfcf8] text-zinc-900'}`}>
      {/* Video Background */}
      <div className="absolute inset-0">
        <img 
          src="/__mockup/images/lagos-host-stream.png" 
          alt="Live stream" 
          className="w-full h-full object-cover opacity-90"
        />
        {/* Gradient overlays for readability */}
        <div className={`absolute inset-0 bg-gradient-to-b ${isDark ? 'from-black/60 via-transparent to-black/90' : 'from-white/60 via-transparent to-white/95'}`}></div>
      </div>

      {/* Top Header */}
      <div className="absolute top-12 left-4 right-4 flex items-center justify-between z-10">
        <div className={`flex items-center backdrop-blur-md rounded-full p-1 pr-3 border ${isDark ? 'bg-black/40 border-white/10' : 'bg-white/60 border-black/10'}`}>
          <Avatar className="h-8 w-8 border border-[#ff00ff]">
            <AvatarImage src="/__mockup/images/lagos-avatar-2.png" />
            <AvatarFallback>AD</AvatarFallback>
          </Avatar>
          <div className="ml-2 flex flex-col">
            <span className="text-xs font-bold leading-tight">Ada Beauty</span>
            <span className={`text-[10px] leading-tight ${isDark ? 'text-white/70' : 'text-zinc-700'}`}>2.4K watching</span>
          </div>
          <Button size="sm" className="ml-3 h-6 rounded-full bg-[#00ffff] text-black hover:bg-[#00cccc] text-xs px-3 font-bold">
            Follow
          </Button>
        </div>
        
        <div className="flex gap-2">
          <button 
            onClick={() => setTheme(isDark ? "light" : "dark")}
            className={`backdrop-blur-md h-10 w-10 rounded-full flex items-center justify-center border transition-colors ${isDark ? 'bg-black/40 border-white/10 hover:bg-white/20 text-white' : 'bg-white/60 border-black/10 hover:bg-black/10 text-zinc-900'}`}
          >
            {isDark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
          </button>
          <div className={`backdrop-blur-md h-10 w-10 rounded-full flex items-center justify-center border ${isDark ? 'bg-black/40 border-white/10' : 'bg-white/60 border-black/10'}`}>
            <span className={`text-xs font-bold ${isDark ? 'text-[#ff00ff]' : 'text-[#d900d9]'}`}>LIVE</span>
          </div>
          <div className={`backdrop-blur-md h-10 w-10 rounded-full flex items-center justify-center border ${isDark ? 'bg-black/40 border-white/10 text-white' : 'bg-white/60 border-black/10 text-zinc-900'}`}>
            <X className="h-5 w-5" />
          </div>
        </div>
      </div>

      {/* Main Content Area (Bottom aligned) */}
      <div className="absolute bottom-0 left-0 right-0 p-4 pb-8 flex flex-col justify-end z-10">
        
        {/* Chat Area */}
        <div className="w-[70%] h-48 overflow-y-auto flex flex-col justify-end space-y-3 mb-4 mask-image-to-top">
          <div className="flex items-start gap-2">
            <Avatar className={`h-6 w-6 border ${isDark ? 'border-white/20' : 'border-black/10'}`}>
              <AvatarImage src="/__mockup/images/lagos-avatar-1.png" />
            </Avatar>
            <div className={`backdrop-blur-sm rounded-xl rounded-tl-none p-2 border ${isDark ? 'bg-black/30 border-white/5' : 'bg-white/60 border-black/5'}`}>
              <p className={`text-[10px] font-bold mb-0.5 ${isDark ? 'text-white/50' : 'text-zinc-500'}`}>Tunde</p>
              <p className="text-xs">How much for the blue one?</p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Avatar className={`h-6 w-6 border ${isDark ? 'border-white/20' : 'border-black/10'}`}>
              <AvatarFallback className={`text-[10px] ${isDark ? 'bg-[#ff00ff]/20 text-[#ff00ff]' : 'bg-[#d900d9]/20 text-[#d900d9]'}`}>C</AvatarFallback>
            </Avatar>
            <div className={`backdrop-blur-sm rounded-xl rounded-tl-none p-2 border ${isDark ? 'bg-black/30 border-white/5' : 'bg-white/60 border-black/5'}`}>
              <p className={`text-[10px] font-bold mb-0.5 ${isDark ? 'text-[#00ffff]' : 'text-[#00b3b3]'}`}>Chioma_99</p>
              <p className="text-xs">Ship to Surulere?</p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Avatar className={`h-6 w-6 border ${isDark ? 'border-white/20' : 'border-black/10'}`}>
              <AvatarFallback className={`text-[10px] ${isDark ? 'bg-[#00ffff]/20 text-[#00ffff]' : 'bg-[#00b3b3]/20 text-[#00b3b3]'}`}>F</AvatarFallback>
            </Avatar>
            <div className={`backdrop-blur-sm rounded-xl rounded-tl-none p-2 border ${isDark ? 'bg-black/30 border-white/5' : 'bg-white/60 border-black/5'}`}>
              <p className={`text-[10px] font-bold mb-0.5 ${isDark ? 'text-white/50' : 'text-zinc-500'}`}>Femi</p>
              <p className="text-xs">Na which size you wear?</p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Avatar className={`h-6 w-6 border ${isDark ? 'border-white/20' : 'border-black/10'}`}>
              <AvatarFallback className={`text-[10px] ${isDark ? 'bg-white/20 text-white' : 'bg-black/10 text-zinc-900'}`}>O</AvatarFallback>
            </Avatar>
            <div className={`backdrop-blur-sm rounded-xl rounded-tl-none p-2 border ${isDark ? 'bg-black/30 border-white/5' : 'bg-white/60 border-black/5'}`}>
              <p className={`text-[10px] font-bold mb-0.5 ${isDark ? 'text-[#ff00ff]' : 'text-[#d900d9]'}`}>Olu</p>
              <p className="text-xs">I need this sharp sharp</p>
            </div>
          </div>
        </div>

        <div className="flex gap-3 items-end">
          {/* Pinned Product Card */}
          <div className={`flex-1 backdrop-blur-xl border rounded-2xl p-3 flex gap-3 relative overflow-hidden ${isDark ? 'bg-black/60 border-[#ff00ff]/30 shadow-[0_0_20px_rgba(255,0,255,0.15)]' : 'bg-white/80 border-[#d900d9]/30 shadow-md'}`}>
            <div className={`absolute top-0 right-0 w-16 h-16 blur-xl rounded-full ${isDark ? 'bg-[#ff00ff]/20' : 'bg-[#d900d9]/10'}`}></div>
            <img src="/__mockup/images/lagos-product-serum.png" alt="Product" className={`w-16 h-16 rounded-xl object-cover border ${isDark ? 'border-white/10' : 'border-black/5'}`} />
            <div className="flex-1 flex flex-col justify-between z-10">
              <div>
                <p className="text-xs font-bold leading-tight line-clamp-2">Korean glass-skin serum from Tokyo supplier</p>
                <p className={`text-sm font-black mt-1 ${isDark ? 'text-[#00ffff]' : 'text-[#00b3b3]'}`}>₦18,500</p>
              </div>
              <Button size="sm" className={`h-7 w-full mt-2 text-white text-xs font-bold rounded-lg ${isDark ? 'bg-[#ff00ff] hover:bg-[#cc00cc] shadow-[0_0_10px_rgba(255,0,255,0.4)]' : 'bg-[#d900d9] hover:bg-[#b300b3] shadow-[0_4px_10px_rgba(217,0,217,0.3)]'}`}>
                Buy now
              </Button>
            </div>
          </div>

          {/* Action Rail */}
          <div className="flex flex-col gap-4">
            <div className="flex flex-col items-center gap-1">
              <button className={`h-12 w-12 rounded-full backdrop-blur-md border flex items-center justify-center hover:scale-110 transition-transform ${isDark ? 'bg-black/40 border-white/10 text-white hover:bg-white/20' : 'bg-white/60 border-black/10 text-zinc-900 hover:bg-black/5'}`}>
                <Heart className={`h-6 w-6 ${isDark ? 'text-[#ff00ff] fill-[#ff00ff]' : 'text-[#d900d9] fill-[#d900d9]'}`} />
              </button>
              <span className={`text-[10px] font-bold ${isDark ? 'text-white' : 'text-zinc-800'}`}>12.8K</span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <button className={`h-12 w-12 rounded-full backdrop-blur-md border flex items-center justify-center hover:scale-110 transition-transform ${isDark ? 'bg-black/40 border-white/10 text-white hover:bg-white/20' : 'bg-white/60 border-black/10 text-zinc-900 hover:bg-black/5'}`}>
                <MessageCircle className="h-6 w-6" />
              </button>
              <span className={`text-[10px] font-bold ${isDark ? 'text-white' : 'text-zinc-800'}`}>452</span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <button className={`h-12 w-12 rounded-full backdrop-blur-md border flex items-center justify-center hover:scale-110 transition-transform ${isDark ? 'bg-black/40 border-white/10 text-white hover:bg-white/20' : 'bg-white/60 border-black/10 text-zinc-900 hover:bg-black/5'}`}>
                <Share2 className="h-6 w-6" />
              </button>
              <span className={`text-[10px] font-bold ${isDark ? 'text-white' : 'text-zinc-800'}`}>Share</span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <button className={`h-12 w-12 rounded-full backdrop-blur-md border flex items-center justify-center hover:scale-110 transition-transform ${isDark ? 'bg-[#ff00ff]/20 border-[#ff00ff]/50 text-[#ff00ff] hover:bg-[#ff00ff]/40 shadow-[0_0_15px_rgba(255,0,255,0.3)]' : 'bg-[#d900d9]/10 border-[#d900d9]/30 text-[#d900d9] hover:bg-[#d900d9]/20 shadow-sm'}`}>
                <Gift className="h-6 w-6" />
              </button>
              <span className={`text-[10px] font-bold ${isDark ? 'text-[#ff00ff]' : 'text-[#d900d9]'}`}>Gift</span>
            </div>
          </div>
        </div>

        {/* Comment Input */}
        <div className="mt-4 flex gap-2 items-center">
          <div className={`flex-1 backdrop-blur-md border rounded-full h-10 px-4 flex items-center ${isDark ? 'bg-black/40 border-white/10' : 'bg-white/60 border-black/10'}`}>
            <span className={`text-sm ${isDark ? 'text-white/50' : 'text-zinc-500'}`}>Add a comment...</span>
          </div>
        </div>

      </div>
    </div>
  );
}
