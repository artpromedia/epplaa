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
  RotateCcw,
  ShieldCheck,
  Gift,
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
                <label
                  htmlFor="country-select"
                  className="block text-sm font-bold mb-2"
                >
                  Shopping Location
                </label>
                <div
                  className={`flex items-center gap-3 px-3 py-3 rounded-lg border ${
                    isDark
                      ? "bg-black/40 border-white/10"
                      : "bg-white border-stone-300"
                  }`}
                >
                  <span className="text-2xl leading-none shrink-0">
                    {country.flag}
                  </span>
                  <div className="relative flex-1 min-w-0">
                    <select
                      id="country-select"
                      value={country.code}
                      onChange={(e) =>
                        setCountry(e.target.value as CountryCode)
                      }
                      data-testid="select-country"
                      className={`w-full appearance-none bg-transparent font-bold text-base pr-8 outline-none cursor-pointer ${
                        isDark ? "text-white" : "text-stone-900"
                      }`}
                    >
                      {(Object.keys(COUNTRIES) as CountryCode[])
                        .filter((code) => COUNTRIES[code].status === "live")
                        .map((code) => {
                          const c = COUNTRIES[code];
                          return (
                            <option
                              key={code}
                              value={code}
                              className={
                                isDark
                                  ? "bg-[#0F1525] text-white"
                                  : "bg-white text-stone-900"
                              }
                            >
                              {c.flag} {c.name} · {c.currency.code} (
                              {c.currency.symbol})
                            </option>
                          );
                        })}
                    </select>
                    <ChevronRight
                      className={`absolute right-1 top-1/2 -translate-y-1/2 w-4 h-4 rotate-90 pointer-events-none ${
                        isDark ? "text-white/40" : "text-stone-400"
                      }`}
                    />
                  </div>
                </div>
                <p
                  className={`text-xs mt-2 ${
                    isDark ? "text-white/50" : "text-stone-500"
                  }`}
                >
                  Shopping live across {Object.keys(COUNTRIES).length} African
                  markets. Payments, fulfillment, and currency switch
                  automatically.
                </p>
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
                href="/wallet"
                className={`w-full flex items-center justify-between p-4 border-b ${
                  isDark
                    ? "border-white/10 hover:bg-white/5"
                    : "border-stone-200 hover:bg-stone-50"
                }`}
                data-testid="link-wallet"
              >
                <div className="flex items-center gap-3">
                  <Wallet
                    className={`w-5 h-5 ${
                      isDark ? "text-white/70" : "text-stone-500"
                    }`}
                  />
                  <span className="font-medium">Wallet</span>
                </div>
                <ChevronRight
                  className={`w-4 h-4 ${
                    isDark ? "text-white/30" : "text-stone-400"
                  }`}
                />
              </Link>
              <Link
                href="/returns"
                className={`w-full flex items-center justify-between p-4 border-b ${
                  isDark
                    ? "border-white/10 hover:bg-white/5"
                    : "border-stone-200 hover:bg-stone-50"
                }`}
                data-testid="link-returns"
              >
                <div className="flex items-center gap-3">
                  <RotateCcw
                    className={`w-5 h-5 ${
                      isDark ? "text-white/70" : "text-stone-500"
                    }`}
                  />
                  <span className="font-medium">Returns & refunds</span>
                </div>
                <ChevronRight
                  className={`w-4 h-4 ${
                    isDark ? "text-white/30" : "text-stone-400"
                  }`}
                />
              </Link>
              <Link
                href="/referrals"
                className={`w-full flex items-center justify-between p-4 border-b ${
                  isDark
                    ? "border-white/10 hover:bg-white/5"
                    : "border-stone-200 hover:bg-stone-50"
                }`}
                data-testid="link-referrals"
              >
                <div className="flex items-center gap-3">
                  <Gift
                    className={`w-5 h-5 ${
                      isDark ? "text-white/70" : "text-stone-500"
                    }`}
                  />
                  <span className="font-medium">Refer & earn</span>
                </div>
                <ChevronRight
                  className={`w-4 h-4 ${
                    isDark ? "text-white/30" : "text-stone-400"
                  }`}
                />
              </Link>
              <Link
                href="/safety"
                className={`w-full flex items-center justify-between p-4 border-b ${
                  isDark
                    ? "border-white/10 hover:bg-white/5"
                    : "border-stone-200 hover:bg-stone-50"
                }`}
                data-testid="link-safety"
              >
                <div className="flex items-center gap-3">
                  <ShieldCheck
                    className={`w-5 h-5 ${
                      isDark ? "text-white/70" : "text-stone-500"
                    }`}
                  />
                  <span className="font-medium">Trust & safety</span>
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
