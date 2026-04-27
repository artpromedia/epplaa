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
    darkBg: "bg-[#5BA3F5]/15",
    darkText: "text-[#5BA3F5]",
    lightBg: "bg-[#1B2A4A]/15",
    lightText: "text-[#1B2A4A]",
  },
  pro: {
    darkBg: "bg-[#FF8855]/15",
    darkText: "text-[#FF8855]",
    lightBg: "bg-[#E6502E]/15",
    lightText: "text-[#E6502E]",
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
