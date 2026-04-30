import { Link, useLocation } from "wouter";
import { Minus, Plus, Trash2, ShoppingBag } from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useCountry } from "@/lib/country-context";
import { useCart } from "@/lib/cart-context";
import { formatPrice } from "@/lib/format";
import { PageHeader } from "@/components/page-header";

export default function Cart() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { country } = useCountry();
  const { resolved, setQty, remove, subtotalMinor, count } = useCart();
  const [, setLocation] = useLocation();

  const subtle = isDark ? "text-white/55" : "text-stone-500";
  const cardBorder = isDark
    ? "bg-white/5 border-white/10"
    : "bg-white border-stone-400/35";

  if (resolved.length === 0) {
    return (
      <div className="flex flex-col h-full w-full">
        <PageHeader title="Cart" />
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
          <div
            className={`w-20 h-20 rounded-full flex items-center justify-center mb-4 ${
              isDark
                ? "bg-white/5 text-white/30"
                : "bg-stone-300/35 text-stone-400"
            }`}
          >
            <ShoppingBag className="w-10 h-10" />
          </div>
          <h2 className="text-lg font-bold mb-2">Your cart is empty</h2>
          <p className={`text-sm ${subtle}`}>
            Tap Add to Cart on any product to start a basket.
          </p>
          <Link
            href="/discover"
            className={`mt-6 px-6 py-2 rounded-full font-bold text-sm ${
              isDark
                ? "bg-[#5BA3F5] text-black hover:bg-[#3D7BC4]"
                : "bg-[#1B2A4A] text-white hover:bg-[#0F1E3A]"
            }`}
            data-testid="link-discover-from-empty-cart"
          >
            Browse products
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full w-full">
      <PageHeader title={`Cart (${count})`} />
      <div className="flex-1 overflow-y-auto px-4 pb-44 space-y-3">
        {resolved.map((item) => (
          <div
            key={item.productId}
            className={`rounded-xl border p-3 flex gap-3 ${cardBorder}`}
            data-testid={`cart-item-${item.productId}`}
          >
            <Link
              href={`/product/${item.productId}`}
              className="shrink-0 w-20 h-20 rounded-lg overflow-hidden bg-stone-200"
            >
              <img
                src={item.image}
                alt={item.title}
                className="w-full h-full object-cover"
              />
            </Link>
            <div className="flex-1 min-w-0">
              <Link
                href={`/product/${item.productId}`}
                className="font-bold text-sm leading-snug line-clamp-2 hover:underline"
              >
                {item.title}
              </Link>
              <p className={`text-xs mt-0.5 ${subtle}`}>{item.sellerName}</p>
              {item.variantNotes && (
                <p className={`text-xs mt-0.5 ${subtle}`}>
                  {item.variantNotes}
                </p>
              )}
              <div className="flex items-center justify-between mt-2">
                <p
                  className={`font-black ${
                    isDark ? "text-[#5BA3F5]" : "text-[#1B2A4A]"
                  }`}
                >
                  {formatPrice(item.lineTotalMinor, country)}
                </p>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setQty(item.productId, item.qty - 1)}
                    className={`w-7 h-7 rounded-full border flex items-center justify-center ${
                      isDark
                        ? "border-white/20 hover:bg-white/10"
                        : "border-stone-400 hover:bg-stone-200"
                    }`}
                    data-testid={`button-decrement-${item.productId}`}
                  >
                    <Minus className="w-3.5 h-3.5" />
                  </button>
                  <span className="w-6 text-center text-sm font-bold">
                    {item.qty}
                  </span>
                  <button
                    onClick={() => setQty(item.productId, item.qty + 1)}
                    className={`w-7 h-7 rounded-full border flex items-center justify-center ${
                      isDark
                        ? "border-white/20 hover:bg-white/10"
                        : "border-stone-400 hover:bg-stone-200"
                    }`}
                    data-testid={`button-increment-${item.productId}`}
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => remove(item.productId)}
                    className={`ml-1 w-7 h-7 rounded-full flex items-center justify-center ${
                      isDark
                        ? "text-white/50 hover:text-[#FF8855] hover:bg-white/10"
                        : "text-stone-400 hover:text-[#E6502E] hover:bg-stone-200"
                    }`}
                    data-testid={`button-remove-${item.productId}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div
        className={`absolute bottom-0 left-0 right-0 backdrop-blur-xl border-t p-4 z-30 ${
          isDark
            ? "bg-[#0F1525]/95 border-white/10"
            : "bg-[#fbeed3]/95 border-stone-400/55"
        }`}
      >
        <div className="flex items-center justify-between mb-3">
          <p className={`text-sm ${subtle}`}>Subtotal · {count} items</p>
          <p className="text-xl font-black" data-testid="text-cart-subtotal">
            {formatPrice(subtotalMinor, country)}
          </p>
        </div>
        <p className={`text-[11px] mb-3 ${subtle}`}>
          Delivery method, fees, and country payment options selected at
          checkout.
        </p>
        <button
          onClick={() => setLocation("/checkout")}
          className={`w-full h-14 rounded-xl text-white font-black text-lg ${
            isDark
              ? "bg-gradient-to-r from-[#FF8855] to-[#FF6B35] shadow-[0_0_20px_rgba(255,136,85,0.4)]"
              : "bg-gradient-to-r from-[#E6502E] to-[#C4441E] shadow-md"
          }`}
          data-testid="button-checkout"
        >
          Checkout
        </button>
      </div>
    </div>
  );
}
