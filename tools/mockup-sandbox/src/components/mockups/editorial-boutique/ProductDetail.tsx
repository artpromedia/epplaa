import React from "react";
import "./_group.css";
import { ChevronLeft, Share, Heart, ArrowRight, Truck, Store, MapPin, ShieldCheck, CreditCard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

export function ProductDetail() {
  return (
    <div className="editorial-theme w-[390px] h-[844px] bg-background overflow-hidden relative font-sans text-foreground flex flex-col">
      {/* Header */}
      <div className="absolute top-0 left-0 right-0 z-30 p-6 pt-12 flex justify-between items-center text-foreground">
        <Button variant="ghost" size="icon" className="bg-white/80 backdrop-blur-md rounded-full w-10 h-10 hover:bg-white">
          <ChevronLeft className="w-5 h-5" />
        </Button>
        <div className="flex gap-3">
          <Button variant="ghost" size="icon" className="bg-white/80 backdrop-blur-md rounded-full w-10 h-10 hover:bg-white">
            <Share className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="icon" className="bg-white/80 backdrop-blur-md rounded-full w-10 h-10 hover:bg-white">
            <Heart className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pb-28 no-scrollbar">
        {/* Hero Image */}
        <div className="w-full aspect-[4/5] bg-muted relative">
          <img src="/__mockup/images/editorial-product-skincare.png" className="w-full h-full object-cover" alt="Product hero" />
          <div className="absolute bottom-4 right-4 bg-white/80 backdrop-blur-md text-[10px] tracking-widest uppercase px-3 py-1">
            1 / 4
          </div>
        </div>

        {/* Product Info */}
        <div className="p-6">
          <div className="flex items-center gap-2 mb-4">
            <Badge variant="outline" className="rounded-none text-[10px] uppercase tracking-widest border-border text-muted-foreground">Imported from Japan</Badge>
          </div>
          
          <h1 className="font-serif text-2xl leading-tight mb-4 text-foreground">Kyoto Glass-Skin Serum Extract</h1>
          
          <div className="flex items-baseline gap-3 mb-6">
            <span className="text-2xl font-medium tracking-tight">₦42,500</span>
            <span className="text-sm text-muted-foreground line-through">₦55,000</span>
          </div>

          <p className="text-sm text-muted-foreground leading-relaxed font-sans font-light mb-8">
            A deeply hydrating essence formulated in Tokyo. Enhances natural luminosity with marine botanicals and low-molecular hyaluronic acid. Perfect for adjusting to humid climates.
          </p>

          <Separator className="my-8 opacity-50" />

          {/* Seller Block */}
          <div className="flex items-center justify-between mb-8">
            <div className="flex items-center gap-4">
              <div className="relative">
                <Avatar className="w-12 h-12 border border-border">
                  <AvatarImage src="/__mockup/images/editorial-avatar-1.png" />
                  <AvatarFallback>AD</AvatarFallback>
                </Avatar>
                <div className="absolute -bottom-1 -right-1 bg-red-500 w-3 h-3 rounded-full border-2 border-background" />
              </div>
              <div className="flex flex-col">
                <span className="font-serif font-medium">Studio Ada</span>
                <span className="text-xs text-primary font-medium flex items-center gap-1 mt-0.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                  Live Now
                </span>
              </div>
            </div>
            <Button variant="outline" size="sm" className="rounded-none text-xs uppercase tracking-wider">Follow</Button>
          </div>

          {/* Variants */}
          <div className="mb-8">
            <h3 className="text-xs uppercase tracking-widest text-muted-foreground mb-3">Size</h3>
            <div className="flex gap-3">
              <button className="border border-foreground bg-foreground text-background px-4 py-2 text-sm font-medium">30ml</button>
              <button className="border border-border text-foreground px-4 py-2 text-sm font-medium hover:border-foreground transition-colors">50ml</button>
            </div>
          </div>

          <Separator className="my-8 opacity-50" />

          {/* Fulfillment */}
          <div className="mb-8">
            <h3 className="text-xs uppercase tracking-widest text-muted-foreground mb-4">Delivery Options</h3>
            <div className="flex flex-col gap-4">
              <div className="flex gap-4 items-start">
                <Store className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5" />
                <div className="flex-1">
                  <h4 className="text-sm font-medium">Epplaa Box</h4>
                  <p className="text-xs text-muted-foreground mt-1">Smart locker pickup in Lekki Phase 1 • Free</p>
                </div>
              </div>
              <div className="flex gap-4 items-start">
                <MapPin className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5" />
                <div className="flex-1">
                  <h4 className="text-sm font-medium">Partner Pickup</h4>
                  <p className="text-xs text-muted-foreground mt-1">Collect at nearby authorized stores • ₦500</p>
                </div>
              </div>
              <div className="flex gap-4 items-start">
                <Truck className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5" />
                <div className="flex-1">
                  <h4 className="text-sm font-medium">Home Delivery</h4>
                  <p className="text-xs text-muted-foreground mt-1">Via GIG / Kwik (2-3 days) • ₦2,500</p>
                </div>
              </div>
            </div>
          </div>

          <Separator className="my-8 opacity-50" />
          
          {/* Trust/Payments */}
          <div className="mb-4">
            <h3 className="text-xs uppercase tracking-widest text-muted-foreground mb-4">Payment Methods</h3>
            <div className="flex items-center gap-4 text-muted-foreground">
              <CreditCard className="w-6 h-6" />
              <ShieldCheck className="w-6 h-6" />
              <span className="text-xs font-medium">Paystack • Bank Transfer • USSD</span>
            </div>
          </div>

        </div>
      </div>

      {/* Sticky Bottom CTA */}
      <div className="absolute bottom-0 left-0 right-0 bg-background/90 backdrop-blur-lg border-t border-border p-4 pb-8 flex gap-3 z-40">
        <Button variant="outline" className="flex-1 rounded-none border-foreground text-foreground h-12 font-medium tracking-wide">
          Add to Cart
        </Button>
        <Button className="flex-1 rounded-none bg-primary text-primary-foreground h-12 font-medium tracking-wide">
          Buy Now
        </Button>
      </div>
    </div>
  );
}
