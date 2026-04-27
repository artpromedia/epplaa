import { Crown, Sparkles, Zap } from "lucide-react";
import { SellerTier, TIERS } from "@/lib/seller-tiers";
import { useTheme } from "@/lib/theme-context";

const ICONS = {
  sparkles: Sparkles,
  zap: Zap,
  crown: Crown,
};

const PALETTES: Record<
  SellerTier,
  { darkBg: string; darkText: string; lightBg: string; lightText: string }
> = {
  starter: {
    darkBg: "bg-[#00ffff]/15",
    darkText: "text-[#00ffff]",
    lightBg: "bg-[#00b3b3]/15",
    lightText: "text-[#00b3b3]",
  },
  pro: {
    darkBg: "bg-[#ff00ff]/15",
    darkText: "text-[#ff00ff]",
    lightBg: "bg-[#d900d9]/15",
    lightText: "text-[#d900d9]",
  },
  elite: {
    darkBg: "bg-amber-400/15",
    darkText: "text-amber-300",
    lightBg: "bg-amber-500/15",
    lightText: "text-amber-600",
  },
};

export function TierBadge({
  tier,
  size = "sm",
}: {
  tier: SellerTier;
  size?: "sm" | "md";
}) {
  const def = TIERS[tier];
  const Icon = ICONS[def.iconKey];
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const p = PALETTES[tier];
  const bg = isDark ? p.darkBg : p.lightBg;
  const text = isDark ? p.darkText : p.lightText;
  const padding = size === "md" ? "px-2.5 py-1 text-xs" : "px-2 py-0.5 text-[10px]";
  const iconSize = size === "md" ? "w-3.5 h-3.5" : "w-3 h-3";

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-bold uppercase tracking-wider ${bg} ${text} ${padding}`}
      data-testid={`tier-badge-${tier}`}
    >
      <Icon className={iconSize} />
      {def.label}
    </span>
  );
}
