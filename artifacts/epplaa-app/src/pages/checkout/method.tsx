import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { Package, MapPin, Truck, ChevronRight, Check } from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useCountry } from "@/lib/country-context";
import { useCart } from "@/lib/cart-context";
import { useCheckout } from "@/lib/checkout-context";
import { formatPrice } from "@/lib/format";
import { PageHeader } from "@/components/page-header";

function iconFor(optionId: string) {
  if (optionId.includes("box") || optionId.includes("locker")) return Package;
  if (optionId.includes("pudo") || optionId.includes("pickup") || optionId.includes("paxi") || optionId.includes("speedaf") || optionId.includes("g4s")) return MapPin;
  return Truck;
}

export default function CheckoutMethod() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { country } = useCountry();
  const { count, subtotalMinor } = useCart();
  const { draft, set } = useCheckout();
  const [, setLocation] = useLocation();
  const [picked, setPicked] = useState<string | undefined>(
    draft.fulfillmentOptionId,
  );

  useEffect(() => {
    if (count === 0) setLocation("/cart");
  }, [count, setLocation]);

  const cardBorder = isDark
    ? "bg-white/5 border-white/10"
    : "bg-white border-stone-400/35";
  const subtle = isDark ? "text-white/55" : "text-stone-500";

  function next() {
    if (!picked) return;
    const opt = country.fulfillmentOptions.find((o) => o.id === picked);
    if (!opt) return;
    set({
      fulfillmentOptionId: picked,
      // clear stale location/address when switching method
      locationId: undefined,
      deliveryAddress: undefined,
    });
    const isHome = picked.includes("home") || picked.includes("door") || picked.includes("livraison");
    setLocation(isHome ? "/checkout/address" : "/checkout/location");
  }

  return (
    <div className="flex flex-col h-full w-full">
      <PageHeader title="Delivery method" backHref="/cart" />
      <div className="px-4 pb-32 space-y-4">
        <CheckoutSteps current={1} />

        <div className={`rounded-xl border p-3 ${cardBorder}`}>
          <p className={`text-xs ${subtle}`}>
            Order subtotal · {count} item{count === 1 ? "" : "s"}
          </p>
          <p className="text-lg font-black">
            {formatPrice(subtotalMinor, country)}
          </p>
        </div>

        <div>
          <h3 className={`text-xs font-bold uppercase tracking-wider mb-2 ${subtle}`}>
            How do you want it?
          </h3>
          <div className="space-y-2">
            {country.fulfillmentOptions.map((opt) => {
              const Icon = iconFor(opt.id);
              const isPicked = picked === opt.id;
              return (
                <button
                  key={opt.id}
                  onClick={() => setPicked(opt.id)}
                  data-testid={`option-${opt.id}`}
                  className={`w-full text-left flex items-start gap-3 rounded-xl border p-4 transition-colors ${
                    isPicked
                      ? isDark
                        ? "border-[#5BA3F5] bg-[#5BA3F5]/10"
                        : "border-[#1B2A4A] bg-[#1B2A4A]/10"
                      : isDark
                        ? "border-white/10 bg-white/5 hover:bg-white/10"
                        : "border-stone-400/35 bg-white hover:bg-stone-50"
                  }`}
                >
                  <div
                    className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
                      isPicked
                        ? isDark
                          ? "bg-[#5BA3F5] text-black"
                          : "bg-[#1B2A4A] text-white"
                        : isDark
                          ? "bg-white/10 text-white/70"
                          : "bg-stone-200 text-stone-600"
                    }`}
                  >
                    <Icon className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="font-bold">{opt.label}</p>
                      <p
                        className={`text-sm font-bold ${
                          opt.feeMinor === 0
                            ? isDark
                              ? "text-[#5BA3F5]"
                              : "text-[#1B2A4A]"
                            : ""
                        }`}
                      >
                        {opt.feeMinor === 0
                          ? "FREE"
                          : formatPrice(opt.feeMinor, country)}
                      </p>
                    </div>
                    <p className={`text-xs mt-0.5 ${subtle}`}>
                      {opt.description}
                    </p>
                    <p className={`text-[11px] mt-1 ${subtle}`}>
                      Arrives {opt.etaLabel.toLowerCase()}
                    </p>
                  </div>
                  {isPicked && (
                    <Check
                      className={`w-5 h-5 shrink-0 ${
                        isDark ? "text-[#5BA3F5]" : "text-[#1B2A4A]"
                      }`}
                    />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <BottomActions isDark={isDark}>
        <Link
          href="/cart"
          className={`flex-1 h-12 rounded-xl border font-bold flex items-center justify-center ${
            isDark
              ? "border-white/20 text-white hover:bg-white/10"
              : "border-stone-400 text-stone-900 hover:bg-stone-200"
          }`}
        >
          Back
        </Link>
        <button
          onClick={next}
          disabled={!picked}
          className={`flex-1 h-12 rounded-xl text-white font-bold flex items-center justify-center gap-1 disabled:opacity-40 ${
            isDark
              ? "bg-[#FF8855] hover:bg-[#FF6B35]"
              : "bg-[#E6502E] hover:bg-[#C4441E]"
          }`}
          data-testid="button-checkout-next"
        >
          Continue <ChevronRight className="w-4 h-4" />
        </button>
      </BottomActions>
    </div>
  );
}

export function CheckoutSteps({ current }: { current: 1 | 2 | 3 | 4 }) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const labels = ["Method", "Where", "Pay", "Review"];
  return (
    <div className="flex items-center gap-2" data-testid="checkout-steps">
      {labels.map((l, i) => {
        const step = (i + 1) as 1 | 2 | 3 | 4;
        const done = step < current;
        const active = step === current;
        return (
          <div key={l} className="flex items-center gap-2 flex-1">
            <div
              className={`flex items-center gap-1.5 ${
                active
                  ? isDark
                    ? "text-[#5BA3F5]"
                    : "text-[#1B2A4A]"
                  : done
                    ? isDark
                      ? "text-[#FF8855]"
                      : "text-[#E6502E]"
                    : isDark
                      ? "text-white/40"
                      : "text-stone-400"
              }`}
            >
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-black ${
                  active
                    ? isDark
                      ? "bg-[#5BA3F5] text-black"
                      : "bg-[#1B2A4A] text-white"
                    : done
                      ? isDark
                        ? "bg-[#FF8855] text-black"
                        : "bg-[#E6502E] text-white"
                      : isDark
                        ? "bg-white/10"
                        : "bg-stone-300"
                }`}
              >
                {done ? <Check className="w-3 h-3" /> : step}
              </div>
              <span className="text-[11px] font-bold uppercase tracking-wider">
                {l}
              </span>
            </div>
            {i < labels.length - 1 && (
              <div
                className={`h-px flex-1 ${
                  isDark ? "bg-white/10" : "bg-stone-300"
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function BottomActions({
  isDark,
  children,
}: {
  isDark: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`absolute bottom-0 left-0 right-0 backdrop-blur-xl border-t p-4 z-30 flex gap-2 ${
        isDark
          ? "bg-[#0F1525]/95 border-white/10"
          : "bg-[#fbeed3]/95 border-stone-400/55"
      }`}
    >
      {children}
    </div>
  );
}
