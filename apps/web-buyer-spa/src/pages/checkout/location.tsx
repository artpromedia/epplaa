import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { ChevronRight, MapPin, Clock, Check, List, Map as MapIcon } from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useCountry } from "@/lib/country-context";
import { useCheckout } from "@/lib/checkout-context";
import { getLocationsForCountry, FulfillmentLocation } from "@/lib/fulfillment-locations";
import { PageHeader } from "@/components/page-header";
import { BottomActions, CheckoutSteps } from "./method";

export default function CheckoutLocation() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { country } = useCountry();
  const { draft, set } = useCheckout();
  const [, setLocation] = useLocation();
  const [picked, setPicked] = useState<string | undefined>(draft.locationId);
  const [view, setView] = useState<"list" | "map">("list");
  const [city, setCity] = useState<string | "all">("all");

  useEffect(() => {
    if (!draft.fulfillmentOptionId) {
      setLocation("/checkout");
      return;
    }
    // If the picked option is actually home-delivery, this is the wrong step.
    const id = draft.fulfillmentOptionId;
    if (id.includes("home") || id.includes("door") || id.includes("livraison")) {
      setLocation("/checkout/address");
    }
  }, [draft.fulfillmentOptionId, setLocation]);

  const allLocations = useMemo(
    () => getLocationsForCountry(country.code, draft.fulfillmentOptionId),
    [country.code, draft.fulfillmentOptionId],
  );
  const cities = useMemo(
    () => Array.from(new Set(allLocations.map((l) => l.city))),
    [allLocations],
  );
  const visible = useMemo(
    () => (city === "all" ? allLocations : allLocations.filter((l) => l.city === city)),
    [allLocations, city],
  );

  const opt = country.fulfillmentOptions.find(
    (o) => o.id === draft.fulfillmentOptionId,
  );

  const subtle = isDark ? "text-white/55" : "text-stone-500";

  function next() {
    if (!picked) return;
    set({ locationId: picked });
    setLocation("/checkout/payment");
  }

  if (allLocations.length === 0) {
    return (
      <div className="flex flex-col h-full w-full">
        <PageHeader title="Pick location" backHref="/checkout" />
        <div className="px-4 py-6 text-center">
          <p className={subtle}>
            No pickup points configured for {country.name} yet. Try Home Delivery
            instead.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full w-full">
      <PageHeader title="Pick location" backHref="/checkout" />
      <div className="px-4 pb-32 space-y-4">
        <CheckoutSteps current={2} />

        {opt && (
          <p className={`text-xs ${subtle}`}>
            Method: <span className="font-bold">{opt.label}</span> · ETA{" "}
            {opt.etaLabel.toLowerCase()}
          </p>
        )}

        <div className="flex items-center gap-2">
          <div className={`flex-1 flex gap-1 overflow-x-auto no-scrollbar`}>
            <button
              onClick={() => setCity("all")}
              data-testid="filter-city-all"
              className={`px-3 h-8 rounded-full text-xs font-bold whitespace-nowrap ${
                city === "all"
                  ? isDark
                    ? "bg-[#5BA3F5] text-black"
                    : "bg-[#1B2A4A] text-white"
                  : isDark
                    ? "bg-white/10 text-white/70"
                    : "bg-stone-200 text-stone-600"
              }`}
            >
              All cities
            </button>
            {cities.map((c) => (
              <button
                key={c}
                onClick={() => setCity(c)}
                data-testid={`filter-city-${c}`}
                className={`px-3 h-8 rounded-full text-xs font-bold whitespace-nowrap ${
                  city === c
                    ? isDark
                      ? "bg-[#5BA3F5] text-black"
                      : "bg-[#1B2A4A] text-white"
                    : isDark
                      ? "bg-white/10 text-white/70"
                      : "bg-stone-200 text-stone-600"
                }`}
              >
                {c}
              </button>
            ))}
          </div>
          <button
            onClick={() => setView(view === "list" ? "map" : "list")}
            data-testid="button-toggle-view"
            className={`shrink-0 h-8 px-3 rounded-full text-xs font-bold border flex items-center gap-1 ${
              isDark
                ? "border-white/20 text-white"
                : "border-stone-400 text-stone-900"
            }`}
          >
            {view === "list" ? (
              <>
                <MapIcon className="w-3.5 h-3.5" /> Map
              </>
            ) : (
              <>
                <List className="w-3.5 h-3.5" /> List
              </>
            )}
          </button>
        </div>

        {view === "map" ? (
          <MapView
            isDark={isDark}
            locations={visible}
            picked={picked}
            onPick={setPicked}
            cityLabel={city === "all" ? country.primaryCity : city}
          />
        ) : (
          <div className="space-y-2">
            {visible.map((loc) => (
              <LocationRow
                key={loc.id}
                isDark={isDark}
                loc={loc}
                picked={picked === loc.id}
                onPick={() => setPicked(loc.id)}
              />
            ))}
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
          disabled={!picked}
          className={`flex-1 h-12 rounded-xl text-white font-bold flex items-center justify-center gap-1 disabled:opacity-40 ${
            isDark
              ? "bg-[#FF8855] hover:bg-[#FF6B35]"
              : "bg-[#E6502E] hover:bg-[#C4441E]"
          }`}
          data-testid="button-location-next"
        >
          Continue <ChevronRight className="w-4 h-4" />
        </button>
      </BottomActions>
    </div>
  );
}

function LocationRow({
  isDark,
  loc,
  picked,
  onPick,
}: {
  isDark: boolean;
  loc: FulfillmentLocation;
  picked: boolean;
  onPick: () => void;
}) {
  return (
    <button
      onClick={onPick}
      data-testid={`location-${loc.id}`}
      className={`w-full text-left flex items-start gap-3 rounded-xl border p-3 transition-colors ${
        picked
          ? isDark
            ? "border-[#5BA3F5] bg-[#5BA3F5]/10"
            : "border-[#1B2A4A] bg-[#1B2A4A]/10"
          : isDark
            ? "border-white/10 bg-white/5 hover:bg-white/10"
            : "border-stone-400/35 bg-white hover:bg-stone-50"
      }`}
    >
      <div
        className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${
          picked
            ? isDark
              ? "bg-[#5BA3F5] text-black"
              : "bg-[#1B2A4A] text-white"
            : isDark
              ? "bg-white/10 text-white/70"
              : "bg-stone-200 text-stone-600"
        }`}
      >
        <MapPin className="w-4 h-4" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-bold text-sm">{loc.name}</p>
        <p
          className={`text-xs ${
            isDark ? "text-white/60" : "text-stone-500"
          }`}
        >
          {loc.addressLine}
        </p>
        <div
          className={`flex items-center gap-3 mt-1 text-[11px] ${
            isDark ? "text-white/55" : "text-stone-500"
          }`}
        >
          <span className="flex items-center gap-1">
            <MapPin className="w-3 h-3" />
            {loc.distanceLabel}
          </span>
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {loc.hours}
          </span>
        </div>
      </div>
      {picked && (
        <Check
          className={`w-5 h-5 shrink-0 ${
            isDark ? "text-[#5BA3F5]" : "text-[#1B2A4A]"
          }`}
        />
      )}
    </button>
  );
}

function MapView({
  isDark,
  locations,
  picked,
  onPick,
  cityLabel,
}: {
  isDark: boolean;
  locations: FulfillmentLocation[];
  picked?: string;
  onPick: (id: string) => void;
  cityLabel: string;
}) {
  return (
    <div
      className={`relative rounded-xl border overflow-hidden ${
        isDark ? "border-white/10" : "border-stone-400/35"
      }`}
    >
      <div
        className={`relative w-full aspect-[4/5] ${
          isDark
            ? "bg-gradient-to-br from-[#1B2A4A] via-[#0F1E3A] to-[#0F1525]"
            : "bg-gradient-to-br from-[#fff5d8] via-[#f5d8a0] to-[#fbeed3]"
        }`}
        data-testid="map-canvas"
      >
        {/* stylized "roads" */}
        <div className="absolute inset-0">
          <div
            className={`absolute top-1/4 left-0 right-0 h-px ${
              isDark ? "bg-white/10" : "bg-stone-500/15"
            }`}
          />
          <div
            className={`absolute top-1/2 left-0 right-0 h-px ${
              isDark ? "bg-white/10" : "bg-stone-500/15"
            }`}
          />
          <div
            className={`absolute top-3/4 left-0 right-0 h-px ${
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
        {/* river/water shape */}
        <svg
          className="absolute inset-0 w-full h-full opacity-60"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          <path
            d="M0,80 Q30,70 50,75 T100,68 L100,100 L0,100 Z"
            fill={isDark ? "#3D7BC4" : "#6BA8E5"}
            fillOpacity="0.15"
          />
        </svg>

        <div
          className={`absolute top-2 left-2 px-2 py-1 rounded text-[10px] font-bold ${
            isDark
              ? "bg-black/50 text-white/80"
              : "bg-white/80 text-stone-700"
          }`}
        >
          {cityLabel}
        </div>

        {locations.map((loc) => {
          const isPicked = picked === loc.id;
          return (
            <button
              key={loc.id}
              onClick={() => onPick(loc.id)}
              data-testid={`map-pin-${loc.id}`}
              className="absolute -translate-x-1/2 -translate-y-full transition-transform hover:scale-110"
              style={{ left: `${loc.mapX}%`, top: `${loc.mapY}%` }}
              aria-label={`Pick ${loc.name}`}
            >
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center shadow-md ${
                  isPicked
                    ? isDark
                      ? "bg-[#FF8855] text-black ring-4 ring-[#FF8855]/30"
                      : "bg-[#E6502E] text-white ring-4 ring-[#E6502E]/30"
                    : isDark
                      ? "bg-[#5BA3F5] text-black"
                      : "bg-[#1B2A4A] text-white"
                }`}
              >
                <MapPin className="w-3.5 h-3.5" />
              </div>
              <div
                className={`mx-auto w-2 h-2 -mt-0.5 rotate-45 ${
                  isPicked
                    ? isDark
                      ? "bg-[#FF8855]"
                      : "bg-[#E6502E]"
                    : isDark
                      ? "bg-[#5BA3F5]"
                      : "bg-[#1B2A4A]"
                }`}
              />
            </button>
          );
        })}
      </div>

      {picked && (
        <div
          className={`p-3 border-t ${
            isDark
              ? "bg-[#171C30] border-white/10"
              : "bg-white border-stone-400/35"
          }`}
          data-testid="map-picked-detail"
        >
          {(() => {
            const loc = locations.find((l) => l.id === picked);
            if (!loc) return null;
            return (
              <div>
                <p className="font-bold text-sm">{loc.name}</p>
                <p
                  className={`text-xs ${
                    isDark ? "text-white/60" : "text-stone-500"
                  }`}
                >
                  {loc.addressLine} · {loc.distanceLabel} · {loc.hours}
                </p>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
