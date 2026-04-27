import {
  Settings,
  CreditCard,
  MapPin,
  ChevronRight,
  Store,
  Sparkles,
  ArrowLeftRight,
  LayoutGrid,
  Heart,
  Wallet,
} from "lucide-react";
import { Link } from "wouter";
import { useTheme } from "@/lib/theme-context";
import { useCountry } from "@/lib/country-context";
import { useSeller } from "@/lib/seller-context";
import { COUNTRIES, CountryCode } from "@/lib/countries";
import { ThemeToggle } from "@/components/theme-toggle";
import { TierBadge } from "@/components/tier-badge";

export default function Profile() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { country, setCountry } = useCountry();
  const { status, tier, mode, application, setMode } = useSeller();

  const subtleText = isDark ? "text-white/50" : "text-stone-500";
  const cardBorder = isDark
    ? "bg-white/5 border-white/10"
    : "bg-white border-stone-400/35";

  const displayName = application?.storeName || "Epplaa User";
  const handle = application?.storeHandle
    ? `@${application.storeHandle}`
    : "@epplaa_fan";

  return (
    <div className="flex flex-col h-full w-full">
      <div
        className={`pt-12 pb-6 px-4 z-10 sticky top-0 ${
          isDark ? "bg-[#0F1525]" : "bg-[#fbeed3]"
        }`}
      >
        <div className="flex justify-between items-center">
          <h1 className="text-2xl font-bold">Profile</h1>
          <ThemeToggle />
        </div>
      </div>

      <div className="px-4 pb-20">
        <div className="flex items-center gap-4 mb-6">
          <div className="w-20 h-20 rounded-full bg-gradient-to-tr from-[#FF8855] to-[#5BA3F5] p-1">
            <div
              className={`w-full h-full rounded-full flex items-center justify-center text-2xl font-bold ${
                isDark ? "bg-black text-white" : "bg-white text-stone-900"
              }`}
            >
              {displayName.slice(0, 2).toUpperCase()}
            </div>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-bold truncate">{displayName}</h2>
              {status === "approved" && <TierBadge tier={tier} />}
            </div>
            <p className={`text-sm ${subtleText}`}>{handle}</p>
            {status === "approved" && (
              <p
                className={`text-[10px] font-bold uppercase tracking-wider mt-1 ${
                  isDark ? "text-[#5BA3F5]" : "text-[#1B2A4A]"
                }`}
              >
                {mode === "seller" ? "Seller mode" : "Buyer mode"}
              </p>
            )}
          </div>
        </div>

        <div className="space-y-6">
          {/* Selling section */}
          <div>
            <h3
              className={`text-sm font-bold mb-3 uppercase tracking-wider ${
                isDark ? "text-white/40" : "text-stone-400"
              }`}
            >
              Selling
            </h3>
            {status === "none" && (
              <div
                className={`rounded-xl border overflow-hidden ${cardBorder}`}
              >
                <Link
                  href="/seller/apply"
                  className={`block p-4 ${
                    isDark ? "hover:bg-white/5" : "hover:bg-stone-50"
                  }`}
                  data-testid="link-become-seller"
                >
                  <div className="flex items-center gap-3 mb-1">
                    <div
                      className={`w-10 h-10 rounded-full flex items-center justify-center ${
                        isDark
                          ? "bg-gradient-to-tr from-[#FF8855]/20 to-[#5BA3F5]/20"
                          : "bg-gradient-to-tr from-[#E6502E]/15 to-[#1B2A4A]/15"
                      }`}
                    >
                      <Sparkles
                        className={`w-5 h-5 ${
                          isDark ? "text-[#5BA3F5]" : "text-[#1B2A4A]"
                        }`}
                      />
                    </div>
                    <div className="flex-1">
                      <p className="font-bold">Become a Seller</p>
                      <p className={`text-xs ${subtleText}`}>
                        Get vetted, list products, and go live
                      </p>
                    </div>
                    <ChevronRight
                      className={`w-4 h-4 ${
                        isDark ? "text-white/30" : "text-stone-400"
                      }`}
                    />
                  </div>
                </Link>
                <Link
                  href="/seller/tiers"
                  className={`flex items-center justify-between p-3 border-t text-sm ${
                    isDark
                      ? "border-white/10 hover:bg-white/5"
                      : "border-stone-200 hover:bg-stone-50"
                  }`}
                  data-testid="link-view-tiers-from-profile"
                >
                  <span className={subtleText}>
                    Compare seller tiers (Starter / Pro / Elite)
                  </span>
                  <ChevronRight
                    className={`w-4 h-4 ${
                      isDark ? "text-white/30" : "text-stone-400"
                    }`}
                  />
                </Link>
              </div>
            )}

            {status === "pending" && (
              <div className={`rounded-xl border p-4 ${cardBorder}`}>
                <p className="font-bold mb-1">Application under review</p>
                <p className={`text-sm ${subtleText}`}>
                  We'll let you know within 24-48 hours.
                </p>
              </div>
            )}

            {status === "approved" && (
              <div
                className={`rounded-xl border overflow-hidden ${cardBorder}`}
              >
                <button
                  onClick={() =>
                    setMode(mode === "seller" ? "buyer" : "seller")
                  }
                  aria-pressed={mode === "seller"}
                  aria-label={`Currently in ${mode} mode. Switch to ${mode === "seller" ? "buyer" : "seller"} mode.`}
                  className={`w-full flex items-center justify-between p-4 ${
                    isDark ? "hover:bg-white/5" : "hover:bg-stone-50"
                  }`}
                  data-testid="button-switch-mode"
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-10 h-10 rounded-full flex items-center justify-center ${
                        isDark
                          ? "bg-gradient-to-tr from-[#FF8855]/20 to-[#5BA3F5]/20"
                          : "bg-gradient-to-tr from-[#E6502E]/15 to-[#1B2A4A]/15"
                      }`}
                    >
                      <ArrowLeftRight
                        className={`w-5 h-5 ${
                          isDark ? "text-[#5BA3F5]" : "text-[#1B2A4A]"
                        }`}
                      />
                    </div>
                    <div className="text-left">
                      <p className="font-bold">
                        Switch to {mode === "seller" ? "Buyer" : "Seller"} mode
                      </p>
                      <p className={`text-xs ${subtleText}`}>
                        {mode === "seller"
                          ? "Browse, watch, and shop"
                          : "Manage listings, broadcast live"}
                      </p>
                    </div>
                  </div>
                  <ChevronRight
                    className={`w-4 h-4 ${
                      isDark ? "text-white/30" : "text-stone-400"
                    }`}
                  />
                </button>
                <Link
                  href="/seller/studio"
                  className={`flex items-center justify-between p-4 border-t ${
                    isDark
                      ? "border-white/10 hover:bg-white/5"
                      : "border-stone-200 hover:bg-stone-50"
                  }`}
                  data-testid="link-seller-studio"
                >
                  <div className="flex items-center gap-3">
                    <LayoutGrid
                      className={`w-5 h-5 ${
                        isDark ? "text-white/70" : "text-stone-500"
                      }`}
                    />
                    <span className="font-medium">Open Seller Studio</span>
                  </div>
                  <ChevronRight
                    className={`w-4 h-4 ${
                      isDark ? "text-white/30" : "text-stone-400"
                    }`}
                  />
                </Link>
                <Link
                  href="/seller/tiers"
                  className={`flex items-center justify-between p-4 border-t ${
                    isDark
                      ? "border-white/10 hover:bg-white/5"
                      : "border-stone-200 hover:bg-stone-50"
                  }`}
                  data-testid="link-tiers-approved"
                >
                  <div className="flex items-center gap-3">
                    <Store
                      className={`w-5 h-5 ${
                        isDark ? "text-white/70" : "text-stone-500"
                      }`}
                    />
                    <span className="font-medium">Tiers & perks</span>
                  </div>
                  <ChevronRight
                    className={`w-4 h-4 ${
                      isDark ? "text-white/30" : "text-stone-400"
                    }`}
                  />
                </Link>
              </div>
            )}
          </div>

          {/* Region */}
          <div>
            <h3
              className={`text-sm font-bold mb-3 uppercase tracking-wider ${
                isDark ? "text-white/40" : "text-stone-400"
              }`}
            >
              Region & Currency
            </h3>
            <div
              className={`rounded-xl border overflow-hidden ${cardBorder}`}
            >
              <div className="p-3">
                <label className="block text-sm font-bold mb-2">
                  Shopping Location
                </label>
                <div className="space-y-2">
                  {(Object.keys(COUNTRIES) as CountryCode[]).map((code) => {
                    const c = COUNTRIES[code];
                    const isSelected = country.code === code;
                    const isDisabled = c.status === "coming-soon";

                    return (
                      <button
                        key={code}
                        onClick={() => !isDisabled && setCountry(code)}
                        disabled={isDisabled}
                        className={`w-full flex items-center justify-between p-3 rounded-lg border text-left transition-colors ${
                          isSelected
                            ? isDark
                              ? "bg-[#5BA3F5]/10 border-[#5BA3F5]/30"
                              : "bg-[#1B2A4A]/10 border-[#1B2A4A]/30"
                            : isDisabled
                              ? isDark
                                ? "bg-black/20 border-white/5 opacity-50"
                                : "bg-stone-100 border-stone-200 opacity-50"
                              : isDark
                                ? "bg-black/40 border-white/10 hover:bg-white/5"
                                : "bg-white border-stone-300 hover:bg-stone-50"
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <span className="text-2xl leading-none">
                            {c.flag}
                          </span>
                          <div>
                            <p
                              className={`font-bold ${
                                isSelected
                                  ? isDark
                                    ? "text-[#5BA3F5]"
                                    : "text-[#1B2A4A]"
                                  : ""
                              }`}
                            >
                              {c.name}
                            </p>
                            <p
                              className={`text-xs ${
                                isDark ? "text-white/50" : "text-stone-500"
                              }`}
                            >
                              {c.currency.code} ({c.currency.symbol})
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center">
                          {isDisabled && (
                            <span
                              className={`text-[10px] font-bold px-2 py-1 rounded mr-2 ${
                                isDark
                                  ? "bg-white/10 text-white/50"
                                  : "bg-stone-200 text-stone-500"
                              }`}
                            >
                              Soon
                            </span>
                          )}
                          {isSelected && (
                            <div
                              className={`w-4 h-4 rounded-full flex items-center justify-center ${
                                isDark ? "bg-[#5BA3F5]" : "bg-[#1B2A4A]"
                              }`}
                            >
                              <div
                                className={`w-1.5 h-1.5 rounded-full ${
                                  isDark ? "bg-black" : "bg-white"
                                }`}
                              ></div>
                            </div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* Account */}
          <div>
            <h3
              className={`text-sm font-bold mb-3 uppercase tracking-wider ${
                isDark ? "text-white/40" : "text-stone-400"
              }`}
            >
              Account
            </h3>
            <div
              className={`rounded-xl border overflow-hidden ${cardBorder}`}
            >
              <Link
                href="/wishlist"
                className={`w-full flex items-center justify-between p-4 border-b ${
                  isDark
                    ? "border-white/10 hover:bg-white/5"
                    : "border-stone-200 hover:bg-stone-50"
                }`}
                data-testid="link-wishlist"
              >
                <div className="flex items-center gap-3">
                  <Heart
                    className={`w-5 h-5 ${
                      isDark ? "text-white/70" : "text-stone-500"
                    }`}
                  />
                  <span className="font-medium">Wishlist</span>
                </div>
                <ChevronRight
                  className={`w-4 h-4 ${
                    isDark ? "text-white/30" : "text-stone-400"
                  }`}
                />
              </Link>
              <Link
                href="/account/payment-methods"
                className={`w-full flex items-center justify-between p-4 border-b ${
                  isDark
                    ? "border-white/10 hover:bg-white/5"
                    : "border-stone-200 hover:bg-stone-50"
                }`}
                data-testid="link-payment-methods"
              >
                <div className="flex items-center gap-3">
                  <CreditCard
                    className={`w-5 h-5 ${
                      isDark ? "text-white/70" : "text-stone-500"
                    }`}
                  />
                  <span className="font-medium">Payment Methods</span>
                </div>
                <ChevronRight
                  className={`w-4 h-4 ${
                    isDark ? "text-white/30" : "text-stone-400"
                  }`}
                />
              </Link>
              <Link
                href="/account/addresses"
                className={`w-full flex items-center justify-between p-4 border-b ${
                  isDark
                    ? "border-white/10 hover:bg-white/5"
                    : "border-stone-200 hover:bg-stone-50"
                }`}
                data-testid="link-addresses"
              >
                <div className="flex items-center gap-3">
                  <MapPin
                    className={`w-5 h-5 ${
                      isDark ? "text-white/70" : "text-stone-500"
                    }`}
                  />
                  <span className="font-medium">Addresses</span>
                </div>
                <ChevronRight
                  className={`w-4 h-4 ${
                    isDark ? "text-white/30" : "text-stone-400"
                  }`}
                />
              </Link>
              <Link
                href="/account/settings"
                className={`w-full flex items-center justify-between p-4 ${
                  isDark ? "hover:bg-white/5" : "hover:bg-stone-50"
                }`}
                data-testid="link-settings"
              >
                <div className="flex items-center gap-3">
                  <Settings
                    className={`w-5 h-5 ${
                      isDark ? "text-white/70" : "text-stone-500"
                    }`}
                  />
                  <span className="font-medium">Settings</span>
                </div>
                <ChevronRight
                  className={`w-4 h-4 ${
                    isDark ? "text-white/30" : "text-stone-400"
                  }`}
                />
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
