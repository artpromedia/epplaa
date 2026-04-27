import { useState } from "react";
import { Link, useLocation } from "wouter";
import {
  Plus,
  Radio,
  Package,
  TrendingUp,
  ChevronRight,
  Sparkles,
  Receipt,
  Crown,
  Wallet,
} from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useCountry } from "@/lib/country-context";
import { useSeller } from "@/lib/seller-context";
import { TIERS, evaluateUpgrade } from "@/lib/seller-tiers";
import { formatPrice } from "@/lib/format";
import { ThemeToggle } from "@/components/theme-toggle";
import { TierBadge } from "@/components/tier-badge";
import { useToast } from "@/hooks/use-toast";

export default function SellerStudio() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { country } = useCountry();
  const {
    status,
    tier,
    application,
    stats,
    listings,
    upgradeTier,
    simulateSale,
  } = useSeller();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [registryNumber, setRegistryNumber] = useState(
    application?.registryNumber ?? "",
  );
  const [trademark, setTrademark] = useState(application?.trademarkRef ?? "");

  if (status !== "approved" || !stats || !application) {
    return <NotApprovedState isDark={isDark} />;
  }

  const cardClass = isDark
    ? "bg-white/5 border-white/10"
    : "bg-white border-stone-400/35";
  const subtleText = isDark ? "text-white/50" : "text-stone-500";

  const def = TIERS[tier];
  const daysAsSeller = Math.max(
    0,
    Math.floor((Date.now() - stats.joinedAt) / (1000 * 60 * 60 * 24)),
  );
  const activeListingCount = listings.filter((l) => l.status === "active").length;
  const upgrade = evaluateUpgrade(tier, {
    lifetimeGMVMinor: stats.lifetimeGMVMinor,
    daysAsSeller,
    listingCount: activeListingCount,
  });

  function performUpgrade() {
    if (!def.upgradeTo) return;
    if (def.upgradeTo === "pro" && !registryNumber.trim()) {
      toast({ title: `Add your ${country.businessRegistry.numberLabel}` });
      return;
    }
    if (def.upgradeTo === "elite" && !trademark.trim()) {
      toast({ title: "Add a trademark or brand reference" });
      return;
    }
    upgradeTier(def.upgradeTo, {
      registryNumber: registryNumber.trim() || undefined,
      trademarkRef: trademark.trim() || undefined,
    });
    toast({
      title: `Upgraded to ${TIERS[def.upgradeTo].label}!`,
      description: `Welcome to your new seller tier.`,
    });
    setShowUpgrade(false);
  }

  return (
    <div className="flex flex-col h-full w-full">
      <div
        className={`pt-12 pb-4 px-4 z-10 sticky top-0 ${
          isDark ? "bg-[#0F1525]" : "bg-[#fbeed3]"
        }`}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p
              className={`text-[10px] font-bold uppercase tracking-wider ${subtleText}`}
            >
              Seller Studio
            </p>
            <div className="flex items-center gap-2 min-w-0">
              <h1 className="text-xl font-bold truncate">
                {application.storeName}
              </h1>
              <TierBadge tier={tier} />
            </div>
            <p className={`text-xs ${subtleText}`}>@{application.storeHandle}</p>
          </div>
          <ThemeToggle />
        </div>
      </div>

      <div className="px-4 pb-24 space-y-6">
        <div className="grid grid-cols-2 gap-3">
          <StatCard
            isDark={isDark}
            icon={<TrendingUp className="w-4 h-4" />}
            label="This month GMV"
            value={formatPrice(stats.thisMonthGMVMinor, country)}
          />
          <StatCard
            isDark={isDark}
            icon={<Receipt className="w-4 h-4" />}
            label="Lifetime GMV"
            value={formatPrice(stats.lifetimeGMVMinor, country)}
          />
          <StatCard
            isDark={isDark}
            icon={<Package className="w-4 h-4" />}
            label="Pending orders"
            value={String(stats.ordersPending)}
          />
          <StatCard
            isDark={isDark}
            icon={<Radio className="w-4 h-4" />}
            label="Live sessions"
            value={String(stats.liveSessionsCount)}
          />
        </div>

        {upgrade ? (
          <div
            className={`rounded-xl border p-4 ${cardClass}`}
            data-testid="tier-upgrade-card"
          >
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <Crown
                  className={`w-4 h-4 ${
                    isDark ? "text-amber-300" : "text-amber-600"
                  }`}
                />
                <h3 className="font-bold">
                  Progress to {TIERS[def.upgradeTo!].label}
                </h3>
              </div>
              <Link
                href="/seller/tiers"
                className={`text-xs font-bold ${
                  isDark ? "text-[#5BA3F5]" : "text-[#1B2A4A]"
                }`}
              >
                Compare tiers
              </Link>
            </div>
            <p className={`text-sm mb-3 ${subtleText}`}>
              Hit all three to unlock {TIERS[def.upgradeTo!].label} tier.
            </p>
            <div className="space-y-2">
              {upgrade.criteria.map((c) => {
                const display =
                  c.label === "Lifetime GMV"
                    ? `${formatPrice(c.current, country)} / ${formatPrice(c.target, country)}`
                    : `${c.current} / ${c.target}`;
                const pct = Math.min(100, (c.current / c.target) * 100);
                return (
                  <div key={c.label}>
                    <div className="flex justify-between text-xs mb-1">
                      <span className={c.met ? "" : subtleText}>{c.label}</span>
                      <span className="font-bold">{display}</span>
                    </div>
                    <div
                      className={`h-1.5 rounded-full overflow-hidden ${
                        isDark ? "bg-white/10" : "bg-stone-200"
                      }`}
                    >
                      <div
                        className={`h-full transition-all ${
                          c.met
                            ? isDark
                              ? "bg-[#5BA3F5]"
                              : "bg-[#1B2A4A]"
                            : isDark
                              ? "bg-white/30"
                              : "bg-stone-400"
                        }`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            {upgrade.eligible && (
              <button
                onClick={() => setShowUpgrade(true)}
                className={`mt-4 w-full py-2.5 rounded-full font-bold ${
                  isDark
                    ? "bg-amber-300 text-black"
                    : "bg-amber-500 text-white"
                }`}
                data-testid="button-open-upgrade"
              >
                Apply for {TIERS[def.upgradeTo!].label} now
              </button>
            )}
          </div>
        ) : (
          <div className={`rounded-xl border p-4 ${cardClass}`}>
            <div className="flex items-center gap-2">
              <Crown
                className={`w-4 h-4 ${
                  isDark ? "text-amber-300" : "text-amber-600"
                }`}
              />
              <h3 className="font-bold">You're at the top tier</h3>
            </div>
            <p className={`text-sm mt-1 ${subtleText}`}>
              You're an Elite seller. Enjoy unlimited listings, instant payouts,
              and featured placement.
            </p>
          </div>
        )}

        <div>
          <h3
            className={`text-sm font-bold mb-3 uppercase tracking-wider ${
              isDark ? "text-white/40" : "text-stone-400"
            }`}
          >
            Quick actions
          </h3>
          <div className={`rounded-xl border overflow-hidden ${cardClass}`}>
            <ActionRow
              isDark={isDark}
              icon={<Plus className="w-5 h-5" />}
              label="Add a listing"
              hint={`${listings.length} of ${
                def.maxListings ?? "∞"
              } used`}
              onClick={() => navigate("/seller/listings")}
              testId="action-add-listing"
              border
            />
            <ActionRow
              isDark={isDark}
              icon={<Radio className="w-5 h-5" />}
              label="Start a live broadcast"
              hint={`Up to ${def.maxLiveHoursPerDay ?? "∞"}h/day`}
              onClick={() => navigate("/seller/go-live")}
              testId="action-go-live"
              border
            />
            <ActionRow
              isDark={isDark}
              icon={<Package className="w-5 h-5" />}
              label="Manage listings"
              hint=""
              onClick={() => navigate("/seller/listings")}
              testId="action-manage-listings"
              border
            />
            <ActionRow
              isDark={isDark}
              icon={<Receipt className="w-5 h-5" />}
              label="Order queue"
              hint="Pack, hand off, verify pickup"
              onClick={() => navigate("/seller/orders")}
              testId="action-orders"
              border
            />
            <ActionRow
              isDark={isDark}
              icon={<Radio className="w-5 h-5" />}
              label="Stream history"
              hint="Past broadcasts and viewer stats"
              onClick={() => navigate("/seller/streams")}
              testId="action-streams"
              border
            />
            <ActionRow
              isDark={isDark}
              icon={<Wallet className="w-5 h-5" />}
              label="Earnings & payouts"
              hint="View balance and request payouts"
              onClick={() => navigate("/seller/earnings")}
              testId="action-earnings"
              border
            />
            <ActionRow
              isDark={isDark}
              icon={<Sparkles className="w-5 h-5" />}
              label="View tiers & perks"
              hint=""
              onClick={() => navigate("/seller/tiers")}
              testId="action-view-tiers"
            />
          </div>
        </div>

        <div>
          <h3
            className={`text-sm font-bold mb-3 uppercase tracking-wider ${
              isDark ? "text-white/40" : "text-stone-400"
            }`}
          >
            Demo tools
          </h3>
          <div className={`rounded-xl border p-4 ${cardClass}`}>
            <p className={`text-sm mb-3 ${subtleText}`}>
              This is a preview build. Use these tools to simulate seller
              activity and try the tier-upgrade flow.
            </p>
            <button
              onClick={() => {
                const amountMinor = 10_000 * country.currency.minorPerMajor;
                simulateSale(amountMinor);
                toast({
                  title: "Sale recorded",
                  description: `Lifetime GMV +${formatPrice(amountMinor, country)}`,
                });
              }}
              className={`w-full py-2 rounded-full font-medium ${
                isDark
                  ? "bg-white/10 hover:bg-white/15"
                  : "bg-stone-200 hover:bg-stone-300"
              }`}
              data-testid="button-simulate-sale"
            >
              Simulate a {formatPrice(10_000 * country.currency.minorPerMajor, country)} sale
            </button>
          </div>
        </div>
      </div>

      {showUpgrade && def.upgradeTo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-6">
          <div
            className={`max-w-sm w-full rounded-2xl border p-6 ${
              isDark
                ? "bg-[#171C30] border-white/10 text-white"
                : "bg-white border-stone-300 text-stone-900"
            }`}
          >
            <div className="flex items-center gap-2 mb-2">
              <h4 className="text-lg font-bold">
                Upgrade to {TIERS[def.upgradeTo].label}
              </h4>
              <TierBadge tier={def.upgradeTo} size="md" />
            </div>
            <p className={`text-sm mb-4 ${subtleText}`}>
              Add the additional details below. In production, our team verifies
              within 24-48 hours. For this preview, the upgrade is instant.
            </p>
            {def.upgradeTo === "pro" && (
              <div className="space-y-2">
                <label className="block text-sm font-bold">
                  {country.businessRegistry.numberLabel}
                </label>
                <input
                  value={registryNumber}
                  onChange={(e) => setRegistryNumber(e.target.value)}
                  placeholder={country.businessRegistry.numberPlaceholder}
                  className={`w-full px-3 py-2 rounded-lg border text-sm outline-none ${
                    isDark
                      ? "bg-black/40 border-white/10 text-white"
                      : "bg-white border-stone-300 text-stone-900"
                  }`}
                  data-testid="input-upgrade-registry"
                />
                <p className={`text-xs ${subtleText}`}>
                  {country.businessRegistry.numberHelper} ·{" "}
                  {country.businessRegistry.fullName}
                </p>
              </div>
            )}
            {def.upgradeTo === "elite" && (
              <div className="space-y-3">
                <label className="block text-sm font-bold">
                  Trademark / brand reference
                </label>
                <input
                  value={trademark}
                  onChange={(e) => setTrademark(e.target.value)}
                  placeholder="TM number or brand portfolio URL"
                  className={`w-full px-3 py-2 rounded-lg border text-sm outline-none ${
                    isDark
                      ? "bg-black/40 border-white/10 text-white"
                      : "bg-white border-stone-300 text-stone-900"
                  }`}
                  data-testid="input-upgrade-trademark"
                />
              </div>
            )}
            <div className="flex gap-2 mt-5">
              <button
                onClick={() => setShowUpgrade(false)}
                className={`flex-1 py-2 rounded-full font-medium ${
                  isDark
                    ? "bg-white/10 hover:bg-white/15"
                    : "bg-stone-200 hover:bg-stone-300"
                }`}
                data-testid="button-cancel-upgrade"
              >
                Cancel
              </button>
              <button
                onClick={performUpgrade}
                className={`flex-1 py-2 rounded-full font-bold ${
                  isDark
                    ? "bg-amber-300 text-black"
                    : "bg-amber-500 text-white"
                }`}
                data-testid="button-confirm-upgrade"
              >
                Upgrade
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({
  isDark,
  icon,
  label,
  value,
}: {
  isDark: boolean;
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div
      className={`rounded-xl border p-3 ${
        isDark
          ? "bg-white/5 border-white/10"
          : "bg-white border-stone-400/35"
      }`}
    >
      <div
        className={`flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider ${
          isDark ? "text-white/40" : "text-stone-400"
        }`}
      >
        {icon}
        {label}
      </div>
      <p className="text-lg font-bold mt-1 truncate">{value}</p>
    </div>
  );
}

function ActionRow({
  isDark,
  icon,
  label,
  hint,
  onClick,
  testId,
  border,
}: {
  isDark: boolean;
  icon: React.ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
  testId?: string;
  border?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center justify-between p-4 ${
        border
          ? isDark
            ? "border-b border-white/10 hover:bg-white/5"
            : "border-b border-stone-200 hover:bg-stone-50"
          : isDark
            ? "hover:bg-white/5"
            : "hover:bg-stone-50"
      }`}
      data-testid={testId}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div
          className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center ${
            isDark ? "bg-white/10 text-white/80" : "bg-stone-100 text-stone-700"
          }`}
        >
          {icon}
        </div>
        <div className="min-w-0 text-left">
          <p className="font-medium truncate">{label}</p>
          {hint && (
            <p
              className={`text-xs truncate ${
                isDark ? "text-white/50" : "text-stone-500"
              }`}
            >
              {hint}
            </p>
          )}
        </div>
      </div>
      <ChevronRight
        className={`w-4 h-4 shrink-0 ${
          isDark ? "text-white/30" : "text-stone-400"
        }`}
      />
    </button>
  );
}

function NotApprovedState({ isDark }: { isDark: boolean }) {
  return (
    <div className="flex flex-col h-full w-full">
      <div
        className={`pt-12 pb-4 px-4 z-10 sticky top-0 ${
          isDark ? "bg-[#0F1525]" : "bg-[#fbeed3]"
        }`}
      >
        <h1 className="text-xl font-bold">Seller Studio</h1>
      </div>
      <div className="px-6 py-12 text-center space-y-4">
        <Sparkles
          className={`w-10 h-10 mx-auto ${
            isDark ? "text-[#5BA3F5]" : "text-[#1B2A4A]"
          }`}
        />
        <p className="font-bold text-lg">You're not a seller yet</p>
        <p
          className={`text-sm ${
            isDark ? "text-white/50" : "text-stone-500"
          }`}
        >
          Apply for a vetted seller account to access live broadcasting,
          listings, and payouts.
        </p>
        <Link
          href="/seller/apply"
          className={`inline-block mt-2 px-6 py-3 rounded-full font-bold ${
            isDark ? "bg-[#5BA3F5] text-black" : "bg-[#1B2A4A] text-white"
          }`}
          data-testid="button-apply-from-studio"
        >
          Become a Seller
        </Link>
      </div>
    </div>
  );
}
