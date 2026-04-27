import React from "react";
import "./_group.css";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Heart, MessageCircle, Share2, Gift, X, ChevronRight, ShoppingBag } from "lucide-react";

export function LiveShopping() {
  return (
    <div className="editorial-theme w-[390px] h-[844px] bg-background overflow-hidden relative font-sans text-foreground flex flex-col">
      {/* Header Chrome */}
      <div className="absolute top-0 left-0 right-0 z-50 p-6 pt-12 flex justify-between items-start bg-gradient-to-b from-black/40 to-transparent text-white">
        <div className="flex items-center gap-3">
          <Avatar className="w-10 h-10 border border-white/20">
            <AvatarImage src="/__mockup/images/editorial-avatar-1.png" />
            <AvatarFallback>AD</AvatarFallback>
          </Avatar>
          <div className="flex flex-col">
            <span className="font-serif font-medium text-sm tracking-wide">Studio Ada</span>
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-widest flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                Live
              </span>
              <span className="text-[10px] opacity-80">2.4K</span>
            </div>
          </div>
        </div>
        <Button variant="ghost" size="icon" className="text-white hover:bg-white/10 rounded-none">
          <X className="w-5 h-5" />
        </Button>
      </div>

      {/* Main Video Area */}
      <div className="absolute inset-0 z-0">
        <img 
          src="/__mockup/images/editorial-host-live.png" 
          className="w-full h-full object-cover"
          alt="Live stream host"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
      </div>

      {/* Bottom Content Area */}
      <div className="absolute bottom-0 left-0 right-0 z-20 p-6 flex flex-col gap-6">
        
        {/* Pinned Product */}
        <div className="bg-white/95 backdrop-blur-md p-3 rounded-none border border-white/20 flex gap-4 items-center shadow-2xl">
          <div className="w-16 h-16 bg-muted shrink-0 relative overflow-hidden">
            <img src="/__mockup/images/editorial-product-skincare.png" className="w-full h-full object-cover" alt="Product" />
          </div>
          <div className="flex-1 flex flex-col justify-center">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Featured</span>
            <h3 className="font-serif text-sm leading-tight line-clamp-1">Kyoto Glass-Skin Serum</h3>
            <span className="font-sans font-medium text-sm mt-1">₦42,500</span>
          </div>
          <Button size="icon" className="rounded-none w-10 h-10 bg-primary text-primary-foreground shrink-0">
            <ShoppingBag className="w-4 h-4" />
          </Button>
        </div>

        {/* Chat & Actions Row */}
        <div className="flex items-end justify-between gap-4">
          {/* Chat Stream */}
          <div className="flex-1 h-48 overflow-hidden flex flex-col-reverse gap-3 text-sm text-white/90 font-sans mask-image-to-t">
            <div className="flex flex-col gap-0.5">
              <span className="font-medium text-white/70 text-xs">Chioma_Style</span>
              <p className="leading-snug">The texture looks incredible. Need.</p>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="font-medium text-white/70 text-xs">Femi_Design</span>
              <p className="leading-snug">Does it ship to Surulere tomorrow?</p>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="font-medium text-white/70 text-xs">Tunde_C</span>
              <p className="leading-snug">Just ordered two! Thanks Ada ✨</p>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="font-medium text-white/70 text-xs">Aisha_Beauty</span>
              <p className="leading-snug">How much for the blue one?</p>
            </div>
          </div>

          {/* Action Rail */}
          <div className="flex flex-col gap-4 shrink-0 items-center">
            <div className="flex flex-col items-center gap-1">
              <Button variant="ghost" size="icon" className="w-10 h-10 rounded-full bg-black/20 backdrop-blur-sm text-white border border-white/10 hover:bg-white/20">
                <Heart className="w-5 h-5" />
              </Button>
              <span className="text-[10px] text-white/80 font-medium">12K</span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <Button variant="ghost" size="icon" className="w-10 h-10 rounded-full bg-black/20 backdrop-blur-sm text-white border border-white/10 hover:bg-white/20">
                <MessageCircle className="w-5 h-5" />
              </Button>
              <span className="text-[10px] text-white/80 font-medium">1.2K</span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <Button variant="ghost" size="icon" className="w-10 h-10 rounded-full bg-black/20 backdrop-blur-sm text-white border border-white/10 hover:bg-white/20">
                <Share2 className="w-5 h-5" />
              </Button>
              <span className="text-[10px] text-white/80 font-medium">Share</span>
            </div>
          </div>
        </div>

        {/* Input Bar */}
        <div className="flex gap-3 items-center">
          <div className="flex-1 h-10 rounded-full bg-black/20 backdrop-blur-sm border border-white/20 px-4 flex items-center">
            <span className="text-white/60 text-sm">Add a comment...</span>
          </div>
          <Button variant="ghost" size="icon" className="w-10 h-10 rounded-full bg-primary text-primary-foreground border-none">
            <Gift className="w-4 h-4" />
          </Button>
        </div>

      </div>
    </div>
  );
}
