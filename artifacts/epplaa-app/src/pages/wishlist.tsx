import { Link } from "wouter";
import { Heart, ShoppingCart, Trash2, Star } from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useCountry } from "@/lib/country-context";
import { useWishlist } from "@/lib/wishlist-context";
import { useCart } from "@/lib/cart-context";
import { SEED_PRODUCTS } from "@/lib/seed";
import { formatPrice } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { useToast } from "@/hooks/use-toast";

export default function Wishlist() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { country } = useCountry();
  const { productIds, remove, clear, count } = useWishlist();
  const { add } = useCart();
  const { toast } = useToast();

  const products = productIds
    .map((id) => SEED_PRODUCTS.find((p) => p.id === id))
    .filter(Boolean) as typeof SEED_PRODUCTS;

  const subtle = isDark ? "text-white/55" : "text-stone-500";

  if (count === 0) {
    return (
      <div className="flex flex-col h-full w-full">
        <PageHeader title="Wishlist" />
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
          <div
            className={`w-20 h-20 rounded-full flex items-center justify-center mb-4 ${
              isDark ? "bg-white/5 text-white/30" : "bg-stone-300/35 text-stone-400"
            }`}
          >
            <Heart className="w-10 h-10" />
          </div>
          <h2 className="text-lg font-bold mb-2">No saved items yet</h2>
          <p className={`text-sm ${subtle}`}>
            Tap the heart on any product to save it for later.
          </p>
          <Link
            href="/discover"
            data-testid="link-discover-from-wishlist"
            className={`mt-6 px-6 py-2 rounded-full font-bold text-sm ${
              isDark ? "bg-[#5BA3F5] text-black" : "bg-[#1B2A4A] text-white"
            }`}
          >
            Browse products
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full w-full">
      <PageHeader title={`Wishlist · ${count}`} />
      <div className="px-4 pb-24 space-y-3">
        <div className="flex items-center justify-between">
          <p className={`text-xs ${subtle}`}>
            {count} saved item{count === 1 ? "" : "s"}
          </p>
          <button
            onClick={() => {
              if (confirm("Clear all saved items?")) {
                clear();
                toast({ title: "Wishlist cleared" });
              }
            }}
            className={`text-xs font-bold ${
              isDark ? "text-[#FF8855]" : "text-[#E6502E]"
            }`}
            data-testid="button-clear-wishlist"
          >
            Clear all
          </button>
        </div>

        {products.map((p) => (
          <div
            key={p.id}
            className={`rounded-xl border overflow-hidden ${
              isDark ? "bg-white/5 border-white/10" : "bg-white border-stone-400/35"
            }`}
            data-testid={`wishlist-item-${p.id}`}
          >
            <div className="flex gap-3 p-3">
              <Link
                href={`/product/${p.id}`}
                className="w-20 h-20 rounded-md overflow-hidden bg-stone-200 shrink-0"
              >
                <img
                  src={p.images[0]}
                  alt={p.title}
                  className="w-full h-full object-cover"
                />
              </Link>
              <div className="flex-1 min-w-0">
                <Link href={`/product/${p.id}`}>
                  <p className="text-sm font-bold leading-snug line-clamp-2">
                    {p.title}
                  </p>
                </Link>
                <p
                  className={`text-base font-black mt-1 ${
                    isDark ? "text-[#5BA3F5]" : "text-[#1B2A4A]"
                  }`}
                >
                  {formatPrice(p.priceMinor, country)}
                </p>
                <div
                  className={`flex items-center gap-2 text-xs mt-1 ${subtle}`}
                >
                  <Star
                    className={`w-3 h-3 fill-current ${
                      isDark ? "text-[#FF8855]" : "text-[#E6502E]"
                    }`}
                  />
                  <span>{p.rating}</span>
                  <span>·</span>
                  <span>{p.sellerName}</span>
                </div>
              </div>
            </div>
            <div
              className={`flex border-t ${
                isDark ? "border-white/10" : "border-stone-200"
              }`}
            >
              <button
                onClick={() => {
                  remove(p.id);
                  toast({ title: "Removed from wishlist" });
                }}
                data-testid={`button-remove-wishlist-${p.id}`}
                className={`flex-1 py-2.5 text-xs font-bold flex items-center justify-center gap-1.5 ${
                  isDark
                    ? "text-white/60 hover:bg-white/5"
                    : "text-stone-600 hover:bg-stone-50"
                }`}
              >
                <Trash2 className="w-3.5 h-3.5" /> Remove
              </button>
              <button
                onClick={() => {
                  add(p.id, 1);
                  toast({
                    title: "Added to cart",
                    description: p.title.slice(0, 60),
                  });
                }}
                data-testid={`button-cart-from-wishlist-${p.id}`}
                className={`flex-1 py-2.5 text-xs font-bold flex items-center justify-center gap-1.5 border-l ${
                  isDark
                    ? "border-white/10 text-[#5BA3F5] hover:bg-[#5BA3F5]/10"
                    : "border-stone-200 text-[#1B2A4A] hover:bg-[#1B2A4A]/5"
                }`}
              >
                <ShoppingCart className="w-3.5 h-3.5" /> Add to cart
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
