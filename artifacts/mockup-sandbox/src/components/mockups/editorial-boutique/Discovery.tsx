import React from "react";
import "./_group.css";
import { Search, Home, Compass, Plus, Inbox, User, SlidersHorizontal, Play } from "lucide-react";
import { Button } from "@/components/ui/button";

export function Discovery() {
  return (
    <div className="editorial-theme w-[390px] h-[844px] bg-background overflow-hidden relative font-sans text-foreground flex flex-col">
      {/* Header */}
      <div className="pt-12 pb-4 px-6 bg-background/90 backdrop-blur-md sticky top-0 z-30 border-b border-border/50">
        <div className="flex items-center justify-between mb-6">
          <h1 className="font-serif text-2xl font-medium tracking-tight">Discover</h1>
          <Button variant="ghost" size="icon" className="rounded-none text-foreground">
            <Search className="w-5 h-5" />
          </Button>
        </div>
        
        {/* Categories */}
        <div className="flex gap-6 overflow-x-auto no-scrollbar mask-image-to-r pb-2">
          {["All", "Beauty", "Design", "Fashion", "Tech", "Home"].map((cat, i) => (
            <button key={cat} className={`text-sm tracking-wide whitespace-nowrap pb-1 ${i === 0 ? 'font-medium border-b border-foreground' : 'text-muted-foreground'}`}>
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Feed */}
      <div className="flex-1 overflow-y-auto px-6 pt-4 pb-24 no-scrollbar">
        <div className="grid grid-cols-2 gap-4">
          {/* Live Tile */}
          <div className="col-span-2 relative aspect-[4/5] bg-muted mb-2 overflow-hidden group cursor-pointer">
            <img src="/__mockup/images/editorial-host-live.png" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700" alt="Live stream" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
            <div className="absolute top-4 left-4">
              <span className="bg-red-500 text-white text-[9px] uppercase tracking-widest px-2 py-1 flex items-center gap-1.5 w-fit">
                <span className="w-1 h-1 rounded-full bg-white animate-pulse" />
                Live
              </span>
            </div>
            <div className="absolute bottom-4 left-4 right-4 text-white">
              <h3 className="font-serif text-lg leading-tight mb-1">Kyoto Beauty Curation</h3>
              <p className="text-xs text-white/80 font-sans tracking-wide">Studio Ada • 2.4K watching</p>
            </div>
          </div>

          {/* Grid Items */}
          <div className="relative aspect-[3/4] bg-muted overflow-hidden group cursor-pointer">
            <img src="/__mockup/images/editorial-feed-fashion.png" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700" alt="Fashion" />
            <div className="absolute top-3 right-3 w-6 h-6 rounded-full bg-black/20 backdrop-blur-md flex items-center justify-center text-white">
              <Play className="w-2.5 h-2.5 fill-current" />
            </div>
            <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />
            <div className="absolute bottom-3 left-3 text-white">
              <span className="text-xs font-medium">₦85,000</span>
            </div>
          </div>

          <div className="relative aspect-[3/4] bg-muted overflow-hidden group cursor-pointer">
            <img src="/__mockup/images/editorial-feed-tech.png" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700" alt="Tech" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />
            <div className="absolute bottom-3 left-3 text-white">
              <span className="text-xs font-medium">₦112,000</span>
            </div>
          </div>

          <div className="relative aspect-[3/4] bg-muted overflow-hidden group cursor-pointer">
            <img src="/__mockup/images/editorial-feed-home.png" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700" alt="Home" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />
            <div className="absolute bottom-3 left-3 text-white">
              <span className="text-xs font-medium">₦34,500</span>
            </div>
          </div>

          <div className="relative aspect-[3/4] bg-muted overflow-hidden group cursor-pointer">
            <img src="/__mockup/images/editorial-product-skincare.png" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700" alt="Skincare" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />
            <div className="absolute bottom-3 left-3 text-white">
              <span className="text-xs font-medium">₦42,500</span>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Nav */}
      <div className="absolute bottom-0 left-0 right-0 bg-background border-t border-border flex items-center justify-around px-6 py-4 pb-8 z-40">
        <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground">
          <Home className="w-5 h-5" />
        </Button>
        <Button variant="ghost" size="icon" className="text-foreground">
          <Compass className="w-5 h-5" />
        </Button>
        <Button variant="default" size="icon" className="w-12 h-12 rounded-none bg-primary text-primary-foreground shadow-lg -mt-6">
          <Plus className="w-5 h-5" />
        </Button>
        <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground relative">
          <Inbox className="w-5 h-5" />
          <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 bg-red-500 rounded-full" />
        </Button>
        <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground">
          <User className="w-5 h-5" />
        </Button>
      </div>
    </div>
  );
}
