import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { ChevronRight, MapPin, Crosshair, Check, Truck } from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useCountry } from "@/lib/country-context";
import { useCheckout } from "@/lib/checkout-context";
import { OrderAddress } from "@/lib/orders-context";
import { useCart } from "@/lib/cart-context";
import { formatPrice } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { BottomActions, CheckoutSteps } from "./method";
import {
  verifyAddress as apiVerifyAddress,
  rateShipment as apiRateShipment,
  type RateQuote,
} from "@workspace/api-client-react";

export default function CheckoutAddress() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { country } = useCountry();
  const { draft, set } = useCheckout();
  const { items } = useCart();
  const [, setLocation] = useLocation();
  const [verifyState, setVerifyState] = useState<"idle" | "loading" | "ok" | "low">("idle");
  const [placeId, setPlaceId] = useState<string | null>(null);
  const [verifySuggestion, setVerifySuggestion] = useState<string | null>(null);
  const [quotes, setQuotes] = useState<RateQuote[] | null>(null);
  const [quotesLoading, setQuotesLoading] = useState(false);
  const [quotesError, setQuotesError] = useState<string | null>(null);
  const verifyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ratesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRatedKey = useRef<string>("");

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

  // OkHi verify-address debounce. Fires whenever the user has typed enough
  // for it to be worth checking and the pin has actually moved/been set.
  // We don't run this on every keystroke — wait 600ms of quiet first.
  useEffect(() => {
    if (addr.street.trim().length < 4 || addr.area.trim().length < 2) {
      setVerifyState("idle");
      return;
    }
    if (verifyTimer.current) clearTimeout(verifyTimer.current);
    verifyTimer.current = setTimeout(() => {
      setVerifyState("loading");
      apiVerifyAddress({
        countryCode: country.code,
        line: addr.street,
        area: addr.area,
        city: addr.city,
        lat: addr.lat,
        lng: addr.lng,
      })
        .then((data) => {
          setPlaceId(data.placeId);
          setVerifySuggestion(data.suggestion ?? null);
          setAddr((a) => ({ ...a, confidencePct: data.confidencePct }));
          setVerifyState(data.confidencePct >= 70 ? "ok" : "low");
          // Persist placeId + signed verification token on the draft so
          // review.tsx can attach them to the order's fulfillment payload
          // for the dispatcher (token is required for home delivery).
          set({
            placeId: data.placeId,
            verificationToken: (data as { verificationToken?: string }).verificationToken,
          });
        })
        .catch(() => setVerifyState("idle"));
    }, 600);
    return () => {
      if (verifyTimer.current) clearTimeout(verifyTimer.current);
    };
  }, [addr.street, addr.area, addr.city, addr.lat, addr.lng, country.code]);

  // Carrier-rate quote. Once verification clears the 70% bar we ask the
  // server for live carrier prices. Memoise the payload key so changing
  // unrelated state doesn't re-rate.
  const cartItems = useMemo(
    () => items.map((it) => ({ productId: it.productId, qty: it.qty })),
    [items],
  );
  useEffect(() => {
    const key = `${verifyState}|${addr.street}|${addr.area}|${cartItems.length}|${draft.fulfillmentOptionId ?? ""}`;
    if (verifyState !== "ok") {
      setQuotes(null);
      setQuotesError(null);
      return;
    }
    if (cartItems.length === 0) return;
    if (key === lastRatedKey.current) return;
    if (ratesTimer.current) clearTimeout(ratesTimer.current);
    ratesTimer.current = setTimeout(() => {
      lastRatedKey.current = key;
      setQuotesLoading(true);
      setQuotesError(null);
      apiRateShipment({
        currencyCode: country.currency.code,
        optionId: draft.fulfillmentOptionId,
        destination: {
          line: addr.street,
          area: addr.area,
          city: addr.city,
          countryCode: country.code,
          lat: addr.lat,
          lng: addr.lng,
          placeId,
        },
        items: cartItems,
      })
        .then((data) => {
          setQuotes(data.quotes);
          // Pre-pick the cheapest if the buyer hasn't picked yet.
          const sorted = [...data.quotes].sort((a, b) => a.priceMinor - b.priceMinor);
          if (sorted[0] && !draft.fulfillmentRate) {
            set({
              fulfillmentRate: {
                carrier: sorted[0].carrier,
                service: sorted[0].service,
                serviceLabel: sorted[0].serviceLabel,
                priceMinor: sorted[0].priceMinor,
                currencyCode: sorted[0].currencyCode,
                etaLabel: sorted[0].etaLabel,
                raw: (sorted[0].raw as Record<string, unknown> | undefined) ?? {},
              },
            });
          }
        })
        .catch((err) => setQuotesError(err instanceof Error ? err.message : "Could not load rates"))
        .finally(() => setQuotesLoading(false));
    }, 400);
    return () => {
      if (ratesTimer.current) clearTimeout(ratesTimer.current);
    };
  }, [verifyState, addr.street, addr.area, cartItems, country.code, country.currency.code, placeId, draft.fulfillmentOptionId, draft.fulfillmentRate, set]);

  const hasUsableConfidence = verifyState === "ok" || addr.confidencePct >= 70;
  const canContinue =
    addr.street.trim().length >= 4 &&
    addr.area.trim().length >= 2 &&
    hasUsableConfidence &&
    !!draft.fulfillmentRate;

  function pickQuote(q: RateQuote) {
    set({
      fulfillmentRate: {
        carrier: q.carrier,
        service: q.service,
        serviceLabel: q.serviceLabel,
        priceMinor: q.priceMinor,
        currencyCode: q.currencyCode,
        etaLabel: q.etaLabel,
        raw: (q.raw as Record<string, unknown> | undefined) ?? {},
      },
    });
  }

  function next() {
    if (!canContinue) return;
    set({
      deliveryAddress: { ...addr, confidencePct: addr.confidencePct },
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
            Great pin. Rider will find you easily.
          </div>
        )}
        {verifySuggestion && (
          <div className={`p-3 rounded-xl text-xs ${isDark ? "bg-white/5 text-white/70" : "bg-stone-100 text-stone-600"}`}>
            <span className="font-bold">Did you mean: </span>
            {verifySuggestion}
          </div>
        )}

        {hasUsableConfidence && (
          <div data-testid="rates-section">
            <h3 className={`text-xs font-bold uppercase tracking-wider mb-2 ${subtle}`}>
              Pick a courier
            </h3>
            {quotesLoading && (
              <div className={`p-4 rounded-xl text-center text-xs ${subtle}`}>
                Fetching live carrier prices…
              </div>
            )}
            {quotesError && (
              <div className={`p-3 rounded-xl text-xs ${
                isDark ? "bg-[#FF8855]/10 text-[#FF8855]" : "bg-[#E6502E]/10 text-[#E6502E]"
              }`}>
                {quotesError}
              </div>
            )}
            <div className="space-y-2">
              {(quotes ?? []).map((q) => {
                const id = `${q.carrier}:${q.service}`;
                const isPicked = draft.fulfillmentRate?.carrier === q.carrier && draft.fulfillmentRate?.service === q.service;
                return (
                  <button
                    key={id}
                    onClick={() => pickQuote(q)}
                    data-testid={`rate-${q.carrier}-${q.service.replace(/[^a-z0-9]/gi, "-")}`}
                    className={`w-full text-left flex items-center gap-3 rounded-xl border p-3 transition-colors ${
                      isPicked
                        ? isDark
                          ? "border-[#5BA3F5] bg-[#5BA3F5]/10"
                          : "border-[#1B2A4A] bg-[#1B2A4A]/10"
                        : isDark
                          ? "border-white/10 bg-white/5"
                          : "border-stone-400/35 bg-white"
                    }`}
                  >
                    <div className={`w-9 h-9 rounded-full flex items-center justify-center ${
                      isPicked
                        ? isDark ? "bg-[#5BA3F5] text-black" : "bg-[#1B2A4A] text-white"
                        : isDark ? "bg-white/10 text-white/70" : "bg-stone-200 text-stone-600"
                    }`}>
                      <Truck className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="font-bold text-sm">{q.serviceLabel}</p>
                        <p className="text-sm font-bold">
                          {q.priceMinor === 0 ? "FREE" : formatPrice(q.priceMinor, country)}
                        </p>
                      </div>
                      <p className={`text-[11px] mt-0.5 ${subtle}`}>
                        {q.carrier.toUpperCase()} · {q.etaLabel}
                      </p>
                    </div>
                    {isPicked && <Check className={`w-4 h-4 shrink-0 ${isDark ? "text-[#5BA3F5]" : "text-[#1B2A4A]"}`} />}
                  </button>
                );
              })}
            </div>
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
