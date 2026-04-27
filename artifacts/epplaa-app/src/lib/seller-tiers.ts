export type SellerTier = "starter" | "pro" | "elite";

export interface TierUpgradeCriteria {
  minLifetimeGMVMinor: number;
  minDaysAsSeller: number;
  minListings: number;
}

export interface TierDefinition {
  id: SellerTier;
  label: string;
  tagline: string;
  iconKey: "sparkles" | "zap" | "crown";
  commissionPct: number;
  payoutFrequency: string;
  monthlyGMVCapMinor: number | null;
  maxListings: number | null;
  maxLiveHoursPerDay: number | null;
  perks: string[];
  requirements: string[];
  upgradeTo: SellerTier | null;
  upgradeCriteria: TierUpgradeCriteria | null;
}

export const TIERS: Record<SellerTier, TierDefinition> = {
  starter: {
    id: "starter",
    label: "Starter",
    tagline: "Perfect for individuals testing the water.",
    iconKey: "sparkles",
    commissionPct: 5,
    payoutFrequency: "Weekly",
    monthlyGMVCapMinor: 50_000_000, // ₦500,000
    maxListings: 20,
    maxLiveHoursPerDay: 1,
    perks: [
      "Sell up to 20 active listings",
      "Broadcast 1 hour per day",
      "Weekly payouts to your Naira account",
      "Standard buyer-protection coverage",
    ],
    requirements: [
      "Verified BVN or NIN",
      "Government-issued photo ID",
      "Bank account in your name",
    ],
    upgradeTo: "pro",
    upgradeCriteria: {
      minLifetimeGMVMinor: 50_000_000, // ₦500,000 lifetime
      minDaysAsSeller: 7,
      minListings: 5,
    },
  },
  pro: {
    id: "pro",
    label: "Pro",
    tagline: "For small businesses scaling on Epplaa.",
    iconKey: "zap",
    commissionPct: 4,
    payoutFrequency: "Daily",
    monthlyGMVCapMinor: 1_000_000_000, // ₦10,000,000
    maxListings: 200,
    maxLiveHoursPerDay: 4,
    perks: [
      "Sell up to 200 active listings",
      "Broadcast up to 4 hours per day",
      "Daily payouts",
      "Priority chat support",
      "Lower 4% commission",
    ],
    requirements: [
      "Active Starter status with 5+ listings",
      "CAC business registration number",
      "Verified business bank account",
    ],
    upgradeTo: "elite",
    upgradeCriteria: {
      minLifetimeGMVMinor: 1_000_000_000, // ₦10M lifetime
      minDaysAsSeller: 30,
      minListings: 30,
    },
  },
  elite: {
    id: "elite",
    label: "Elite",
    tagline: "For verified brands and top creators.",
    iconKey: "crown",
    commissionPct: 3,
    payoutFrequency: "Instant",
    monthlyGMVCapMinor: null, // unlimited
    maxListings: null,
    maxLiveHoursPerDay: null,
    perks: [
      "Unlimited listings & live time",
      "Instant payouts to bank or card",
      "Dedicated account manager",
      "Verified brand badge on storefront",
      "Featured placement in Discovery",
      "Lowest 3% commission",
    ],
    requirements: [
      "Active Pro status with 30+ listings",
      "Trademark or brand documentation",
      "Compliance review by Epplaa team",
    ],
    upgradeTo: null,
    upgradeCriteria: null,
  },
};

export const TIER_ORDER: SellerTier[] = ["starter", "pro", "elite"];

export function tierIndex(tier: SellerTier): number {
  return TIER_ORDER.indexOf(tier);
}

export interface UpgradeProgress {
  eligible: boolean;
  criteria: {
    label: string;
    current: number;
    target: number;
    met: boolean;
  }[];
}

export function evaluateUpgrade(
  currentTier: SellerTier,
  stats: {
    lifetimeGMVMinor: number;
    daysAsSeller: number;
    listingCount: number;
  },
): UpgradeProgress | null {
  const def = TIERS[currentTier];
  if (!def.upgradeCriteria || !def.upgradeTo) return null;
  const c = def.upgradeCriteria;
  const criteria = [
    {
      label: "Lifetime GMV",
      current: stats.lifetimeGMVMinor,
      target: c.minLifetimeGMVMinor,
      met: stats.lifetimeGMVMinor >= c.minLifetimeGMVMinor,
    },
    {
      label: "Days as seller",
      current: stats.daysAsSeller,
      target: c.minDaysAsSeller,
      met: stats.daysAsSeller >= c.minDaysAsSeller,
    },
    {
      label: "Active listings",
      current: stats.listingCount,
      target: c.minListings,
      met: stats.listingCount >= c.minListings,
    },
  ];
  return {
    eligible: criteria.every((c) => c.met),
    criteria,
  };
}
