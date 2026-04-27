import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { ChevronRight, MapPin, Crosshair, Check } from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useCountry } from "@/lib/country-context";
import { useCheckout } from "@/lib/checkout-context";
import { OrderAddress } from "@/lib/orders-context";
import { PageHeader } from "@/components/page-header";
import { BottomActions, CheckoutSteps } from "./method";

export default function CheckoutAddress() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { country } = useCountry();
  const { draft, set } = useCheckout();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!draft.fulfillmentOptionId) {
      setLocation("/checkout");
      return;
    }
    // If the picked option is a pickup method, this is the wrong step.
    const id = draft.fulfillmentOptionId;
    const isHome =
      id.includes("home") || id.includes("door") || id.includes("livraison");
    if (!isHome) {
      setLocation("/checkout/location");
    }
  }, [draft.fulfillmentOptionId, setLocation]);

  const initial: OrderAddress = draft.deliveryAddress ?? {
    label: "Home",
    street: "",
    area: "",
    city: country.primaryCity,
    notes: "",
    lat: 6.5244,
    lng: 3.3792,
    confidencePct: 0,
  };
  const [addr, setAddr] = useState<OrderAddress>(initial);
  const [pinPos, setPinPos] = useState<{ x: number; y: number }>({
    x: 50,
    y: 50,
  });

  const subtle = isDark ? "text-white/55" : "text-stone-500";
  const inputClass = `w-full h-11 px-3 rounded-lg border text-sm ${
    isDark
      ? "bg-white/5 border-white/10 text-white placeholder-white/30"
      : "bg-white border-stone-400/55 text-stone-900 placeholder-stone-400"
  }`;

  function handleMapClick(e: React.MouseEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 100;
    const y = ((e.clientY - r.top) / r.height) * 100;
    setPinPos({ x: Math.max(4, Math.min(96, x)), y: Math.max(4, Math.min(96, y)) });
    bumpConfidence(15);
  }

  function bumpConfidence(by: number) {
    setAddr((a) => ({ ...a, confidencePct: Math.min(98, a.confidencePct + by) }));
  }

  function useGPS() {
    // Mock GPS — in real app would use navigator.geolocation
    setPinPos({ x: 45 + Math.random() * 10, y: 45 + Math.random() * 10 });
    setAddr((a) => ({
      ...a,
      lat: 6.5244 + (Math.random() - 0.5) * 0.1,
      lng: 3.3792 + (Math.random() - 0.5) * 0.1,
      confidencePct: Math.max(a.confidencePct, 70),
    }));
  }

  const canContinue = addr.street.trim().length >= 4 && addr.area.trim().length >= 2;

  function next() {
    if (!canContinue) return;
    const finalConfidence = Math.max(addr.confidencePct, 35);
    set({
      deliveryAddress: { ...addr, confidencePct: finalConfidence },
    });
    setLocation("/checkout/payment");
  }

  return (
    <div className="flex flex-col h-full w-full">
      <PageHeader title="Delivery address" backHref="/checkout" />
      <div className="px-4 pb-32 space-y-4">
        <CheckoutSteps current={2} />

        <div>
          <h3 className={`text-xs font-bold uppercase tracking-wider mb-2 ${subtle}`}>
            Pin your spot
          </h3>
          <div
            onClick={handleMapClick}
            className={`relative w-full aspect-[4/3] rounded-xl border overflow-hidden cursor-crosshair ${
              isDark
                ? "border-white/10 bg-gradient-to-br from-[#1B2A4A] via-[#0F1E3A] to-[#0F1525]"
                : "border-stone-400/55 bg-gradient-to-br from-[#fff5d8] via-[#f5d8a0] to-[#fbeed3]"
            }`}
            data-testid="map-pinpicker"
          >
            <div className="absolute inset-0">
              <div
                className={`absolute top-1/3 left-0 right-0 h-px ${
                  isDark ? "bg-white/10" : "bg-stone-500/15"
                }`}
              />
              <div
                className={`absolute top-2/3 left-0 right-0 h-px ${
                  isDark ? "bg-white/10" : "bg-stone-500/15"
                }`}
              />
              <div
                className={`absolute top-0 bottom-0 left-1/3 w-px ${
                  isDark ? "bg-white/10" : "bg-stone-500/15"
                }`}
              />
              <div
                className={`absolute top-0 bottom-0 left-2/3 w-px ${
                  isDark ? "bg-white/10" : "bg-stone-500/15"
                }`}
              />
            </div>
            <div
              className="absolute -translate-x-1/2 -translate-y-full transition-all"
              style={{ left: `${pinPos.x}%`, top: `${pinPos.y}%` }}
              data-testid="address-pin"
            >
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center shadow-md ${
                  isDark
                    ? "bg-[#FF8855] text-black ring-4 ring-[#FF8855]/30"
                    : "bg-[#E6502E] text-white ring-4 ring-[#E6502E]/30"
                }`}
              >
                <MapPin className="w-4 h-4" />
              </div>
              <div
                className={`mx-auto w-2 h-2 -mt-0.5 rotate-45 ${
                  isDark ? "bg-[#FF8855]" : "bg-[#E6502E]"
                }`}
              />
            </div>

            <button
              onClick={(e) => {
                e.stopPropagation();
                useGPS();
              }}
              data-testid="button-use-gps"
              className={`absolute bottom-2 right-2 px-3 h-8 rounded-full text-xs font-bold flex items-center gap-1 shadow-md ${
                isDark
                  ? "bg-[#5BA3F5] text-black"
                  : "bg-[#1B2A4A] text-white"
              }`}
            >
              <Crosshair className="w-3.5 h-3.5" /> Use GPS
            </button>

            <div
              className={`absolute bottom-2 left-2 px-2 py-1 rounded text-[10px] font-bold ${
                isDark
                  ? "bg-black/50 text-white/80"
                  : "bg-white/80 text-stone-700"
              }`}
            >
              Tap map to drop pin
            </div>
          </div>

          <div className="mt-2 flex items-center justify-between text-xs">
            <span className={subtle}>OkHi pin confidence</span>
            <span
              className={`font-bold ${
                addr.confidencePct >= 70
                  ? isDark
                    ? "text-[#5BA3F5]"
                    : "text-[#1B2A4A]"
                  : addr.confidencePct >= 35
                    ? isDark
                      ? "text-[#FF8855]"
                      : "text-[#E6502E]"
                    : subtle
              }`}
              data-testid="text-confidence"
            >
              {addr.confidencePct}%
            </span>
          </div>
          <div
            className={`h-1.5 rounded-full overflow-hidden ${
              isDark ? "bg-white/10" : "bg-stone-300"
            }`}
          >
            <div
              className={`h-full transition-all ${
                isDark ? "bg-[#5BA3F5]" : "bg-[#1B2A4A]"
              }`}
              style={{ width: `${addr.confidencePct}%` }}
            />
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <label className={`block text-xs font-bold mb-1 ${subtle}`}>
              Label
            </label>
            <div className="flex gap-2">
              {["Home", "Work", "Other"].map((l) => (
                <button
                  key={l}
                  onClick={() => setAddr((a) => ({ ...a, label: l }))}
                  data-testid={`label-${l.toLowerCase()}`}
                  className={`px-3 h-9 rounded-full text-xs font-bold ${
                    addr.label === l
                      ? isDark
                        ? "bg-[#5BA3F5] text-black"
                        : "bg-[#1B2A4A] text-white"
                      : isDark
                        ? "bg-white/10 text-white/70"
                        : "bg-stone-200 text-stone-600"
                  }`}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className={`block text-xs font-bold mb-1 ${subtle}`}>
              Street address
            </label>
            <input
              value={addr.street}
              onChange={(e) => {
                setAddr((a) => ({ ...a, street: e.target.value }));
                if (e.target.value.length === 4) bumpConfidence(20);
              }}
              placeholder="14 Awolowo Rd"
              className={inputClass}
              data-testid="input-street"
            />
          </div>
          <div>
            <label className={`block text-xs font-bold mb-1 ${subtle}`}>
              Area / neighbourhood
            </label>
            <input
              value={addr.area}
              onChange={(e) => {
                setAddr((a) => ({ ...a, area: e.target.value }));
                if (e.target.value.length === 2) bumpConfidence(15);
              }}
              placeholder="Surulere"
              className={inputClass}
              data-testid="input-area"
            />
          </div>
          <div>
            <label className={`block text-xs font-bold mb-1 ${subtle}`}>
              City
            </label>
            <input
              value={addr.city}
              onChange={(e) => setAddr((a) => ({ ...a, city: e.target.value }))}
              className={inputClass}
              data-testid="input-city"
            />
          </div>
          <div>
            <label className={`block text-xs font-bold mb-1 ${subtle}`}>
              Notes for rider <span className={subtle}>(optional)</span>
            </label>
            <textarea
              value={addr.notes ?? ""}
              onChange={(e) => setAddr((a) => ({ ...a, notes: e.target.value }))}
              placeholder="Gate code, landmarks, who to call…"
              rows={2}
              className={`${inputClass} h-auto py-2`}
              data-testid="input-notes"
            />
          </div>
        </div>

        {addr.confidencePct < 35 && (
          <div
            className={`flex items-center gap-2 p-3 rounded-xl text-xs ${
              isDark
                ? "bg-[#FF8855]/10 text-[#FF8855] border border-[#FF8855]/30"
                : "bg-[#E6502E]/10 text-[#E6502E] border border-[#E6502E]/30"
            }`}
          >
            <Crosshair className="w-4 h-4 shrink-0" />
            Drop a pin or tap "Use GPS" so the rider can find you.
          </div>
        )}
        {addr.confidencePct >= 70 && (
          <div
            className={`flex items-center gap-2 p-3 rounded-xl text-xs ${
              isDark
                ? "bg-[#5BA3F5]/10 text-[#5BA3F5] border border-[#5BA3F5]/30"
                : "bg-[#1B2A4A]/10 text-[#1B2A4A] border border-[#1B2A4A]/30"
            }`}
          >
            <Check className="w-4 h-4 shrink-0" />
            Great pin — rider will find you easily.
          </div>
        )}
      </div>

      <BottomActions isDark={isDark}>
        <button
          onClick={() => setLocation("/checkout")}
          className={`flex-1 h-12 rounded-xl border font-bold ${
            isDark
              ? "border-white/20 text-white hover:bg-white/10"
              : "border-stone-400 text-stone-900 hover:bg-stone-200"
          }`}
        >
          Back
        </button>
        <button
          onClick={next}
          disabled={!canContinue}
          className={`flex-1 h-12 rounded-xl text-white font-bold flex items-center justify-center gap-1 disabled:opacity-40 ${
            isDark
              ? "bg-[#FF8855] hover:bg-[#FF6B35]"
              : "bg-[#E6502E] hover:bg-[#C4441E]"
          }`}
          data-testid="button-address-next"
        >
          Continue <ChevronRight className="w-4 h-4" />
        </button>
      </BottomActions>
    </div>
  );
}
