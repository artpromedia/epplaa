import { Crown, Sparkles, Zap, Check } from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useCountry } from "@/lib/country-context";
import { useSeller } from "@/lib/seller-context";
import { TIERS, TIER_ORDER, SellerTier } from "@/lib/seller-tiers";
import { formatPrice } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { TierBadge } from "@/components/tier-badge";

const ICONS = {
  sparkles: Sparkles,
  zap: Zap,
  crown: Crown,
};

export default function SellerTiers() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { country } = useCountry();
  const { tier: currentTier, status } = useSeller();

  const cardClass = isDark
    ? "bg-white/5 border-white/10"
    : "bg-white border-stone-400/35";
  const subtleText = isDark ? "text-white/50" : "text-stone-500";

  return (
    <div className="flex flex-col h-full w-full">
      <PageHeader
        title="Seller Tiers"
        backHref={status === "approved" ? "/seller/studio" : "/profile"}
      />
      <div className="px-4 pb-24 space-y-4">
        <p className={`text-sm ${subtleText}`}>
          Three tiers, three trust signals. You'll grow into them as you sell.
        </p>

        {TIER_ORDER.map((id: SellerTier) => {
          const def = TIERS[id];
          const Icon = ICONS[def.iconKey];
          const isCurrent = status === "approved" && currentTier === id;

          return (
            <div
              key={id}
              className={`rounded-2xl border p-5 ${cardClass} ${
                isCurrent
                  ? isDark
                    ? "ring-1 ring-[#5BA3F5]/40"
                    : "ring-1 ring-[#1B2A4A]/40"
                  : ""
              }`}
              data-testid={`tier-card-${id}`}
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <Icon
                    className={`w-5 h-5 ${
                      isDark ? "text-[#5BA3F5]" : "text-[#1B2A4A]"
                    }`}
                  />
                  <h3 className="text-lg font-bold">{def.label}</h3>
                </div>
                {isCurrent ? (
                  <TierBadge tier={id} size="md" />
                ) : (
                  <span className={`text-xs font-bold ${subtleText}`}>
                    {def.commissionPct}% commission
                  </span>
                )}
              </div>
              <p className={`text-sm mb-4 ${subtleText}`}>{def.tagline}</p>

              <div className="space-y-3">
                <div>
                  <p
                    className={`text-xs font-bold uppercase tracking-wider mb-2 ${
                      isDark ? "text-white/40" : "text-stone-400"
                    }`}
                  >
                    What you get
                  </p>
                  <ul className="space-y-1.5">
                    {def.perks.map((p) => (
                      <li
                        key={p}
                        className="flex items-start gap-2 text-sm"
                      >
                        <Check
                          className={`w-4 h-4 mt-0.5 shrink-0 ${
                            isDark ? "text-[#5BA3F5]" : "text-[#1B2A4A]"
                          }`}
                        />
                        <span>{p}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div
                  className={`grid grid-cols-2 gap-3 pt-2 border-t ${
                    isDark ? "border-white/10" : "border-stone-200"
                  }`}
                >
                  <Stat
                    isDark={isDark}
                    label="Commission"
                    value={`${def.commissionPct}%`}
                  />
                  <Stat
                    isDark={isDark}
                    label="Payouts"
                    value={def.payoutFrequency}
                  />
                  <Stat
                    isDark={isDark}
                    label="Monthly GMV cap"
                    value={
                      def.monthlyGMVCapMinor
                        ? formatPrice(def.monthlyGMVCapMinor, country)
                        : "Unlimited"
                    }
                  />
                  <Stat
                    isDark={isDark}
                    label="Live time / day"
                    value={
                      def.maxLiveHoursPerDay
                        ? `${def.maxLiveHoursPerDay}h`
                        : "Unlimited"
                    }
                  />
                </div>

                <div>
                  <p
                    className={`text-xs font-bold uppercase tracking-wider mt-2 mb-1 ${
                      isDark ? "text-white/40" : "text-stone-400"
                    }`}
                  >
                    Requirements
                  </p>
                  <ul className={`text-sm space-y-1 ${subtleText}`}>
                    {def.requirements.map((r) => (
                      <li key={r}>• {r}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Stat({
  isDark,
  label,
  value,
}: {
  isDark: boolean;
  label: string;
  value: string;
}) {
  return (
    <div>
      <p
        className={`text-[10px] uppercase tracking-wider font-bold ${
          isDark ? "text-white/40" : "text-stone-400"
        }`}
      >
        {label}
      </p>
      <p className="text-sm font-bold">{value}</p>
    </div>
  );
}
